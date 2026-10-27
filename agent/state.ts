import { config, minedProfileMeta } from './config.js'
import { loadRecentState, saveRecentState, clearRecentState } from './memory.js'
import type { ChatMessage } from './llm.js'

/**
 * 近期状态（全局，单群场景）
 * 数值 0~1；事件更新 + 指数衰减回基线。
 * 用途：影响回复概率/反应延迟/话术风格/主动性，并把紧凑状态注入提示词尾部。
 * 刻意不写进 system prompt / 对话历史：保证 KV 前缀缓存，且不污染长期记忆。
 */
export interface RecentState {
  energy: number       // 精力
  mood: number         // 心情（0.5 中性）
  patience: number     // 耐心
  social: number       // 社交电量
  busy: number         // 忙碌度
  irritation: number   // 烦躁（刷屏/重复/负能量）
  interest: number     // 当前话题兴趣
  focus: number        // 注意力集中度
  recentMsgs: number   // 近窗口消息量（指数加权）
  recentReplies: number// 近窗口回复量（指数加权）
  otherStreak: number  // 连续对方发言
  selfStreak: number   // 连续自己发言
  topic: string        // 最近话题片段
  topicHits: number    // 话题重复次数（衰减）
  lastMsgAt: number
  lastSelfAt: number
  lastOtherAt: number
  lastDecayAt: number
  updatedAt: number
}

export interface StateLabels {
  energy: string
  mood: string
  patience: string
  social: string
  busy: string
}

export interface StateModifiers {
  replyProb: number   // 回复概率乘数
  reactDelay: number  // 反应延迟乘数
  styleLength: number // 话术长度乘数
  emoji: number
  filler: number
  typo: number
  echo: number
  proactive: number   // 主动说话概率 0~1
  cooldown: number    // 冷却乘数（烦躁/忙更久，兴致高更短）
  segments: number    // 分段条数乘数（兴致高说更多段，烦躁就 1-2 段）
  followUp: number    // 追问倾向 0~1（感兴趣时顺嘴追问一句）
  deflect: number     // 岔开话题倾向 0~1（不感兴趣就敷衍岔开）
}

export interface RecentStateView extends RecentState {
  msgRate: number
  replyRate: number
  silenceMs: number | null
  modifiers: StateModifiers
  labels: StateLabels
}

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x))
const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x))
const toMin = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number)
  return (h || 0) * 60 + (m || 0)
}
const half = (dt: number, halfLife: number): number => (halfLife > 0 ? Math.pow(0.5, dt / halfLife) : 0)
const decayTo = (cur: number, target: number, halfLife: number, dt: number): number =>
  halfLife > 0 ? target + (cur - target) * half(dt, halfLife) : target

const NUM_FIELDS: Array<keyof RecentState> = [
  'energy', 'mood', 'patience', 'social', 'busy', 'irritation', 'interest', 'focus',
  'recentMsgs', 'recentReplies', 'otherStreak', 'selfStreak', 'topicHits',
  'lastMsgAt', 'lastSelfAt', 'lastOtherAt', 'lastDecayAt', 'updatedAt',
]

function profileHourRatio(): number[] | null {
  const raw = minedProfileMeta?.stats?.hourRatio
  if (Array.isArray(raw) && raw.length === 24) return raw as number[]
  return null
}

/** 精力基线：优先 env 24 值 → 画像 hourRatio → 默认曲线 */
export function energyBaseline(hour = new Date().getHours()): number {
  const custom = config.humanlike.recentState.energyHourly
  if (custom.length === 24) return clamp01(custom[hour])
  const ratio = profileHourRatio()
  if (ratio) return clamp01(0.3 + 0.6 * clamp01(ratio[hour]))
  const curve = [
    0.35, 0.3, 0.25, 0.2, 0.2, 0.25, 0.35, 0.45, 0.55, 0.65, 0.7, 0.72,
    0.7, 0.65, 0.7, 0.72, 0.7, 0.68, 0.65, 0.65, 0.6, 0.55, 0.5, 0.4,
  ]
  return curve[hour] ?? 0.6
}

