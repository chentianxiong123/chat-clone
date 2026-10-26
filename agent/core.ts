import { config } from './config.js'
import { callLlm, type ChatMessage } from './llm.js'
import { searchRag } from './rag.js'
import { buildSystemPrompt, buildRagContextMessage } from './prompt.js'
import { applyStyle } from './profile.js'
import { recordGroupMsg, recordGroupReply } from './stats.js'
import {
  loadDialog, saveDialog, clearDialogDb, shouldCompress, compressDialog, countMessagesTokens, listSceneKeys,
} from './memory.js'

export const BATCH_N = config.batch.n
export const BATCH_T = config.batch.t

// ── 场景类型 ──
export type SceneType = 'group' | 'private'
export type SceneKey = `g:${number}` | `p:${number}`

export interface InjectedMessage {
  scene?: SceneType        // 默认 group
  groupId?: number         // 群聊时
  senderId: number         // 发送者 QQ
  senderNick: string
  text: string
  atBot?: boolean          // 是否 @了 bot（群聊）
}

export interface SceneView {
  scene: SceneType
  id: number
  key: SceneKey
  title: string            // 群号 / QQ号 展示
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
  privateBatchN: number
  privateBatchT: number
  respondMode: string
  scenes: Record<SceneKey, SceneView>
  // 兼容旧字段（前端过渡用）
  groups: Record<string, SceneView>
}

type Listener = (snap: AgentSnapshot) => void

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
const chance = (p: number): boolean => Math.random() < p

export const sceneKey = (t: SceneType, id: number): SceneKey => `${t === 'private' ? 'p' : 'g'}:${id}`

// 场景参数（攒批/冷却/概率）
interface SceneParam {
  batchN: number
  batchT: number
  cooldown: number
  replyProb: number
}

function paramFor(t: SceneType): SceneParam {
  if (t === 'private') {
    return {
      batchN: config.agent.privateBatchN,
      batchT: config.agent.privateBatchT,
      cooldown: config.humanlike.cooldown.privateMs,
      replyProb: config.humanlike.replyProb.private,
    }
  }
  return {
    batchN: config.batch.n,
    batchT: config.batch.t,
    cooldown: config.humanlike.cooldown.groupMs,
    replyProb: config.humanlike.replyProb.group,
  }
}

/** 分钟数 → "hh:mm" 解析 */
function toMin(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}

/** 半醒时段命中概率（0=不在半醒时段） */
function drowsyProb(): number {
  const list = config.humanlike.schedule.drowsy
  if (!list.length) return 0
  const now = new Date()
  const cur = now.getHours() * 60 + now.getMinutes()
  for (const d of list) {
    const s = toMin(d.start)
    const e = toMin(d.end)
    if (s <= e ? (cur >= s && cur <= e) : (cur >= s || cur <= e)) return d.prob
  }
  return 0
}

