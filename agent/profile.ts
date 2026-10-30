import { config } from './config.js'

/**
 * ── 拟人画像 HumanProfile ─────────────────────────────────────────────────
 * 一切拟人行为参数收敛在此层，全部可配置（config.humanlike）。
 * A~E 维度的每个值，目标都是将来能从「原始聊天数据」统计得出：
 *
 *   buildProfileFromStats(rawStats) → 覆盖/校准对应字段
 *
 * 数据字段 → 画像参数 的映射蓝图（后续实现数据导入时按此填）：
 *   - 真人历史消息时间戳         → react.minMs/maxMs, cooldown.*, burst.*（多久回）
 *   - 同一个人连发的条数/间隔      → typing.charsPerSec, typing.segGap, typing.maxSegments
 *   - 真人单轮长度分位数(如P80)    → style.maxChars
 *   - 语料的 emoji/语气词/错字频次 → style.emojiProb/emoji, fillerProb/fillers, typoProb/typoMap
 *   - 复读对方词的次数            → style.echoProb
 *   - 全天分时段活跃量            → schedule.quietHours, schedule.drowsy[]
 *   - 消息→回复的应答比           → replyProb.group/private
 */

export type HumanlikeProfile = typeof config.humanlike

/** 可从统计数据得到的画像覆盖（键可选，未覆盖的用 env/默认值） */
export type HumanlikeProfileOverride = Partial<{
  replyProb: Partial<HumanlikeProfile['replyProb']>
  react: Partial<HumanlikeProfile['react']>
  cooldown: Partial<HumanlikeProfile['cooldown']>
  typing: Partial<HumanlikeProfile['typing']>
  style: Partial<HumanlikeProfile['style']>
  schedule: Partial<HumanlikeProfile['schedule']>
}>