/** 忙碌基线：命中工作时段取该段值，否则基础值 */
export function busyBaseline(hour: number): number {
  const cur = hour * 60
  for (const b of config.humanlike.recentState.busyHours) {
    const s = toMin(b.start)
    const e = toMin(b.end)
    if (s <= e ? (cur >= s && cur <= e) : (cur >= s || cur <= e)) return clamp01(b.prob)
  }
  return clamp01(config.humanlike.recentState.baseline.busy)
}

export function defaultState(now = Date.now()): RecentState {
  const rs = config.humanlike.recentState
  const h = new Date(now).getHours()
  return {
    energy: energyBaseline(h),
    mood: rs.baseline.mood,
    patience: rs.baseline.patience,
    social: rs.baseline.social,
    busy: busyBaseline(h),
    irritation: 0,
    interest: 0.5,
    focus: 0.5,
    recentMsgs: 0,
    recentReplies: 0,
    otherStreak: 0,
    selfStreak: 0,
    topic: '',
    topicHits: 0,
    lastMsgAt: 0,
    lastSelfAt: 0,
    lastOtherAt: 0,
    lastDecayAt: now,
    updatedAt: now,
  }
}

/** 指数衰减到基线；dt 上限 7 天，防止长时间停机后数值炸裂 */
export function decayState(state: RecentState, now = Date.now()): RecentState {
  const rs = config.humanlike.recentState
  const dt = Math.max(0, Math.min(now - state.lastDecayAt, 7 * 86_400_000))
  if (!rs.enabled || dt < 1000) {
    state.lastDecayAt = now
    return state
  }
  const h = new Date(now).getHours()
  state.energy = decayTo(state.energy, energyBaseline(h), rs.decay.energyMs, dt)
  state.mood = decayTo(state.mood, rs.baseline.mood, rs.decay.moodMs, dt)
  state.patience = decayTo(state.patience, rs.baseline.patience, rs.decay.patienceMs, dt)
  state.social = decayTo(state.social, rs.baseline.social, rs.decay.socialMs, dt)
  state.busy = decayTo(state.busy, busyBaseline(h), rs.decay.busyMs, dt)
  state.irritation = decayTo(state.irritation, 0, rs.decay.irritationMs, dt)
  state.interest = decayTo(state.interest, 0.5, rs.decay.interestMs, dt)
  state.focus = decayTo(state.focus, 0.5, rs.decay.focusMs, dt)
  state.recentMsgs *= half(dt, rs.windowMs)
  state.recentReplies *= half(dt, rs.windowMs)
  state.topicHits *= half(dt, rs.decay.topicMs)
  if (state.lastMsgAt && now - state.lastMsgAt > rs.streakTimeoutMs) state.otherStreak = 0
  if (state.lastSelfAt && now - state.lastSelfAt > rs.streakTimeoutMs) state.selfStreak = 0
  state.lastDecayAt = now
  state.energy = clamp01(state.energy)
  state.mood = clamp01(state.mood)
  state.patience = clamp01(state.patience)
  state.social = clamp01(state.social)
  state.busy = clamp01(state.busy)
  state.irritation = clamp01(state.irritation)
  state.interest = clamp01(state.interest)
  state.focus = clamp01(state.focus)
  return state
}

export function loadState(key = 'global'): RecentState {
  const now = Date.now()
  const base = defaultState(now)
  const row = loadRecentState(key)
  if (!row) return base
  try {
    const parsed = JSON.parse(row.json) as Partial<RecentState>
    const merged: RecentState = { ...base, ...parsed }
    const rec = merged as unknown as Record<string, unknown>
    const baseRec = base as unknown as Record<string, unknown>
    for (const k of NUM_FIELDS) {
      if (!Number.isFinite(rec[k] as number)) rec[k] = baseRec[k]
    }
    merged.topic = typeof merged.topic === 'string' ? merged.topic.slice(0, 40) : ''
    if (!Number.isFinite(merged.lastDecayAt)) merged.lastDecayAt = now
    return decayState(merged, now)
  } catch {
    return base
  }
}

export function saveState(state: RecentState, key = 'global'): void {
  if (!config.humanlike.recentState.enabled) return
  state.updatedAt = Date.now()
  saveRecentState(key, JSON.stringify(state))
}

