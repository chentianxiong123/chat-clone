import { config } from './config.js'
import { callLlm, callLlmWithTools, type ChatMessage, type ToolSpec } from './llm.js'
import { buildSystemPrompt } from './prompt.js'
import { searchRag } from './rag.js'
import { MEMORY_TOOLS, REPLY_TOOL, GET_STATE_TOOL, createAgentExecutors } from './tools.js'
import { relevanceScore } from './dynamics.js'
import { applyStyle, sampleReactMs, replaceMechanismWords, stateReplyProb, type StyleBias } from './profile.js'
import { recordGroupMsg, recordGroupReply } from './stats.js'
import {
  loadDialog, saveDialog, clearDialogDb, shouldCompress, compressDialog, countMessagesTokens, listSceneKeys,
} from './memory.js'
import {
  loadState, saveState, resetState, onMessage, onReply, decayState, computeModifiers,
  buildStatePrompt, stateView, type RecentState, type RecentStateView, type StateModifiers,
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
  simulated?: boolean      // WebUI 模拟注入：不写真实群统计
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
  batchN: string
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
/** 距某时间戳过去了多久（未设置按 0 算） */
const lastElapsed = (ts?: number): number => (ts ? Date.now() - ts : 0)

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

/** 去掉模型可能吐出的"人设名："续写前缀 */
function stripSelfPrefix(text: string): string {
  const name = config.persona.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return text.replace(new RegExp('^\\s*' + name + '\\s*[：:]\\s*'), '')
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
  private pending = new Map<SceneKey, { lines: string[]; targetN?: number; lastMsgAt?: number; woke?: boolean; atBot?: boolean; lastNick?: string; triggerNick?: string; simulated?: boolean }>()
  private dialogs = new Map<SceneKey, ChatMessage[]>()
  private timers = new Map<SceneKey, { handle: ReturnType<typeof setTimeout>; deadlineAt: number }>()
  private lastReplyAt = 0
  private lastActiveAt = 0
  /** 每个场景最后一次本人发言时间（对话状态用：热聊/冷场） */
  private lastSelfAt = new Map<SceneKey, number>()
  /** 近期状态（全局：精力/心情/耐心/社交/烦躁/兴趣…） */
  private recentState: RecentState
  private stateKey = 'global'
  private lastStateSaveAt = 0
  private listeners = new Set<Listener>()
  /** 每个场景的回复串行锁：保证同时只有一条回复在"想+发"，分段间隔不被并发打乱 */
  private flushChain = new Map<SceneKey, Promise<void>>()
  /** 回复轮次锁：某场景正在"生成+逐条发送"期间锁住，不再触发新回复；整轮发完才解锁重判 */
  private replying = new Set<SceneKey>()
  /** 每个场景最近若干条自己的回复（反模板/近重复检测用） */

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
    if (!g) { g = { lines: [], targetN: paramFor(t).batchN, simulated: !!msg.simulated }; this.pending.set(key, g) }
    g.lines.push(line)
    g.simulated = g.simulated || !!msg.simulated
    g.lastNick = who
    if (msg.atBot) g.triggerNick = who
    g.lastMsgAt = Date.now()
    const p = paramFor(t)
    const need = g.targetN ?? p.batchN
    // 批内只保留最近 need 条，群一直说话也不会无限膨胀
    if (g.lines.length > need) g.lines = g.lines.slice(-need)
    if (!g.simulated) recordGroupMsg(id)
    this.lastActiveAt = Date.now()

    const woke = !needWake(t, msg)
    g.woke = g.woke || (t === 'group' && woke)

    // 群聊触发：每条消息都重置"静止"计时器；只有攒够批数且群静了 T 秒才触发。
    // @/唤醒词可以把批数条件放宽，但仍要等群静下来，避免一有人说话就插嘴。
    if (t === 'group') this.armGroupIdle(key, t)

    // 近期状态：先更新（忽略/半醒的消息也算看到了），影响后续概率与语气
    this.recentState = onMessage(this.recentState, text, Date.now(), { atBot: msg.atBot, woke })
    this.persistState()

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

    const wokeN = t === 'group' && !woke ? `待唤醒` : (woke ? '' : '')
    console.log(`[Core] 攒批 ${key} (${g.lines.length}/${need}${wokeN}): ${text.slice(0, 24)}`)

    if (this.replying.has(key)) { this.emit(); return }
    // 私聊不攒批：直接触发，WebUI 里也能即时聊
    if (t === 'private') { void this.enqueueFlush(key); return }
    this.emit()
  }

  /** 群聊"静止"计时器：每次新消息重置；到期时只有批数够（或被 @）才触发 */
  private armGroupIdle(key: SceneKey, t: SceneType): void {
    const old = this.timers.get(key)
    if (old) clearTimeout(old.handle)
    const p = paramFor(t)
    const delay = jitter(p.batchT, config.humanlike.cooldown.jitter)
    const handle = setTimeout(() => {
      this.timers.delete(key)
      if (inQuietHours()) return
      const g = this.pending.get(key)
      if (!g || g.lines.length === 0) return
      if (config.agent.respondMode === 'mention' && !g.woke) return
      const need = g.targetN ?? p.batchN
      if (g.lines.length >= need || g.woke) this.enqueueFlush(key)
    }, delay)
    this.timers.set(key, { handle, deadlineAt: Date.now() + delay })
  }

  /** 综合对话状态 / 分时段 / 连发长度 / 上一条相关度 / 唤醒 计算本轮回复概率 */
  private effectiveReplyProb(
    key: SceneKey,
    t: SceneType,
    batchSize: number,
    woke: boolean,
    ctx: string,
    prevTexts: string[],
  ): number {
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
    // 动态概率（群聊）：新消息和最近几条越相关越可能接话，突然岔开越可能略过
    const dyn = rp.dynamic
    if (dyn.enabled && t === 'group' && prevTexts.length) {
      const rel = Math.max(...prevTexts.map(x => relevanceScore(ctx, x)))
      const span = rel >= dyn.threshold
        ? dyn.boost * (rel - dyn.threshold) / Math.max(1e-6, 1 - dyn.threshold)
        : -dyn.drop * (dyn.threshold - rel) / Math.max(1e-6, dyn.threshold)
      p = Math.max(0, Math.min(1, dyn.base + span))
      // 仍保留"越久没说话越可能不回"的轻量衰减（active=1 / semi=0.9 / cold=0.85…）
      if (st.enabled) p *= stateReplyProb(lastElapsed(this.lastSelfAt.get(key)), 1)
      console.log(`[Core] ${key} 动态回复概率 rel=${rel.toFixed(2)} → ${p.toFixed(2)}`)
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
      maxChars: st.maxChars > 0 ? Math.max(20, Math.round(st.maxChars * mods.styleLength)) : 0,
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
      const hist = (await this.dialogFor(key)).slice(-config.agent.maxHistory)
      // 上一条（可配多条）作为"是否接着聊"的参照
      const prevMsgs = hist.slice(-config.humanlike.replyProb.dynamic.contextMsgs)
      const prevTexts = prevMsgs.map(m => m.content)
      // 回复概率：动态相关度 + 对话状态 + 分时段 + 连发长度（模拟真人；被点名必回）
      const prob = this.effectiveReplyProb(key, t, g.lines.length, !!g.woke, ctx, prevTexts)
      if (prob < 1 && Math.random() > prob) {
        console.log(`[Core] ${key} 概率沉默（replyProb=${prob.toFixed(2)}）`)
        this.emit()
        return
      }

      const mods = computeModifiers(this.recentState)
      const systemPrompt = buildSystemPrompt(t)

      // 只回触发者：整段上下文都给人名标签作背景，但要说明本轮回谁（场景事实，非风格诱导）
      const scopeLine = t === 'group' && triggerNick
        ? `\n（这一轮群里有好几个人在说话，你只回应 ${triggerNick} 说的这条，其他人先别管）\n`
        : '\n'
      let refBlock = ''
      try {
        const ref = await searchRag(ctx)
        if (ref) refBlock = `【你们以前类似话题怎么聊的——尽量用里面出现过的词和说法来说，别自己另编】\n${ref}\n\n`
      } catch { /* ignore */ }
      const userMsg: ChatMessage = { role: 'user', content: `${refBlock}${ctx}${scopeLine}${config.persona.name}：`, time: Date.now() }

      // 触发后先"反应"：随机延迟再开始生成，模拟真人看到→想→才回（绝不秒回）
      await sleep(Math.max(1000, Math.round(sampleReactMs() * mods.reactDelay)))

      // MCP 式工具化：模型按需调 reply/search_past_memory/remember/get_state，拿到结果再接着想。
      // reply 工具攒句（可多次=短句分条）；模型不调 reply 且无 content = 沉默（真人挑话接）。
      const toolReplies: string[] = []
      const executors = createAgentExecutors(key, {
        reply: async (texts) => { toolReplies.push(...texts) },
        getState: () => buildStatePrompt(this.recentState),
      })
      const llmTools: ToolSpec[] = [
        ...MEMORY_TOOLS,
        REPLY_TOOL,
        ...(config.agent.getStateEnabled ? [GET_STATE_TOOL] : []),
      ]
      const messages: ChatMessage[] = [
        { role: 'system', content: systemPrompt },
        ...hist,
        userMsg,
      ]

      let raw = ''
      if (config.rag.toolsEnabled) {
        const r = await callLlmWithTools(messages, {
          tools: llmTools,
          executors,
          maxIter: config.agent.toolMaxIter,
        })
        raw = toolReplies.length ? toolReplies.join('\n') : r.text
      } else {
        raw = await callLlm(messages)
      }
      // 模型没调 reply 也没输出内容 → 强制再生成一句。
      // 回不回由外部系统（effectiveReplyProb）决定；走到这一步就是"决定回"，模型必产出，不再沉默。
      if (!raw) {
        raw = await callLlm(messages)
        if (!raw) {
          console.log(`[Core] ${key} 无输出（模型未生成）`)
          this.emit()
          return
        }
      }
      // 话术风格后处理：每条 reply 独立样式（表情/语气词/错字），保持"每条一条消息"的工具边界。
      // 分段源 = 模型调用的 reply 工具序列（每条一条）；未走工具则整段兜底。
      const segs = toolReplies.length ? toolReplies : [raw]
      const styled = segs.map(s => replaceMechanismWords(stripSelfPrefix(applyStyle(s, ctx, this.styleBias(mods)))))
      let reply = styled.join('\n')
      console.log(`[Core] 回复 ${key}: ${reply}`)

      const assistantMsg: ChatMessage = { role: 'assistant', content: reply, time: Date.now() }
      const updated: ChatMessage[] = [...hist, userMsg, assistantMsg].slice(-config.agent.maxHistory)
      this.dialogs.set(key, updated)
      this.persist(key)

      // 发消息一定要慢：距上一条回复至少 cooldown（带随机抖动×状态冷却乘数）
      const baseCd = jitter(p.cooldown, config.humanlike.cooldown.jitter) * mods.cooldown
      const wait = Math.max(this.lastReplyAt + baseCd - Date.now(), 0)
      if (wait > 0) await sleep(wait)
      await this.sendReplySegmented(t, id, styled)
      this.lastReplyAt = Date.now()
      this.lastSelfAt.set(key, Date.now())
      this.recentState = onReply(this.recentState, Date.now(), [...reply].length)
      this.persistState(true)
      if (!g.simulated) recordGroupReply(id)
      this.emit()
    } catch (err) {
      console.error('[Core] flush 错误:', err)
      this.emit()
    } finally {
      // 解锁轮次锁；若期间又攒了新消息，群聊重新等"静止+批数"，私聊直接下一轮
      this.replying.delete(key)
      const next = this.pending.get(key)
      if (next && next.lines.length) {
        if (t === 'private') void this.enqueueFlush(key)
        else this.armGroupIdle(key, t)
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
      const systemPrompt = buildSystemPrompt(t)
      const hist = (await this.dialogFor(key)).slice(-config.agent.maxHistory)
      const userMsg: ChatMessage = { role: 'user', content: `${ctx}\n${config.persona.name}：`, time: Date.now() }
      // 主动说话同样要"想一下再开口"，不能到了间隔立刻干巴巴冒泡
      await sleep(Math.max(1000, Math.round(sampleReactMs() * mods.reactDelay)))

      const toolReplies: string[] = []
      const executors = createAgentExecutors(key, {
        reply: async (texts) => { toolReplies.push(...texts) },
        getState: () => buildStatePrompt(this.recentState),
      })
      const llmTools: ToolSpec[] = [
        ...MEMORY_TOOLS,
        REPLY_TOOL,
        ...(config.agent.getStateEnabled ? [GET_STATE_TOOL] : []),
      ]
      const messages: ChatMessage[] = [
        { role: 'system', content: systemPrompt },
        ...hist,
        userMsg,
      ]
      let raw = ''
      if (config.rag.toolsEnabled) {
        const r = await callLlmWithTools(messages, {
          tools: llmTools,
          executors,
          maxIter: config.agent.toolMaxIter,
        })
        raw = toolReplies.length ? toolReplies.join('\n') : r.text
      } else {
        raw = await callLlm(messages)
      }
      if (!raw) {
        raw = await callLlm(messages)
        if (!raw) return
      }
      const segs = toolReplies.length ? toolReplies : [raw]
      const styled = segs.map(s => replaceMechanismWords(stripSelfPrefix(applyStyle(s, lastMsg, this.styleBias(mods)))))
      let reply = styled.join('\n')
      const wait = Math.max(this.lastReplyAt + jitter(p.cooldown, config.humanlike.cooldown.jitter) * mods.cooldown - Date.now(), 0)
      if (wait > 0) await sleep(wait)
      await this.sendReplySegmented(t, id, styled)
      this.lastReplyAt = Date.now()
      this.lastSelfAt.set(key, Date.now())
      this.recentState = onReply(this.recentState, Date.now(), [...reply].length)
      this.persistState(true)
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
  private async sendReplySegmented(t: SceneType, id: number, segments: string[]): Promise<void> {
    const ty = config.humanlike.typing
    // 工具格式分割：调用方传入的分段（每条 reply = 一条消息）原样发送，程序不再按长度/条数拆分。
    const logSeg = (i: number, seg: string): void => {
      console.log(`[Core] 分段 ${t}:${id} ${i}: ${seg.slice(0, 40)}`)
    }
    let i = 0
    for (const raw of segments) {
      const seg = raw.trimEnd()
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
        // 单条发送失败不中断整轮（无重试，失败则跳过该条继续发后面的）
        try { await this.onReply(t, id, seg) } catch (e) {
          console.warn(`[Core] 分段发送失败(跳过): ${(e as Error).message}`)
        }
      }
      logSeg(i, seg)
    }
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