/** mine.ts 产出的标准化统计（纯数字/字符串，便于落盘与复算） */
export interface MinedStats {
  /** 对方发消息 → 本人回复 的延迟（秒） */
  replyLatencySec: { p10: number; p50: number; p90: number }
  /** 本人单条消息字数分位 */
  selfMsgChars: { p50: number; p80: number; p90: number; p95: number }
  /** 本人一轮（连发合并）总字数分位 */
  turnChars: { p50: number; p80: number; p90: number }
  /** 本人一次连发条数分位 */
  burstLen: { p50: number; p80: number; p90: number }
  /** 连发内部相邻两条的间隔（秒） */
  burstGapSec: { p25: number; p50: number; p75: number; p90: number }
  /** 连发期间的打字速度（字/秒，已剔除异常间隔） */
  typingCps: number
  /** 本人消息含 emoji 的比例 */
  emojiRate: number
  /** 高频 emoji（降序） */
  emojis: string[]
  /** ≤3 字短句占比 */
  shortRate: number
  /** 高频口头语（降序） */
  fillers: string[]
  /** 24 小时活跃度，按峰值归一化 0~1 */
  hourRatio: number[]
  /** 对方一轮（连发合并）被本人在 5 分钟内回复的比例 */
  replyRate: number
  /** 经验反应延迟桶（毫秒上限 + 权重） */
  reactBuckets: { upToMs: number; weight: number }[]
  /** 24 小时绝对回复率（样本不足的小时用整体率） */
  hourlyReply: number[]
  /** 对话状态回复率（距上次本人发言 <1min / 1-5min / 5-30min / >30min） */
  stateReply: { active: number; semi: number; cold: number; veryCold: number }
  /** 对方连发 1-2 条 / 10+ 条的回复率（用于长连发惩罚） */
  batchReply: { short: number; long: number }
  totalText: number
  selfText: number
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
const safe = (v: number, fallback = 0) => (Number.isFinite(v) ? v : fallback)
const round2 = (v: number) => Math.round(v * 100) / 100
const hh = (h: number) => `${String(((h % 24) + 24) % 24).padStart(2, '0')}:00`

/** 找出 24 小时里最长的低活跃连续区间（支持跨零点），用于 quietHours */
function longestLowBlock(ratios: number[], threshold: number): string {
  const n = 24
  const low = Array.from({ length: n }, (_, i) => safe(ratios[i], 1) < threshold)
  let bestStart = -1
  let bestLen = 0
  for (let start = 0; start < n; start++) {
    if (!low[start]) continue
    let len = 0
    while (len < n && low[(start + len) % n]) len++
    if (len > bestLen) {
      bestLen = len
      bestStart = start
    }
  }
  if (bestStart < 0) return '03:00-08:00'
  if (bestLen >= n) return '00:00-00:00'
  return `${hh(bestStart)}-${hh(bestStart + bestLen)}`
}

/** 低活跃但未静默的时段 → 犯困区间（概率随活跃度降低而升高） */
function drowsyRanges(
  ratios: number[],
  lo: number,
  hi: number,
): { start: string; end: string; prob: number }[] {
  const n = 24
  const drowsy = Array.from({ length: n }, (_, i) => {
    const r = safe(ratios[i], 1)
    return r >= lo && r < hi ? r : null
  })
  const out: { start: string; end: string; prob: number }[] = []
  let i = 0
  while (i < n) {
    if (drowsy[i] === null) {
      i++
      continue
    }
    let j = i
    let sum = 0
    while (j < n && drowsy[j] !== null) {
      sum += drowsy[j] as number
      j++
    }
    const avg = sum / (j - i)
    out.push({ start: hh(i), end: hh(j), prob: round2(clamp(0.7 * (1 - avg), 0.15, 0.8)) })
    i = j
  }
  return out
}

/**
 * 从统计数据构建画像覆盖（A~E 维）。
 * 只覆盖能从数据可靠推出的字段；cooldown / typo / echo / 私聊概率保持 env。
 * 所有值都做合理区间收敛，避免脏数据把 bot 调成秒回/话痨/静默。
 */
export function buildProfileFromStats(stats: MinedStats): HumanlikeProfileOverride {
  const lat = stats.replyLatencySec
  const reactMin = clamp(Math.round(safe(lat.p10) * 1000), 1500, 6000)
  const reactMax = clamp(Math.round(safe(lat.p90) * 1000), reactMin + 2000, 20000)

  const cps = clamp(safe(stats.typingCps), 2, 8)
  const cpsMin = clamp(Math.round(cps * 0.8), 2, 10)
  const cpsMax = Math.max(cpsMin + 1, clamp(Math.round(cps * 1.5), 3, 14))

  const segMin = clamp(Math.round(safe(stats.burstGapSec.p25) * 1000), 300, 5000)
  const segMax = clamp(Math.round(safe(stats.burstGapSec.p75) * 1000), segMin + 300, 15000)
  const maxSeg = 0
  const maxChars = 0
  const maxSegmentChars = 0

  const overall = safe(stats.replyRate, 0.9) || 0.9
  const hourly = (stats.hourlyReply.length === 24 ? stats.hourlyReply : []).map(r =>
    round2(clamp(safe(r, overall) / overall, 0.2, 1.05)),
  )
  const batchFactor =
    stats.batchReply.short > 0
      ? clamp(stats.batchReply.long / stats.batchReply.short, 0.5, 1)
      : 0.85

  return {
    react: { minMs: reactMin, maxMs: reactMax, distribution: stats.reactBuckets },
    typing: {
      charsPerSec: { min: cpsMin, max: cpsMax },
      segGap: { minMs: segMin, maxMs: segMax },
      maxSegments: maxSeg,
    },
    style: {
      maxChars,
      maxSegmentChars,
      emojiProb: round2(clamp(safe(stats.emojiRate) * 1.5, 0.01, 0.2)),
      emojis: stats.emojis.slice(0, 6),
      fillerProb: round2(clamp(safe(stats.shortRate) * 0.8, 0, 0.35)),
      fillers: stats.fillers.slice(0, 8),
    },
    schedule: {
      quietHours: longestLowBlock(stats.hourRatio, 0.03),
      drowsy: drowsyRanges(stats.hourRatio, 0.03, 0.2),
    },
    replyProb: {
      group: round2(clamp(overall, 0.25, 0.95)),
      state: {
        enabled: true,
        applyToPrivate: false,
        activeWithinMs: 60_000,
        active: round2(clamp(safe(stats.stateReply.active, 0.95), 0.3, 1)),
        semiWithinMs: 300_000,
        semi: round2(clamp(safe(stats.stateReply.semi, 0.85), 0.25, 1)),
        coldWithinMs: 1_800_000,
        cold: round2(clamp(safe(stats.stateReply.cold, 0.6), 0.2, 1)),
        veryCold: round2(clamp(safe(stats.stateReply.veryCold, 0.54), 0.2, 1)),
      },
      hourly,
      batchPenalty: { threshold: 10, factor: round2(batchFactor) },
    },
  }
}

/** 按对话状态取回复概率（elapsedMs=距上次本人发言；fallback=state 关闭时用） */
export function stateReplyProb(elapsedMs: number, fallback: number): number {
  const st = config.humanlike.replyProb.state
  if (!st.enabled) return fallback
  if (elapsedMs <= st.activeWithinMs) return st.active
  if (elapsedMs <= st.semiWithinMs) return st.semi
  if (elapsedMs <= st.coldWithinMs) return st.cold
  return st.veryCold
}

/** 按经验分布采样一次反应延迟（毫秒），无分布时退回均匀 min~max */
export function sampleReactMs(): number {
  const r = config.humanlike.react
  const dist = r.distribution
  if (!dist.length) return Math.round(r.minMs + Math.random() * Math.max(0, r.maxMs - r.minMs))
  const total = dist.reduce((s, d) => s + d.weight, 0)
  if (total <= 0) return Math.round(r.minMs)
  let x = Math.random() * total
  let prev = r.minMs
  for (const d of dist) {
    if (x <= d.weight) {
      const lo = Math.min(Math.max(prev, r.minMs), r.maxMs)
      const hi = Math.max(lo, Math.min(d.upToMs, r.maxMs))
      return Math.round(lo + Math.random() * (hi - lo))
    }
    x -= d.weight
    prev = Math.max(prev, d.upToMs)
  }
  return Math.round(r.maxMs)
}

/** 超长单条在标点/空格处再拆，避免一条发一大段（按码点，不会切坏 emoji） */
export function splitLongSegment(line: string, maxChars: number): string[] {
  if (maxChars <= 0) return [line]
  const chars = [...line]
  if (chars.length <= maxChars) return [line]
  const out: string[] = []
  let start = 0
  while (start < chars.length) {
    let end = Math.min(start + maxChars, chars.length)
    if (end < chars.length) {
      // 回退到窗口内最后一个标点/空格，尽量不切在词中间
      for (let i = end - 1; i > start + Math.floor(maxChars / 2); i--) {
        if (/[，。！？、；：,.!?;:\s]/.test(chars[i])) {
          end = i + 1
          break
        }
      }
    }
    const seg = chars.slice(start, end).join('').trim()
    if (seg) out.push(seg)
    start = end
  }
  return out.length ? out : [line]
}

// ── 工具 ────────────────────────────────────────────────────────────────────
const pick = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)]
const chance = (p: number): boolean => Math.random() < p