export function resetState(key = 'global'): RecentState {
  clearRecentState(key)
  return defaultState()
}

const POS_RE = /(哈哈|笑死|好耶|牛|赞|喜欢|开心|不错|可以|强|厉害|可爱|好看)/
const NEG_RE = /(烦|累|草|垃圾|无语|气|难受|恶心|傻逼|sb|吐了|崩溃|寄了)/i
const Q_RE = /[?？]|吗|呢|怎么|为什么|啥|什么|哪|谁|几点|多少/

/** 收到消息：更新精力/心情/耐心/社交/烦躁/兴趣/话题/连发 */
export function onMessage(
  state: RecentState,
  text: string,
  now = Date.now(),
  opts: { atBot?: boolean; woke?: boolean } = {},
): RecentState {
  const rs = config.humanlike.recentState
  if (!rs.enabled) return state
  const prevOtherAt = state.lastOtherAt
  const prevStreak = state.otherStreak
  decayState(state, now)

  const t = text.trim()
  const len = [...t].length
  const isAt = !!opts.atBot || !!opts.woke
  const isQuestion = Q_RE.test(t)
  const isShort = len <= 2
  const isPos = POS_RE.test(t)
  const isNeg = NEG_RE.test(t)
  const rapid = prevOtherAt > 0 && now - prevOtherAt < 60_000
  const spam = prevStreak >= 3 && rapid
  const sameTopic = !!state.topic && (
    t.includes(state.topic.slice(0, 4)) || state.topic.includes(t.slice(0, 4))
  )

  state.recentMsgs += 1
  state.lastMsgAt = now
  state.lastOtherAt = now
  state.otherStreak = prevStreak + 1
  state.selfStreak = 0
  state.energy = clamp01(state.energy - 0.008)
  state.social = clamp01(state.social - 0.012)
  state.interest = clamp01(state.interest + (isQuestion || isAt ? 0.12 : isShort ? -0.04 : 0.03))
  state.focus = clamp01(state.focus + (isAt || isQuestion ? 0.1 : sameTopic ? 0.05 : -0.02))
  state.irritation = clamp01(
    state.irritation + (spam ? 0.08 : 0) + (isShort ? 0.01 : 0) + (sameTopic && spam ? 0.03 : 0) + (isNeg ? 0.02 : 0),
  )
  state.patience = clamp01(state.patience - 0.02 * state.irritation)
  state.mood = clamp01(
    state.mood + (isPos ? 0.05 : 0) - (isNeg ? 0.05 : 0) + (isAt ? 0.02 : 0) +
      (Math.random() - 0.5) * rs.noise,
  )

  if (isQuestion || len >= 4) {
    const snippet = t.replace(/[，。！？!?,.…\s]+/g, '').slice(0, 12)
    if (snippet) {
      if (sameTopic) {
        state.topicHits += 1
      } else {
        state.topic = snippet
        state.topicHits = 1
      }
    }
  }
  state.updatedAt = now
  return state
}

/** 发出回复：消耗精力/社交，心情小幅回升，烦躁下降 */
export function onReply(state: RecentState, now = Date.now(), replyLen = 0): RecentState {
  const rs = config.humanlike.recentState
  if (!rs.enabled) return state
  decayState(state, now)
  const long = replyLen > 30
  state.recentReplies += 1
  state.lastSelfAt = now
  state.selfStreak += 1
  state.otherStreak = 0
  state.energy = clamp01(state.energy - (long ? 0.035 : 0.015))
  state.social = clamp01(state.social - (long ? 0.05 : 0.03))
  state.patience = clamp01(state.patience - 0.005)
  state.mood = clamp01(state.mood + 0.02)
  state.irritation = clamp01(state.irritation - 0.03)
  state.focus = clamp01(state.focus + 0.03)
  state.updatedAt = now
  return state
}

