import WebSocket from 'ws'
import type { BotTransport, GroupMsg, PrivateMsg } from './transport.js'

export interface MilkyOptions {
  host: string
  port: number
  token: string
}

interface MilkyEvent {
  event_type?: string
  time?: number
  self_id?: number
  data?: {
    message_scene?: 'group' | 'friend'
    peer_id?: number
    sender_id?: number
    segments?: Array<{ type?: string; data?: { text?: string; target?: number } }>
    group_member?: { nickname?: string; card?: string }
  }
}

/**
 * Milky 协议端：WS /event 收事件（message_receive），HTTP POST 调 API（send_group_message / send_private_message）。
 * 消息段格式与 OneBot 11 一致：{type:'text', data:{text}}。
 */
export class MilkyTransport implements BotTransport {
  private groupCb: ((e: GroupMsg) => void) | null = null
  private privateCb: ((e: PrivateMsg) => void) | null = null
  private statusCb: ((c: boolean) => void) | null = null
  private ws: WebSocket | null = null

  constructor(private readonly opt: MilkyOptions) {}

  private get httpBase(): string {
    // Milky 的 HTTP API 统一前缀 /api（如 /api/send_group_message、/api/get_group_list）
    return `http://${this.opt.host}:${this.opt.port}/api`
  }

  private get wsUrl(): string {
    const base = `ws://${this.opt.host}:${this.opt.port}/event`
    return this.opt.token ? `${base}?access_token=${encodeURIComponent(this.opt.token)}` : base
  }

  private stopped = false
  private everConnected = false
  private retryTimer: NodeJS.Timeout | null = null

  /**
   * 单次连接。首次失败（milky 3000 登录成功前未监听）不重试——等 .ks 登录事件调 reconnect()；
   * 曾连上后断开（掉线）才重连（WS 断线重连是事件驱动，非状态轮询）。
   */
  private connectOnce(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl)
      this.ws = ws
      ws.on('open', () => { this.everConnected = true; this.statusCb?.(true); resolve() })
      ws.on('error', err => { this.statusCb?.(false); if (this.everConnected) this.scheduleRetry(); reject(err) })
      ws.on('close', () => { this.statusCb?.(false); if (this.everConnected) this.scheduleRetry() })
      ws.on('message', raw => this.onMessage(raw.toString()))
    })
  }

  private scheduleRetry(): void {
    if (this.stopped) return
    if (this.retryTimer) return
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      if (!this.stopped) void this.connectOnce().catch(() => { /* error 已调度 */ })
    }, 3000)
  }

  /** 登录成功（.ks 事件）→ milky 3000 已起，主动连上（事件驱动） */
  reconnect(): void {
    this.ws?.close()
    void this.connectOnce().catch(() => {
      // 健壮性：登录成功瞬间 3000 可能未监听 → 1s 后单次重试（事件驱动，非轮询；仍失败等下次事件）
      if (this.stopped) return
      setTimeout(() => { if (!this.stopped) void this.connectOnce().catch(() => { /* error 已调度 */ }) }, 1000)
    })
  }

  stop(): void {
    this.stopped = true
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.ws?.close()
  }

  async connect(): Promise<void> {
    await this.connectOnce()
  }

  private onMessage(raw: string): void {
    let evt: MilkyEvent
    try {
      evt = JSON.parse(raw) as MilkyEvent
    } catch {
      return
    }
    if (evt.event_type !== 'message_receive') return
    const d = evt.data
    if (!d) return
    // bot 自己发的消息会被 Milky 推回，必须过滤（否则当朋友消息触发 → 自回复死循环）
    if (d.sender_id != null && d.sender_id === evt.self_id) return
    const text = (d.segments ?? [])
      .filter(s => s?.type === 'text')
      .map(s => s?.data?.text ?? '')
      .join('')
      .trim()
    if (!text) return
    const nick = d.group_member?.nickname || d.group_member?.card || '朋友'
    if (d.message_scene === 'group') {
      this.groupCb?.({
        groupId: d.peer_id ?? 0,
        senderId: d.sender_id ?? 0,
        senderNick: nick,
        text,
        atBot: (d.segments ?? []).some(s => s?.type === 'mention' || s?.type === 'mention_all'),
      })
    } else if (d.message_scene === 'friend') {
      this.privateCb?.({ senderId: d.sender_id ?? 0, senderNick: nick, text })
    }
  }

  async sendGroup(groupId: number, text: string): Promise<void> {
    await this.post('/send_group_message', { group_id: groupId, message: [{ type: 'text', data: { text } }] })
  }

  async sendPrivate(userId: number, text: string): Promise<void> {
    await this.post('/send_private_message', { user_id: userId, message: [{ type: 'text', data: { text } }] })
  }

  private async post(path: string, body: unknown): Promise<void> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (this.opt.token) headers['Authorization'] = `Bearer ${this.opt.token}`
    const res = await fetch(`${this.httpBase}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })
    const raw = await res.text()
    if (!res.ok) throw new Error(`Milky ${path} HTTP ${res.status}: ${raw}`)
    // Milky 业务失败也是 HTTP 200，靠 body 的 retcode != 0 区分（成功 retcode=0）
    let retcode = 0
    let msg = ''
    try {
      const j = JSON.parse(raw) as { retcode?: number; message?: string }
      retcode = j.retcode ?? 0
      msg = j.message ?? ''
    } catch { /* 空/非 JSON 响应 */ }
    if (retcode !== 0) throw new Error(`Milky ${path} retcode ${retcode}${msg ? ': ' + msg : ''}`)
  }

  onGroup(cb: (e: GroupMsg) => void): void {
    this.groupCb = cb
  }

  onPrivate(cb: (e: PrivateMsg) => void): void {
    this.privateCb = cb
  }

  onStatus(cb: (c: boolean) => void): void {
    this.statusCb = cb
  }
}