export interface StyleBias {
  emojiProb?: number
  fillerProb?: number
  typoProb?: number
  echoProb?: number
  maxChars?: number
}

/**
 * 对 LLM 输出的回复做"话术风格"轻量后处理（D 维）。
 * 只做小概率修饰与收敛，不改内容、不抢 LLM 的语境。
 * @param reply LLM 原始输出
 * @param ctx 对方消息上下文（用于 echo 回敬关键词，可空）
 * @param bias 近期状态带来的风格偏置（概率/长度），不传则用 env 配置
 */
export function applyStyle(reply: string, ctx?: string, bias?: StyleBias): string {
  const st = config.humanlike.style
  if (!reply.trim()) return reply
  const emojiProb = bias?.emojiProb ?? st.emojiProb
  const fillerProb = bias?.fillerProb ?? st.fillerProb
  const typoProb = bias?.typoProb ?? st.typoProb
  const echoProb = bias?.echoProb ?? st.echoProb
  const maxChars = bias?.maxChars ?? st.maxChars
  let out = reply
  const lines = out.split('\n')
  const lastNonBlankIdx = (() => {
    for (let i = lines.length - 1; i >= 0; i--) if (lines[i].trim()) return i
    return -1
  })()

  // 1) 句尾偶发表情
  if (chance(emojiProb) && st.emojis.length && lastNonBlankIdx >= 0) {
    const i = lastNonBlankIdx
    // 该行已以表情符号结尾则不再加
    if (!/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]$/u.test(lines[i].trim())) {
      lines[i] = lines[i].trimEnd() + (lines[i].trimEnd().endsWith('。') || lines[i].trimEnd().endsWith(' ') ? '' : '') + pick(st.emojis)
    }
    out = lines.join('\n')
  }

  // 2) 开头插入语气词（口头禅）
  if (chance(fillerProb) && st.fillers.length) {
    const head = out.trimStart()
    const pad = out.slice(0, -head.length)
    const filler = pick(st.fillers)
    const sep = /^[A-Za-z0-9]/.test(filler) ? ' ' : ''
    out = pad + filler + sep + head
  }

  // 3) 偶尔错别字（只替换一处，避免满屏违和）
  if (chance(typoProb) && st.typoMap.length) {
    for (const { from, to } of st.typoMap) {
      if (out.includes(from)) {
        out = out.replace(from, to)
        break
      }
    }
  }

  // 4) 长度收敛：0=不限；否则超 maxChars 截断到句子边界 + 省略号
  if (maxChars > 0 && out.length > maxChars) {
    const slice = out.slice(0, maxChars)
    const cutAt = Math.max(
      slice.lastIndexOf('。'), slice.lastIndexOf('！'), slice.lastIndexOf('？'),
      slice.lastIndexOf('\n'),
    )
    out = (cutAt > maxChars * 0.5 ? slice.slice(0, cutAt + 1) : slice) + '……'
  }

  // 5) 回敬对方关键词（复读/接话）
  if (chance(echoProb) && ctx) {
    const kw = lastWord(ctx)
    if (kw && kw.length >= 2 && !out.includes(kw)) {
      out = out.trimEnd() + `，就你说的${kw}呗`
    }
  }

  return out
}