export function stateLabels(state: RecentState): StateLabels {
  return {
    energy: state.energy < 0.3 ? '很困' : state.energy < 0.5 ? '有点累' : state.energy < 0.7 ? '正常' : '精神',
    mood: state.mood < 0.35 ? '低落' : state.mood < 0.5 ? '一般' : state.mood < 0.7 ? '还行' : '不错',
    patience: state.patience < 0.3 ? '没耐心' : state.patience < 0.5 ? '有点烦' : '有耐心',
    social: state.social < 0.3 ? '不想说话' : state.social < 0.5 ? '社交电量低' : '愿意聊',
    busy: state.busy > 0.6 ? '在忙' : state.busy > 0.35 ? '有点忙' : '闲',
  }
}

/** 派生修正值（中性状态下约等于 1） */
export function computeModifiers(state: RecentState): StateModifiers {
  const rs = config.humanlike.recentState
  if (!rs.enabled) {
    return { replyProb: 1, reactDelay: 1, styleLength: 1, emoji: 1, filler: 1, typo: 1, echo: 1, proactive: 1, cooldown: 1, segments: 1, followUp: 0.5, deflect: 0.5 }
  }
  const { energy: e, mood: m, patience: pat, social: soc, busy, irritation: irr, interest: int } = state
  const w = rs.weights
  const base = rs.baseline
  const hour = new Date().getHours()
  // 以「当前时段基线」为中性点：状态偏离基线才产生修正，避免分时段重复加成
  const eBase = energyBaseline(hour)
  const bBase = busyBaseline(hour)
  const moodBias = (m - base.mood) * 2
  const rawReply =
    1 + 0.55 * (e - eBase) + 0.25 * moodBias + 0.15 * (pat - base.patience) * 2 +
    0.15 * (soc - base.social) * 2 - 0.35 * (busy - bBase) - 0.45 * irr
  const rawReact = 1 + 1.2 * (eBase - e) + 0.8 * (busy - bBase) + 0.6 * irr - 0.2 * moodBias
  const rawLength = 1 + 0.5 * (e - eBase) + 0.2 * moodBias - 0.25 * (busy - bBase) - 0.2 * irr
  const rawEmoji = 1 + 0.7 * (m - base.mood) - 0.3 * irr
  const rawFiller = 1 + 0.4 * (eBase - e) + 0.25 * irr
  const rawTypo = 1 + 0.5 * (eBase - e) + 0.2 * (busy - bBase)
  const rawEcho = 1 + 0.6 * (m - base.mood) + 0.3 * (int - 0.5) - 0.3 * irr
  const rawProactive = e * soc * (1 - busy) * (0.4 + 0.6 * m) * (1 - irr)
  // 新增动态表现维度：烦躁/忙 → 冷却更久、段数更少；兴致/心情好 → 更容易追问、更少岔开
  const rawCooldown = 1 + 0.6 * (bBase - busy) + 0.5 * irr - 0.3 * moodBias
  const rawSegments = 1 + 0.4 * (e - eBase) + 0.3 * moodBias + 0.3 * (int - 0.5) - 0.4 * irr
  const followUpP = 0.25 + 0.45 * int + 0.2 * (m - base.mood) - 0.15 * irr
  const deflectP = 0.6 - 0.45 * int + 0.2 * irr - 0.15 * (m - base.mood)

  const apply = (raw: number, weight: number, lo: number, hi: number): number =>
    clamp(1 + (raw - 1) * weight, lo, hi)

  return {
    replyProb: rs.effects.replyProb ? apply(rawReply, w.reply, 0.2, 1.35) : 1,
    reactDelay: rs.effects.react ? apply(rawReact, w.react, 0.7, 2.8) : 1,
    styleLength: rs.effects.style ? apply(rawLength, w.length, 0.6, 1.3) : 1,
    emoji: rs.effects.style ? apply(rawEmoji, w.emoji, 0.3, 1.6) : 1,
    filler: rs.effects.style ? apply(rawFiller, w.filler, 0.5, 1.5) : 1,
    typo: rs.effects.style ? apply(rawTypo, w.typo, 0.5, 1.5) : 1,
    echo: rs.effects.style ? apply(rawEcho, w.echo, 0.3, 1.5) : 1,
    proactive: rs.effects.proactive ? clamp01(rawProactive * w.proactive) : 1,
    cooldown: rs.effects.react ? apply(rawCooldown, w.cooldown, 0.6, 1.7) : 1,
    segments: rs.effects.style ? apply(rawSegments, w.segments, 0.6, 1.4) : 1,
    followUp: rs.effects.style ? clamp01(followUpP) : 0.5,
    deflect: rs.effects.style ? clamp01(deflectP) : 0.5,
  }
}

