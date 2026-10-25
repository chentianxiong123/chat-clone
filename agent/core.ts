import { config } from './config.js'
import { callLlm, type ChatMessage } from './llm.js'
import { searchRag } from './rag.js'
import { buildSystemPrompt } from './prompt.js'
import { recordGroupMsg, recordGroupReply } from './stats.js'

export const BATCH_N = config.batch.n
export const BATCH_T = config.batch.t

export interface InjectedMessage {
  groupId: number
  senderId: number
  senderNick: string
  text: string
}

export interface GroupView {
  groupId: number
  pending: string[]
  dialog: ChatMessage[]
  timerActive: boolean
  timerDeadlineAt: number | null
  lastReplyAt: number
  sentMessages: number
  lastSentReply?: string
}

export interface AgentSnapshot {
  connected: boolean
  connError?: string
  selfName: string
  lastReplyAt: number
  cooldownLeftMs: number
  batchN: number
  batchT: number
  respondMode: string
  groups: Record<string, GroupView>
}

type Listener = (snap: AgentSnapshot) => void

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

export class AgentCore {
  private pending = new Map<number, { lines: string[] }>()
  private dialogs = new Map<number, ChatMessage[]>()
  private timers = new Map<number, { handle: ReturnType<typeof setTimeout>; deadlineAt: number }>()
  private lastReplyAt = 0
  private listeners = new Set<Listener>()
  connected = false
  connError?: string

  /** 协议端接线：core 计算出回复后回调这里发消息 */
  onReply?: (groupId: number, text: string) => Promise<void>

  // ── 入站（NapCat 适配器 / WebUI 模拟注入共用）──────────────────────

  handleMessage(msg: InjectedMessage): void {
    if (config.agent.respondMode === 'mention') {
      // mention 模式：只处理带 @bot 的消息（由适配层过滤，这里只做攒批）
      // 注：实际 @ 过滤应在 NapCat 适配器层处理
    }

    const text = msg.text.trim()
    if (!text) return

    const gid = msg.groupId
    const who = msg.senderNick || '朋友'
    const line = `${who}: ${text}`

    let g = this.pending.get(gid)
    if (!g) { g = { lines: [] }; this.pending.set(gid, g) }
    g.lines.push(line)
    recordGroupMsg(gid)
    console.log(`[Core] 攒批 g${gid} (${g.lines.length}/${BATCH_N}): ${text.slice(0, 24)}`)

    // 条件A：攒够 N 条 → 立即触发
    if (g.lines.length >= BATCH_N) {
      void this.flush(gid)
      return
    }
    // 条件B：防抖重置，T 秒无新消息 → 触发
    const old = this.timers.get(gid)
    if (old) clearTimeout(old.handle)
    this.timers.set(gid, { handle: setTimeout(() => this.flush(gid), BATCH_T), deadlineAt: Date.now() + BATCH_T })
    this.emit()
  }

  // ── 触发一轮回复 ──────────────────────────────────────────────────────

  async flush(gid: number): Promise<void> {
    const old = this.timers.get(gid)
    if (old) { clearTimeout(old.handle); this.timers.delete(gid) }
    const g = this.pending.get(gid)
    if (!g || g.lines.length === 0) return
    this.pending.delete(gid)
    this.emit()

    const ctx = g.lines.join('\n')
    console.log(`[Core] 触发 g${gid}: 共 ${g.lines.length} 条`)

    try {
      const ragContext = await searchRag(ctx)
      const systemPrompt = buildSystemPrompt(ragContext)

      const hist = (this.dialogs.get(gid) ?? []).slice(-config.agent.maxHistory)
      const userMsg: ChatMessage = { role: 'user', content: `${ctx}\n${config.persona.name}：`, time: Date.now() }
      const messages: ChatMessage[] = [
        { role: 'system', content: systemPrompt },
        ...hist,
        userMsg,
      ]

      const reply = await callLlm(messages)
      if (!reply) {
        console.log('[Core] LLM 无回复，跳过')
        this.emit()
        return
      }
      console.log(`[Core] 回复 g${gid}: ${reply}`)

      const assistantMsg: ChatMessage = { role: 'assistant', content: reply, time: Date.now() }
      const updated: ChatMessage[] = [...hist, userMsg, assistantMsg].slice(-config.agent.maxHistory)
      this.dialogs.set(gid, updated)

      // 发消息一定要慢：距上一条回复至少 REPLY_COOLDOWN
      const wait = this.lastReplyAt + config.agent.replyCooldown - Date.now()
      if (wait > 0) await sleep(wait)
      if (this.onReply) await this.onReply(gid, reply)
      this.lastReplyAt = Date.now()
      recordGroupReply(gid)
      this.emit()
    } catch (err) {
      console.error('[Core] flush 错误:', err)
      this.emit()
    }
  }

  // ── 对外状态（WebUI）────────────────────────────────────────────────

  getSnapshot(): AgentSnapshot {
    const now = Date.now()
    const groups: Record<string, GroupView> = {}
    for (const [gid, dialog] of this.dialogs) {
      groups[String(gid)] = {
        groupId: gid,
        pending: this.pending.get(gid)?.lines.slice(-10) ?? [],
        dialog: dialog.slice(-config.agent.maxHistory),
        timerActive: this.timers.has(gid),
        timerDeadlineAt: this.timers.get(gid)?.deadlineAt ?? null,
        lastReplyAt: this.lastReplyAt,
        sentMessages: 0,
      }
    }
    for (const [gid, g] of this.pending) {
      const v = groups[String(gid)]
      if (!v) {
        groups[String(gid)] = {
          groupId: gid,
          pending: g.lines.slice(-10),
          dialog: [],
          timerActive: this.timers.has(gid),
          timerDeadlineAt: this.timers.get(gid)?.deadlineAt ?? null,
          lastReplyAt: this.lastReplyAt,
          sentMessages: 0,
        }
      }
    }
    return {
      connected: this.connected,
      connError: this.connError,
      selfName: config.persona.name,
      lastReplyAt: this.lastReplyAt,
      cooldownLeftMs: Math.max(0, this.lastReplyAt + config.agent.replyCooldown - now),
      batchN: BATCH_N,
      batchT: BATCH_T,
      respondMode: config.agent.respondMode,
      groups,
    }
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  setConnected(v: boolean, err?: string): void {
    this.connected = v
    this.connError = err
    this.emit()
  }

  /** 清空某个群 / 全部群的会话记忆 */
  clearDialog(gid?: number): void {
    if (gid != null) {
      this.dialogs.delete(gid)
      this.pending.delete(gid)
      const t = this.timers.get(gid)
      if (t) { clearTimeout(t.handle); this.timers.delete(gid) }
      console.log(`[Core] 清空群 ${gid} 的会话记忆`)
    } else {
      this.dialogs.clear()
      this.pending.clear()
      for (const t of this.timers.values()) clearTimeout(t.handle)
      this.timers.clear()
      console.log('[Core] 清空全部会话记忆')
    }
    this.emit()
  }

  private emit(): void {
    const snap = this.getSnapshot()
    for (const fn of this.listeners) fn(snap)
  }
}