/** 从对方消息取"最后一个像词的片段"（中文取尾词，可能含标点）。简单启发式 */
export function lastWord(ctx: string): string {
  const m = /:([^:\n]*)$/.exec(ctx.trim())
  const tail = (m ? m[1] : ctx).trim().replace(/[，。！？!?,.…\s]+$/u, '')
  // 取尾部 2~6 字（整句最后"词"）
  return tail.slice(-6)
}

/** 机制词（暴露"我在查记忆/调工具"的人机痕迹）。真人只说"记不清了/忘了"，不说"翻了翻记忆"。 */
const MECHANISM_RE =
  /(翻.{0,3}记忆|检索|查(了?查|一下|了)?记忆|搜(了?搜|一下|了)?记忆|记忆库|数据库|我的记忆|从记忆|根据记忆|工具调用|调用了?工具|用(了)?工具)/
const REAL_GAP = '记不清了'

/**
 * 防露馅：把回复里"我翻了翻记忆/检索/查记忆"这类机制句替换成真人说法。
 * 代码层兜底——不依赖模型遵守提示词，确保回复永远是"人话"，不暴露自己会查东西。
 */
export function replaceMechanismWords(text: string): string {
  if (!text) return text
  const parts = text.split(/(?<=[。！？!?\n])/)
  const out = parts.map(part => {
    if (!MECHANISM_RE.test(part)) return part
    const tail = part.match(/[。！？!?…\n]*$/)?.[0] || ''
    const nl = tail.includes('\n') ? '\n' : ''
    return REAL_GAP + tail.replace(/\n/g, '') + nl
  })
  return out.join('')
}