function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '很久'
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}秒`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}分钟`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}小时`
  return `${Math.round(h / 24)}天`
}

/** 紧凑状态行（注入提示词用，控制在 promptMaxChars 内） */
export function buildStatePrompt(state: RecentState, now = Date.now()): string {
  const rs = config.humanlike.recentState
  if (!rs.enabled || !rs.injectPrompt) return ''
  const labels = stateLabels(state)
  const windowMin = Math.max(1, Math.round(rs.windowMs / 60_000))
  const msgRate = state.recentMsgs / windowMin
  const silence = state.lastSelfAt ? fmtDuration(now - state.lastSelfAt) : '很久'
  const topic = state.topic ? `；话题：${state.topic}×${Math.round(state.topicHits)}` : ''
  const hints: string[] = []
  if (state.energy < 0.4) hints.push('累就短、懒得展开')
  if (state.irritation > 0.4) hints.push('烦就敷衍、别解释')
  if (state.busy > 0.55) hints.push('忙就一两句')
  if (state.social < 0.35) hints.push('不想聊就嗯哦')
  if (state.mood > 0.7) hints.push('心情好可以多聊两句')
  if (state.interest > 0.7) hints.push('这个话题有兴趣就接')
  // 动态表现：追问 / 岔开（按当前状态概率性给倾向，增加"活人感"）
  const followUpP = 0.25 + 0.45 * state.interest + 0.2 * (state.mood - 0.55) - 0.15 * state.irritation
  const deflectP = 0.6 - 0.45 * state.interest + 0.2 * state.irritation - 0.15 * (state.mood - 0.55)
  if (followUpP > 0.6) hints.push('有点感兴趣，可顺嘴追问对方一句')
  if (deflectP > 0.55) hints.push('这个话题没啥兴趣，可敷衍或岔开')
  if (!hints.length) hints.push('正常聊')
  const text =
    `【你此刻的状态】精力${Math.round(state.energy * 100)}%（${labels.energy}） ` +
    `心情${Math.round(state.mood * 100)}%（${labels.mood}） ` +
    `耐心${Math.round(state.patience * 100)}%（${labels.patience}） ` +
    `社交电量${Math.round(state.social * 100)}% ` +
    `忙碌${Math.round(state.busy * 100)}%（${labels.busy}） ` +
    `烦躁${Math.round(state.irritation * 100)}% ` +
    `兴趣${Math.round(state.interest * 100)}%\n` +
    `近期消息${state.recentMsgs.toFixed(1)}条、回复${state.recentReplies.toFixed(1)}条（约${msgRate.toFixed(1)}条/分）；` +
    `距上次说话${silence}；连续对方${state.otherStreak}条/自己${state.selfStreak}条${topic}\n` +
    `按这个状态自然说话：${hints.join('；')}。不要直接报数值。`
  return text.slice(0, rs.promptMaxChars)
}

/** 状态消息放在对话尾部（RAG 之后、当前用户消息之前），不破坏 system 前缀缓存 */
export function buildStateContextMessage(state: RecentState, now = Date.now()): ChatMessage | null {
  const text = buildStatePrompt(state, now)
  if (!text) return null
  return {
    role: 'user',
    content: `（系统给你此刻的状态，不要复述，只影响语气和长度）\n${text}`,
    time: now,
  }
}

export function stateView(state: RecentState, now = Date.now()): RecentStateView {
  const windowMin = Math.max(1, config.humanlike.recentState.windowMs / 60_000)
  return {
    ...state,
    msgRate: state.recentMsgs / windowMin,
    replyRate: state.recentReplies / windowMin,
    silenceMs: state.lastSelfAt ? Math.max(0, now - state.lastSelfAt) : null,
    modifiers: computeModifiers(state),
    labels: stateLabels(state),
  }
}
