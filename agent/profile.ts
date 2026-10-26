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
  burst: Partial<HumanlikeProfile['burst']>
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
  const reactMin = clamp(Math.round(safe(lat.p10) * 1000), 2000, 6000)
  const reactMax = clamp(Math.round(safe(lat.p90) * 1000), reactMin + 2000, 20000)

  const cps = clamp(safe(stats.typingCps), 2, 8)
  const cpsMin = clamp(Math.round(cps * 0.8), 2, 10)
  const cpsMax = Math.max(cpsMin + 1, clamp(Math.round(cps * 1.5), 3, 14))

  const segMin = clamp(Math.round(safe(stats.burstGapSec.p25) * 1000), 300, 5000)
  const segMax = clamp(Math.round(safe(stats.burstGapSec.p75) * 1000), segMin + 300, 15000)
  const maxSeg = clamp(Math.round(safe(stats.burstLen.p90)), 2, 6)
  const maxChars = clamp(Math.round(safe(stats.turnChars.p90) * 1.2), 60, 240)

  return {
    react: { minMs: reactMin, maxMs: reactMax },
    typing: {
      charsPerSec: { min: cpsMin, max: cpsMax },
      segGap: { minMs: segMin, maxMs: segMax },
      maxSegments: maxSeg,
    },
    style: {
      maxChars,
      emojiProb: round2(clamp(safe(stats.emojiRate) * 1.5, 0.01, 0.2)),
      emojis: stats.emojis.slice(0, 6),
      fillerProb: round2(clamp(safe(stats.shortRate) * 0.8, 0, 0.35)),
      fillers: stats.fillers.slice(0, 8),
    },
    schedule: {
      quietHours: longestLowBlock(stats.hourRatio, 0.03),
      drowsy: drowsyRanges(stats.hourRatio, 0.03, 0.2),
    },
    replyProb: { group: round2(clamp(safe(stats.replyRate), 0.25, 0.95)) },
    burst: { maxReplies: clamp(Math.round(safe(stats.burstLen.p90)), 2, 6) },
  }
}

// ── 工具 ────────────────────────────────────────────────────────────────────
const pick = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)]
const chance = (p: number): boolean => Math.random() < p

/**
 * 对 LLM 输出的回复做"话术风格"轻量后处理（D 维）。
 * 只做小概率修饰与收敛，不改内容、不抢 LLM 的语境。
 * @param reply LLM 原始输出
 * @param ctx 对方消息上下文（用于 echo 回敬关键词，可空）
 */
export function applyStyle(reply: string, ctx?: string): string {
  const st = config.humanlike.style
  if (!reply.trim()) return reply
  let out = reply
  const lines = out.split('\n')
  const lastNonBlankIdx = (() => {
    for (let i = lines.length - 1; i >= 0; i--) if (lines[i].trim()) return i
    return -1
  })()

  // 1) 句尾偶发表情
  if (chance(st.emojiProb) && st.emojis.length && lastNonBlankIdx >= 0) {
    const i = lastNonBlankIdx
    // 该行已以表情符号结尾则不再加
    if (!/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]$/u.test(lines[i].trim())) {
      lines[i] = lines[i].trimEnd() + (lines[i].trimEnd().endsWith('。') || lines[i].trimEnd().endsWith(' ') ? '' : '') + pick(st.emojis)
    }
    out = lines.join('\n')
  }

  // 2) 开头插入语气词（口头禅）
  if (chance(st.fillerProb) && st.fillers.length) {
    const head = out.trimStart()
    const pad = out.slice(0, -head.length)
    const filler = pick(st.fillers)
    const sep = /^[A-Za-z0-9]/.test(filler) ? ' ' : ''
    out = pad + filler + sep + head
  }

  // 3) 偶尔错别字（只替换一处，避免满屏违和）
  if (chance(st.typoProb) && st.typoMap.length) {
    for (const { from, to } of st.typoMap) {
      if (out.includes(from)) {
        out = out.replace(from, to)
        break
      }
    }
  }

  // 4) 长度收敛：超 maxChars 截断到句子边界 + 省略号（防小作文）
  if (out.length > st.maxChars) {
    const slice = out.slice(0, st.maxChars)
    const cutAt = Math.max(
      slice.lastIndexOf('。'), slice.lastIndexOf('！'), slice.lastIndexOf('？'),
      slice.lastIndexOf('\n'),
    )
    out = (cutAt > st.maxChars * 0.5 ? slice.slice(0, cutAt + 1) : slice) + '……'
  }

  // 5) 回敬对方关键词（复读/接话）
  if (chance(st.echoProb) && ctx) {
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