import { config } from './config.js'
import { callLlm, type ChatMessage } from './llm.js'
import { searchRag } from './rag.js'
import { buildSystemPrompt, buildRagContextMessage } from './prompt.js'
import { applyStyle, sampleReactMs, splitLongSegment, stateReplyProb, type StyleBias } from './profile.js'
import { recordGroupMsg, recordGroupReply } from './stats.js'
import {
  loadDialog, saveDialog, clearDialogDb, shouldCompress, compressDialog, countMessagesTokens, listSceneKeys,
} from './memory.js'
import {
  loadState, saveState, resetState, onMessage, onReply, decayState, computeModifiers,
  buildStateContextMessage, stateView, type RecentState, type RecentStateView, type StateModifiers,
} from './state.js'

export const BATCH_N = `${config.batch.nMin}~${config.batch.nMax}`
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
  recentState: RecentStateView
  scenes: Record<SceneKey, SceneView>
  // 兼容旧字段（前端过渡用）
  groups: Record<string, SceneView>
}

type Listener = (snap: AgentSnapshot) => void

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
const chance = (p: number): boolean => Math.random() < p
const clamp01 = (x: number): number => Math.min(1, Math.max(0, x))
/** 给一个基准时长加上 ±ratio 的随机抖动，破坏固定节奏 */
const jitter = (base: number, ratio: number): number => Math.round(base * (1 + (Math.random() * 2 - 1) * ratio))

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
    batchN: randInt(config.batch.nMin, config.batch.nMax),
    batchT: config.batch.t,
    cooldown: config.humanlike.cooldown.groupMs,
    replyProb: config.humanlike.replyProb.group,
  }
}

