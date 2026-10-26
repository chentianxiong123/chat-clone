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

/**
 * 从统计数据构建画像覆盖。
 * 当前为骨架：接口就位，数据挖掘实现见下阶段（导入原始库 → 输出 HumanlikeProfileOverride）。
 * TODO(data-profile): 实现各字段统计算法（见文件头蓝图）
 */
export function buildProfileFromStats(rawStats: unknown): HumanlikeProfileOverride {
  // TODO: rawStats 为标准化的统计组（时间戳/长度/词频/应答比等），
  // 计算后返回 HumanlikeProfileOverride 覆盖 env 默认值。
  void rawStats
  return {}
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
    out = pad + pick(st.fillers) + (head.startsWith(' ') ? '' : ' ') + head
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