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

  async connect(): Promise<void> {
    const ws = new WebSocket(this.wsUrl)
    this.ws = ws
    ws.on('open', () => this.statusCb?.(true))
    ws.on('close', () => this.statusCb?.(false))
    ws.on('error', () => this.statusCb?.(false))
    ws.on('message', raw => this.onMessage(raw.toString()))
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve())
      ws.once('error', err => reject(err))
    })
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
    if (!res.ok) throw new Error(`Milky ${path} HTTP ${res.status}: ${await res.text()}`)
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