/** 返回 [min,max] 闭区间内的随机整数 */
function randInt(min: number, max: number): number {
  if (max <= min) return min
  return min + Math.floor(Math.random() * (max - min + 1))
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
  private pending = new Map<SceneKey, { lines: string[]; woke?: boolean; atBot?: boolean; lastNick?: string; triggerNick?: string }>()
  private dialogs = new Map<SceneKey, ChatMessage[]>()
  private timers = new Map<SceneKey, { handle: ReturnType<typeof setTimeout>; deadlineAt: number }>()
  private lastReplyAt = 0
  private lastActiveAt = 0
  /** 每个场景最后一次本人发言时间（对话状态用：热聊/冷场） */
  private lastSelfAt = new Map<SceneKey, number>()
  /** 近期回复时间戳（刷屏抑制 / burst 用） */
  private replyHistory: number[] = []
  /** 近期状态（全局：精力/心情/耐心/社交/烦躁/兴趣…） */
  private recentState: RecentState
  private stateKey = 'global'
  private lastStateSaveAt = 0
  private listeners = new Set<Listener>()
  /** 每个场景的回复串行锁：保证同时只有一条回复在"想+发"，分段间隔不被并发打乱 */
  private flushChain = new Map<SceneKey, Promise<void>>()
  /** 回复轮次锁：某场景正在"生成+逐条发送"期间锁住，不再触发新回复；整轮发完才解锁重判 */
  private replying = new Set<SceneKey>()
  connected = false
  connError?: string

  constructor() {
    this.recentState = loadState(this.stateKey)
  }

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
    g.lastNick = who
    if (msg.atBot) g.triggerNick = who
    recordGroupMsg(id)
    this.lastActiveAt = Date.now()

    const p = paramFor(t)
    const woke = !needWake(t, msg)
    g.woke = g.woke || (t === 'group' && woke)

    // 近期状态：先更新（忽略/半醒的消息也算看到了），影响后续概率与语气
    this.recentState = onMessage(this.recentState, text, Date.now(), { atBot: msg.atBot, woke })
    this.persistState()

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

    const replying = this.replying.has(key)
    // 回复轮次中：不立即触发新回复，只重置防抖 timer（新消息并入下一轮；回复完成后 timer 到期再判）
    if (replying) {
      const old = this.timers.get(key)
      if (old) clearTimeout(old.handle)
      this.timers.set(key, { handle: setTimeout(() => this.enqueueFlush(key), jitter(p.batchT, config.humanlike.cooldown.jitter)), deadlineAt: Date.now() + p.batchT })
      this.emit()
      return
    }
    // 合适 @/唤醒词命中 → 立即触发（被抓到才应）
    if (t === 'group' && woke && g.lines.length >= 1) {
      void this.enqueueFlush(key)
      return
    }
    if (g.lines.length >= batchN) {
      void this.enqueueFlush(key)
      return
    }
    // 条件B：防抖重置，T 秒无新消息 → 触发（T 带随机抖动，避免固定超时特征）
    const old = this.timers.get(key)
    if (old) clearTimeout(old.handle)
    this.timers.set(key, { handle: setTimeout(() => this.enqueueFlush(key), jitter(p.batchT, config.humanlike.cooldown.jitter)), deadlineAt: Date.now() + p.batchT })
    this.emit()
  }

  /** 综合对话状态 / 分时段 / 连发长度 / 唤醒 计算本轮回复概率 */
  private effectiveReplyProb(key: SceneKey, t: SceneType, batchSize: number, woke: boolean): number {
    const rp = config.humanlike.replyProb
    const base = t === 'private' ? rp.private : rp.group
    let p = base
    const st = rp.state
    if (st.enabled && (t === 'group' || st.applyToPrivate)) {
      const last = this.lastSelfAt.get(key)
      // 进程刚启动视为"刚说过话"，避免一上来就冷场；之后按真实静默时长衰减
      const elapsed = last ? Date.now() - last : 0
      p = stateReplyProb(elapsed, base)
    }
    if (t === 'group' && rp.hourly.length === 24) {
      p *= rp.hourly[new Date().getHours()]
    }
    if (batchSize >= rp.batchPenalty.threshold) p *= rp.batchPenalty.factor
    // 近期状态：精力/心情/耐心/社交/忙碌/烦躁 → 回复倾向
    p *= computeModifiers(this.recentState).replyProb
    // 群聊被 @ / 叫名字：必回（状态/时段/连发惩罚都不打折）
    if (woke && t === 'group') p = 1
    return Math.max(0, Math.min(1, p))
  }

  /** 状态落库（节流，避免每条消息都写 sqlite） */
  private persistState(force = false): void {
    const now = Date.now()
    if (!force && now - this.lastStateSaveAt < 2000) return
    this.lastStateSaveAt = now
    saveState(this.recentState, this.stateKey)
  }

  /** 状态 → 话术风格偏置（表情/语气词/错字/长度） */
  private styleBias(mods: StateModifiers): StyleBias | undefined {
    if (!config.humanlike.recentState.effects.style) return undefined
    const st = config.humanlike.style
    return {
      emojiProb: clamp01(st.emojiProb * mods.emoji),
      fillerProb: clamp01(st.fillerProb * mods.filler),
      typoProb: clamp01(st.typoProb * mods.typo),
      echoProb: clamp01(st.echoProb * mods.echo),
      maxChars: Math.max(20, Math.round(st.maxChars * mods.styleLength)),
    }
  }

  // ── 触发一轮回复 ──────────────────────────────────────────────────────

  /** 每个场景串行排队：前一轮没跑完（反应/LLM/分段发送）就不并发，保住随机节奏 */
  private enqueueFlush(key: SceneKey): void {
    const run = (this.flushChain.get(key) ?? Promise.resolve())
      .then(() => this.flush(key))
      .catch(e => console.error('[Core] flush 错误:', e))
      .finally(() => this.flushChain.delete(key))
    this.flushChain.set(key, run)
  }

  private enqueueFlushProactive(key: SceneKey, ctx: string, lastMsg: string): void {
    const run = (this.flushChain.get(key) ?? Promise.resolve())
      .then(() => this.flushProactive(key, ctx, lastMsg))
      .catch(e => console.error('[Core] 主动说话错误:', e))
      .finally(() => this.flushChain.delete(key))
    this.flushChain.set(key, run)
  }

  async flush(key: SceneKey): Promise<void> {
    const old = this.timers.get(key)
    if (old) { clearTimeout(old.handle); this.timers.delete(key) }
    // 轮次锁：一整轮（生成 + 逐条发送）完成前，外部新消息不触发新回复
    if (this.replying.has(key)) return
    this.replying.add(key)
    const g = this.pending.get(key)
    if (!g || g.lines.length === 0) {
      this.replying.delete(key)
      return
    }
    this.pending.delete(key)
    this.emit()

    const triggerNick = g.triggerNick || g.lastNick
    const ctx = g.lines.join('\n')
    const t: SceneType = key.startsWith('p:') ? 'private' : 'group'
    const id = Number(key.slice(2))
    const p = paramFor(t)

    console.log(`[Core] 触发 ${key}: 共 ${g.lines.length} 条（触发者=${triggerNick || '无'}）`)

    try {
      // 回复概率：对话状态 + 分时段 + 连发长度（模拟真人；被点名必回）
      const prob = this.effectiveReplyProb(key, t, g.lines.length, !!g.woke)
      if (prob < 1 && Math.random() > prob) {
        console.log(`[Core] ${key} 概率沉默（replyProb=${prob.toFixed(2)}）`)
        this.emit()
        return
      }

      const mods = computeModifiers(this.recentState)
      const ragContext = await searchRag(ctx)
      const systemPrompt = buildSystemPrompt(t)
      const ragMsg = buildRagContextMessage(ragContext)

      const hist = (await this.dialogFor(key)).slice(-config.agent.maxHistory)
      // 只回触发者：整段上下文都给人名标签作背景，但要说明本轮回谁
      const scopeLine = t === 'group' && triggerNick
        ? `\n（这一轮群里有好几个人在说话，你只回应 ${triggerNick} 说的这条，其他人先别管）\n`
        : '\n'
      const userMsg: ChatMessage = { role: 'user', content: `${ctx}${scopeLine}${config.persona.name}：`, time: Date.now() }

      // 触发后先"反应"：随机延迟再开始生成，模拟真人看到→想→才回（绝不秒回）
      // 累/忙/烦时更慢；状态消息在延迟后构建，尽量新鲜
      await sleep(Math.max(1000, Math.round(sampleReactMs() * mods.reactDelay)))
      const stateMsg = buildStateContextMessage(this.recentState)
      const messages: ChatMessage[] = [
        { role: 'system', content: systemPrompt },
        ...hist,
        ...(ragMsg ? [ragMsg] : []),
        ...(stateMsg ? [stateMsg] : []),
        userMsg,
      ]

      const raw = await callLlm(messages)
      if (!raw) {
        console.log('[Core] LLM 无回复，跳过')
        this.emit()
        return
      }
      // 话术风格后处理（表情/语气词/错字/长度收敛/回敬）
      const reply = applyStyle(raw, ctx, this.styleBias(mods))
      console.log(`[Core] 回复 ${key}: ${reply}`)

      const assistantMsg: ChatMessage = { role: 'assistant', content: reply, time: Date.now() }
      const updated: ChatMessage[] = [...hist, userMsg, assistantMsg].slice(-config.agent.maxHistory)
      this.dialogs.set(key, updated)
      this.persist(key)

      // 发消息一定要慢：距上一条回复至少 cooldown（带随机抖动×状态冷却乘数）；刷屏太密再叠加额外冷却
      const baseCd = jitter(p.cooldown, config.humanlike.cooldown.jitter) * mods.cooldown
      const wait = Math.max(this.lastReplyAt + baseCd - Date.now(), this.burstWaitMs())
      if (wait > 0) await sleep(wait)
      await this.sendReplySegmented(t, id, reply)
      this.lastReplyAt = Date.now()
      this.lastSelfAt.set(key, Date.now())
      this.recentState = onReply(this.recentState, Date.now(), [...reply].length)
      this.persistState(true)
      this.noteReply()
      recordGroupReply(id)
      this.emit()
    } catch (err) {
      console.error('[Core] flush 错误:', err)
      this.emit()
    } finally {
      // 解锁轮次锁；若期间又攒了新消息，安排下一轮判定（重新起 timer）
      this.replying.delete(key)
      const next = this.pending.get(key)
      if (next && next.lines.length) {
        const np = paramFor(t)
        const gap = jitter(np.batchT, config.humanlike.cooldown.jitter)
        this.timers.set(key, { handle: setTimeout(() => this.enqueueFlush(key), gap), deadlineAt: Date.now() + gap })
        this.emit()
      }
    }
  }

  /** 主动说话：某场景沉寂超过 gap 后主动冒泡 */
  async proactiveTick(): Promise<void> {
    const gap = config.humanlike.schedule.proactiveGapMs
    if (!gap) return
    if (inQuietHours()) return
    // 近期状态：精力/社交/心情高、不忙不烦才更想主动冒泡
    const stateActive = config.humanlike.recentState.enabled && config.humanlike.recentState.effects.proactive
    const mods = computeModifiers(this.recentState)
    if (stateActive && Math.random() > mods.proactive) return
    const effectiveGap = stateActive ? gap * (1.6 - mods.proactive) : gap
    if (this.lastActiveAt && Date.now() - this.lastActiveAt < effectiveGap) return
    if (this.lastReplyAt && Date.now() - this.lastReplyAt < effectiveGap) return
    const now = Date.now()
    for (const [key, d] of this.dialogs) {
      if (now - (d.at(-1)?.time ?? 0) < effectiveGap) continue
      const t: SceneType = key.startsWith('p:') ? 'private' : 'group'
      const id = Number(key.slice(2))
      if (this.pending.has(key)) continue
      if (!sceneAllowed(t, id)) continue
      const lastMsg = d.at(-1)?.content || ''
      const ctx = `（${t === 'group' ? '在群里' : '和' + config.persona.friendName + '单独聊'}）好久没动静了，${t === 'group' ? '找个话题冒个泡' : '主动发个消息'}`
      void this.enqueueFlushProactive(key, ctx, lastMsg)
      this.lastActiveAt = now
      return
    }
  }

  private async flushProactive(key: SceneKey, ctx: string, lastMsg: string): Promise<void> {
    const t: SceneType = key.startsWith('p:') ? 'private' : 'group'
    const id = Number(key.slice(2))
    const p = paramFor(t)
    try {
      const mods = computeModifiers(this.recentState)
      const ragContext = await searchRag(lastMsg)
      const systemPrompt = buildSystemPrompt(t)
      const ragMsg = buildRagContextMessage(ragContext)
      const hist = (await this.dialogFor(key)).slice(-config.agent.maxHistory)
      const userMsg: ChatMessage = { role: 'user', content: `${ctx}\n${config.persona.name}：`, time: Date.now() }
      // 主动说话同样要"想一下再开口"，不能到了间隔立刻干巴巴冒泡
      await sleep(Math.max(1000, Math.round(sampleReactMs() * mods.reactDelay)))
      const stateMsg = buildStateContextMessage(this.recentState)
      const messages: ChatMessage[] = [
        { role: 'system', content: systemPrompt },
        ...hist,
        ...(ragMsg ? [ragMsg] : []),
        ...(stateMsg ? [stateMsg] : []),
        userMsg,
      ]
      const raw = await callLlm(messages)
      if (!raw) return
      const reply = applyStyle(raw, lastMsg, this.styleBias(mods))
      const wait = Math.max(this.lastReplyAt + jitter(p.cooldown, config.humanlike.cooldown.jitter) * mods.cooldown - Date.now(), this.burstWaitMs())
      if (wait > 0) await sleep(wait)
      await this.sendReplySegmented(t, id, reply, mods.segments)
      this.lastReplyAt = Date.now()
      this.lastSelfAt.set(key, Date.now())
      this.recentState = onReply(this.recentState, Date.now(), [...reply].length)
      this.persistState(true)
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
  private async sendReplySegmented(t: SceneType, id: number, reply: string, segMod = 1): Promise<void> {
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
    // 拆条 + 超长单条再拆 + 限制最多拆几条（超出部分合并到末尾，避免狂刷几十条）
    // segMod：状态驱动的分段条数乘数（兴致高多拆几句，烦躁少发）
    let segments = reply.split('\n').map(s => s.trimEnd())
    const maxSegChars = config.humanlike.style.maxSegmentChars
    if (maxSegChars > 0) segments = segments.flatMap(s => splitLongSegment(s, maxSegChars))
    const maxSeg = ty.maxSegments > 0 ? Math.max(1, Math.round(ty.maxSegments * segMod)) : 0
    if (maxSeg > 0 && segments.length > maxSeg) {
      const head = segments.slice(0, maxSeg - 1)
      const tail = segments.slice(maxSeg - 1).filter(s => s.trim() !== '')
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
      if (i === 1) await sleep(jitter(ty.firstDelayMs, config.humanlike.cooldown.jitter))
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
    decayState(this.recentState, now)
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
      recentState: stateView(this.recentState, now),
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
      this.recentState = resetState(this.stateKey)
      this.persistState(true)
      console.log('[Core] 清空全部会话记忆')
    }
    this.emit()
  }

  private emit(): void {
    const snap = this.getSnapshot()
    for (const fn of this.listeners) fn(snap)
  }
}