/** 判断当前是否处于夜间防打扰时段 */
function inQuietHours(): boolean {
  const q = config.humanlike.schedule.quietHours
  if (!q) return false
  const m = q.match(/(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/)
  if (!m) return false
  const [, sh, sm, eh, em] = m
  const now = new Date()
  const cur = now.getHours() * 60 + now.getMinutes()
  const s = Number(sh) * 60 + Number(sm)
  const e = Number(eh) * 60 + Number(em)
  if (s <= e) return cur >= s && cur <= e
  return cur >= s || cur <= e // 跨午夜
}

/** 场景是否在白名单/黑名单之外 */
function sceneAllowed(t: SceneType, id: number): boolean {
  const key = sceneKey(t, id)
  const bare = String(id)
  const allow = config.agent.allowScenes
  const deny = config.agent.denyScenes
  if (deny.some(x => x === key || x === bare)) return false
  if (allow.length && !allow.some(x => x === key || x === bare)) return false
  return true
}

/** 群里消息是否需要唤醒才回（@ 或叫名字） */
function needWake(t: SceneType, msg: InjectedMessage): boolean {
  if (t !== 'group') return false
  if (msg.atBot) return false
  // 关键词唤醒
  return !config.persona.wakeWords.some(w => msg.text.includes(w))
}

export class AgentCore {
  private pending = new Map<SceneKey, { lines: string[] }>()
  private dialogs = new Map<SceneKey, ChatMessage[]>()
  private timers = new Map<SceneKey, { handle: ReturnType<typeof setTimeout>; deadlineAt: number }>()
  private lastReplyAt = 0
  private lastActiveAt = 0
  /** 近期回复时间戳（刷屏抑制 / burst 用） */
  private replyHistory: number[] = []
  private listeners = new Set<Listener>()
  connected = false
  connError?: string

  /** 协议端接线：core 计算出回复后回调这里发消息 */
  onReply?: (scene: SceneType, id: number, text: string) => Promise<void>

  // ── 入站（NapCat 适配器 / WebUI 模拟注入共用）──────────────────────

  handleMessage(msg: InjectedMessage): void {
    const t: SceneType = msg.scene || 'group'
    const id = t === 'private' ? msg.senderId : (msg.groupId ?? msg.senderId)
    if (!sceneAllowed(t, id)) {
      console.log(`[Core] 场景 ${sceneKey(t, id)} 被名单拦截`)
      return
    }
    const text = msg.text.trim()
    if (!text) return

    const key = sceneKey(t, id)
    const who = msg.senderNick || '朋友'
    const line = `${who}: ${text}`

    let g = this.pending.get(key)
    if (!g) { g = { lines: [] }; this.pending.set(key, g) }
    g.lines.push(line)
    recordGroupMsg(id)
    this.lastActiveAt = Date.now()

    const p = paramFor(t)
    const woke = !needWake(t, msg)

    // 敷衍短消息忽略（真人经常"好的""嗯"当没看见）
    const ignore = config.humanlike.ignoreShort
    if (text.length < (ignore.minChars || 0) && chance(ignore.prob)) {
      console.log(`[Core] 短消息忽略（ignoreShort） ${key}: ${text.slice(0, 24)}`)
      this.emit()
      return
    }
    // 半醒时段：概率静默（看到但不想理）
    if (chance(drowsyProb())) {
      console.log(`[Core] 半醒时段概率静默 ${key}`)
      this.emit()
      return
    }

    // mention 模式：群聊非唤醒消息不进入攒批（私聊不受影响）
    if (t === 'group' && config.agent.respondMode === 'mention' && !woke) {
      console.log(`[Core] mention 模式跳过未唤醒 ${key}: ${text.slice(0, 24)}`)
      this.emit()
      return
    }

    // 防打扰：安静时段直接攒批不触发
    if (inQuietHours()) {
      console.log(`[Core] 夜间防打扰，攒批静默 ${key}`)
      this.emit()
      return
    }

    // 攒批参数（私聊通常是1条即回）
    const batchN = p.batchN
    const wokeN = t === 'group' && !woke ? `待唤醒` : (woke ? '' : '')
    console.log(`[Core] 攒批 ${key} (${g.lines.length}/${batchN}${wokeN}): ${text.slice(0, 24)}`)

    // 合适 @/唤醒词命中 → 立即触发（被抓到才应）
    if (t === 'group' && woke && g.lines.length >= 1) {
      void this.flush(key)
      return
    }
    if (g.lines.length >= batchN) {
      void this.flush(key)
      return
    }
    // 条件B：防抖重置，T 秒无新消息 → 触发
    const old = this.timers.get(key)
    if (old) clearTimeout(old.handle)
    this.timers.set(key, { handle: setTimeout(() => this.flush(key), p.batchT), deadlineAt: Date.now() + p.batchT })
    this.emit()
  }

  // ── 触发一轮回复 ──────────────────────────────────────────────────────

  async flush(key: SceneKey): Promise<void> {
    const old = this.timers.get(key)
    if (old) { clearTimeout(old.handle); this.timers.delete(key) }
    const g = this.pending.get(key)
    if (!g || g.lines.length === 0) return
    this.pending.delete(key)
    this.emit()

    const ctx = g.lines.join('\n')
    const t: SceneType = key.startsWith('p:') ? 'private' : 'group'
    const id = Number(key.slice(2))
    const p = paramFor(t)

    console.log(`[Core] 触发 ${key}: 共 ${g.lines.length} 条`)

    try {
      // 回复概率：不是每条都回（模拟真人）
      if (p.replyProb < 1 && Math.random() > p.replyProb) {
        console.log(`[Core] ${key} 概率沉默（replyProb=${p.replyProb}）`)
        this.emit()
        return
      }

      const ragContext = await searchRag(ctx)
      const systemPrompt = buildSystemPrompt(t)
      const ragMsg = buildRagContextMessage(ragContext)

      const hist = (await this.dialogFor(key)).slice(-config.agent.maxHistory)
      const userMsg: ChatMessage = { role: 'user', content: `${ctx}\n${config.persona.name}：`, time: Date.now() }
      const messages: ChatMessage[] = [
        { role: 'system', content: systemPrompt },
        ...hist,
        ...(ragMsg ? [ragMsg] : []),
        userMsg,
      ]

      // 触发后先"反应"：随机延迟再开始生成，模拟真人看到→想→才回（绝不秒回）
      const reactMs = config.humanlike.react.minMs +
        Math.random() * (config.humanlike.react.maxMs - config.humanlike.react.minMs)
      await sleep(Math.round(reactMs))

      const raw = await callLlm(messages)
      if (!raw) {
        console.log('[Core] LLM 无回复，跳过')
        this.emit()
        return
      }
      // 话术风格后处理（表情/语气词/错字/长度收敛/回敬）
      const reply = applyStyle(raw, ctx)
      console.log(`[Core] 回复 ${key}: ${reply}`)

      const assistantMsg: ChatMessage = { role: 'assistant', content: reply, time: Date.now() }
      const updated: ChatMessage[] = [...hist, userMsg, assistantMsg].slice(-config.agent.maxHistory)
      this.dialogs.set(key, updated)
      this.persist(key)

      // 发消息一定要慢：距上一条回复至少 cooldown；刷屏太密再叠加额外冷却
      const wait = Math.max(this.lastReplyAt + p.cooldown - Date.now(), this.burstWaitMs())
      if (wait > 0) await sleep(wait)
      await this.sendReplySegmented(t, id, reply)
      this.lastReplyAt = Date.now()
      this.noteReply()
      recordGroupReply(id)
      this.emit()
    } catch (err) {
      console.error('[Core] flush 错误:', err)
      this.emit()
    }
  }

  /** 主动说话：某场景沉寂超过 gap 后主动冒泡 */
  async proactiveTick(): Promise<void> {
    const gap = config.humanlike.schedule.proactiveGapMs
    if (!gap) return
    if (inQuietHours()) return
    if (this.lastActiveAt && Date.now() - this.lastActiveAt < gap) return
    if (this.lastReplyAt && Date.now() - this.lastReplyAt < gap) return
    const now = Date.now()
    for (const [key, d] of this.dialogs) {
      if (now - (d.at(-1)?.time ?? 0) < gap) continue
      const t: SceneType = key.startsWith('p:') ? 'private' : 'group'
      const id = Number(key.slice(2))
      if (this.pending.has(key)) continue
      if (!sceneAllowed(t, id)) continue
      const lastMsg = d.at(-1)?.content || ''
      const ctx = `（${t === 'group' ? '在群里' : '和' + config.persona.friendName + '单独聊'}）好久没动静了，${t === 'group' ? '找个话题冒个泡' : '主动发个消息'}`
      void this.flushProactive(key, ctx, lastMsg)
      this.lastActiveAt = now
      return
    }
  }

  private async flushProactive(key: SceneKey, ctx: string, lastMsg: string): Promise<void> {
    const t: SceneType = key.startsWith('p:') ? 'private' : 'group'
    const id = Number(key.slice(2))
    const p = paramFor(t)
    try {
      const ragContext = await searchRag(lastMsg)
      const systemPrompt = buildSystemPrompt(t)
      const ragMsg = buildRagContextMessage(ragContext)
      const hist = (await this.dialogFor(key)).slice(-config.agent.maxHistory)
      const userMsg: ChatMessage = { role: 'user', content: `${ctx}\n${config.persona.name}：`, time: Date.now() }
      const messages: ChatMessage[] = [{ role: 'system', content: systemPrompt }, ...hist, ...(ragMsg ? [ragMsg] : []), userMsg]
      // 主动说话同样要"想一下再开口"，不能到了间隔立刻干巴巴冒泡
      const reactMs = config.humanlike.react.minMs +
        Math.random() * (config.humanlike.react.maxMs - config.humanlike.react.minMs)
      await sleep(Math.round(reactMs))
      const raw = await callLlm(messages)
      if (!raw) return
      const reply = applyStyle(raw, lastMsg)
      const wait = Math.max(this.lastReplyAt + p.cooldown - Date.now(), this.burstWaitMs())
      if (wait > 0) await sleep(wait)
      await this.sendReplySegmented(t, id, reply)
      this.lastReplyAt = Date.now()
      this.noteReply()
      const assistantMsg: ChatMessage = { role: 'assistant', content: reply, time: Date.now() }
      const updated: ChatMessage[] = [...(await this.dialogFor(key)), userMsg, assistantMsg].slice(-config.agent.maxHistory)
      this.dialogs.set(key, updated)
      this.persist(key)
      recordGroupReply(id)
      console.log(`[Core] 主动说话 ${key}: ${reply}`)
      this.emit()
    } catch (err) {
      console.error('[Core] 主动说话错误:', err)
    }
  }

  /** 读场景对话：优先内存，内存无则从持久化加载（含摘要历史） */
  private async dialogFor(key: SceneKey): Promise<ChatMessage[]> {
    if (this.dialogs.has(key)) return this.dialogs.get(key)!
    if (!config.agent.memoryPersist) return []
    const { dialog, summary } = loadDialog(key)
    // 摘要历史以"user 摘要 + assistant 收到"注入（AstrBot 方式）
    let loaded = dialog
    if (summary && dialog.length && dialog[0]?.role !== 'user') {
      loaded = [
        { role: 'user', content: `我们之前的对话摘要：${summary}`, time: Date.now() },
        { role: 'assistant', content: '（收到，继续聊）', time: Date.now() },
        ...dialog,
      ]
    }
    this.dialogs.set(key, loaded)
    return loaded
  }

  /** 持久化 + 触发 LLM 摘要压缩（超阈值时） */
  private async persist(key: SceneKey): Promise<void> {
    if (!config.agent.memoryPersist) return
    const dialog = this.dialogs.get(key)
    if (!dialog) return
    const { summary } = loadDialog(key)
    const maxTokens = config.agent.memoryMaxTokens
    if (maxTokens > 0 && shouldCompress(dialog, maxTokens, config.agent.memoryCompressThreshold)) {
      console.log(`[Memory] ${key} 上下文超限，触发 LLM 摘要压缩 (${countMessagesTokens(dialog)} tok)`)
      const result = await compressDialog(
        dialog,
        summary,
        maxTokens,
        config.agent.memoryKeepRecentRatio,
      )
      this.dialogs.set(key, result.dialog)
      saveDialog(key, result.dialog, result.summary)
      console.log(`[Memory] ${key} 压缩完成，保留 ${result.dialog.length} 条`)
      return
    }
    saveDialog(key, dialog, summary)
  }

  /** 回车分割发送：回复按换行拆成多条，逐条带随机间隔发出（模拟真人打字） */
  private async sendReplySegmented(t: SceneType, id: number, reply: string): Promise<void> {
    const ty = config.humanlike.typing
    // 即使没有出站通道（如模拟注入）也打印分段，便于控制台观察节奏
    const logSeg = (i: number, seg: string): void => {
      console.log(`[Core] 分段 ${t}:${id} ${i}: ${seg.slice(0, 40)}`)
    }
    if (!ty.onNewline) {
      logSeg(0, reply)
      if (this.onReply) await this.onReply(t, id, reply)
      return
    }
    // 拆条 + 限制最多拆几条（超出部分合并到末尾，避免狂刷几十条）
    let segments = reply.split('\n').map(s => s.trimEnd())
    if (ty.maxSegments > 0 && segments.length > ty.maxSegments) {
      const head = segments.slice(0, ty.maxSegments - 1)
      const tail = segments.slice(ty.maxSegments - 1).filter(s => s.trim() !== '')
      segments = [...head, tail.join('\n')]
    }
    let i = 0
    for (const seg of segments) {
      const isBlank = seg.trim() === ''
      if (isBlank && !ty.keepBlank) continue
      i++
      // 每条间隔 = 该条长度对应的"打字时间"（按随机打字速度）+ 随机间隙
      const cps = ty.charsPerSec.min + Math.random() * (ty.charsPerSec.max - ty.charsPerSec.min)
      const typingMs = isBlank ? 0 : Math.round((seg.length / Math.max(cps, 0.5)) * 1000)
      const gap = typingMs + ty.segGap.minMs +
        Math.random() * (ty.segGap.maxMs - ty.segGap.minMs)
      // 第一条也要短暂迟疑（想好开始打），之后按打字节奏
      if (i === 1) await sleep(ty.firstDelayMs)
      else if (gap > 0) await sleep(Math.round(gap))
      if (this.onReply) {
        if (isBlank) {
          // 空行也发（作为停顿感）；某些平台不支持空消息则跳过
          try { await this.onReply(t, id, seg) } catch { /* ignore */ }
        } else {
          await this.onReply(t, id, seg)
        }
      }
      logSeg(i, seg)
    }
  }

  /** 记录一次回复时间戳（刷屏抑制窗口） */
  private noteReply(): void {
    const now = Date.now()
    this.replyHistory = this.replyHistory.filter(t => now - t < config.humanlike.burst.windowMs)
    this.replyHistory.push(now)
  }

  /** 刷屏抑制：窗口内回复数达上限 → 额外冷却 */
  private burstWaitMs(): number {
    const b = config.humanlike.burst
    const now = Date.now()
    this.replyHistory = this.replyHistory.filter(t => now - t < b.windowMs)
    return this.replyHistory.length >= b.maxReplies ? b.extraCooldownMs : 0
  }

  // ── 对外状态（WebUI）────────────────────────────────────────────────

  getSnapshot(): AgentSnapshot {
    const now = Date.now()
    const scenes: Record<SceneKey, SceneView> = {}
    const allKeys = new Set<SceneKey>([
      ...this.dialogs.keys(),
      ...this.pending.keys(),
      ...(config.agent.memoryPersist ? listSceneKeys() : []) as SceneKey[],
    ])
    for (const key of allKeys) {
      const t: SceneType = key.startsWith('p:') ? 'private' : 'group'
      const id = Number(key.slice(2))
      const mem = config.agent.memoryPersist ? loadDialog(key) : { dialog: [], summary: '' }
      const memDialog = mem.summary && !mem.dialog.some(m => m.role === 'user' && m.content.startsWith('我们之前的对话摘要'))
        ? [
            { role: 'user' as const, content: `我们之前的对话摘要：${mem.summary}`, time: Date.now() },
            { role: 'assistant' as const, content: '（收到，继续聊）', time: Date.now() },
            ...mem.dialog,
          ]
        : mem.dialog
      scenes[key] = {
        scene: t,
        id,
        key,
        title: t === 'private' ? `私聊 ${id}` : `群 ${id}`,
        pending: this.pending.get(key)?.lines.slice(-10) ?? [],
        dialog: (this.dialogs.get(key) ?? memDialog).slice(-config.agent.maxHistory),
        timerActive: this.timers.has(key),
        timerDeadlineAt: this.timers.get(key)?.deadlineAt ?? null,
        lastReplyAt: this.lastReplyAt,
        sentMessages: 0,
      }
    }
    return {
      connected: this.connected,
      connError: this.connError,
      selfName: config.persona.name,
      lastReplyAt: this.lastReplyAt,
      cooldownLeftMs: Math.max(0, this.lastReplyAt + config.humanlike.cooldown.groupMs - now),
      batchN: BATCH_N,
      batchT: BATCH_T,
      privateBatchN: config.agent.privateBatchN,
      privateBatchT: config.agent.privateBatchT,
      respondMode: config.agent.respondMode,
      scenes,
      groups: scenes,
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

  /** 清空某个场景 / 全部会话记忆（key 如 "g:10000" / "p:12345"） */
  clearDialog(key?: SceneKey): void {
    if (key != null) {
      this.dialogs.delete(key)
      this.pending.delete(key)
      const t = this.timers.get(key)
      if (t) { clearTimeout(t.handle); this.timers.delete(key) }
      if (config.agent.memoryPersist) clearDialogDb(key)
      console.log(`[Core] 清空场景 ${key} 的会话记忆`)
    } else {
      const keys = [...this.dialogs.keys()]
      this.dialogs.clear()
      this.pending.clear()
      for (const t of this.timers.values()) clearTimeout(t.handle)
      this.timers.clear()
      if (config.agent.memoryPersist) {
        for (const k of keys) clearDialogDb(k)
      }
      console.log('[Core] 清空全部会话记忆')
    }
    this.emit()
  }

  private emit(): void {
    const snap = this.getSnapshot()
    for (const fn of this.listeners) fn(snap)
  }
}
