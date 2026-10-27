import type { config } from './config.js'

type AntiRepeatCfg = typeof config.humanlike.antiRepeat

/** 常见虚词二元组，避免把"什么/这个"当高频词 */
const STOP = new Set([
  '什么', '怎么', '为什', '这个', '那个', '一个', '没有', '还是', '不是', '可以',
  '我们', '你们', '他们', '现在', '真的', '是不', '有没', '东西', '事情', '问题',
  '时候', '今天', '明天', '昨天', '晚上', '白天', '自己', '知道', '觉得', '感觉',
  '应该', '可能', '然后', '所以', '但是', '因为', '如果', '就是', '这么', '那么',
  '这样', '那样', '一样', '一点', '有点', '已经', '还有', '也是', '都是', '只是',
  '不能', '不会', '不要', '不用', '不过', '而且', '或者', '虽然', '于是', '其实',
])

/** 统计最近回复里的过热词（2~3 字中文 n-gram + 英文词），按"出现在多少条回复"计频 */
export function hotWords(replies: string[], cfg: AntiRepeatCfg): string[] {
  const n = replies.length
  if (n < cfg.minCount) return []
  const freq = new Map<string, number>()
  for (const r of replies) {
    const text = r.replace(/[^\u4e00-\u9fffa-zA-Z0-9]/g, '')
    const seen = new Set<string>()
    for (let len = 2; len <= 3; len++) {
      for (let i = 0; i + len <= text.length; i++) {
        const g = text.slice(i, i + len)
        if (!/^[\u4e00-\u9fff]{2,3}$/.test(g)) continue
        if (STOP.has(g) || seen.has(g)) continue
        seen.add(g)
        freq.set(g, (freq.get(g) || 0) + 1)
      }
    }
    for (const w of (r.match(/[a-zA-Z]{3,}/g) || [])) {
      const lw = w.toLowerCase()
      if (seen.has(lw)) continue
      seen.add(lw)
      freq.set(lw, (freq.get(lw) || 0) + 1)
    }
  }
  const cand: Array<[string, number]> = []
  for (const [g, c] of freq) {
    if (c >= cfg.minCount && c / n >= cfg.ratio) cand.push([g, c])
  }
  // 频次高的优先；保留最短的根词（"剑魔"优先于"剑魔肉"）
  cand.sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)
  const kept: string[] = []
  for (const [g] of cand) {
    if (kept.some(k => g.includes(k))) continue
    kept.push(g)
  }
  return kept.slice(0, cfg.maxHint)
}

/** 生成"别重复自己"的动态提示（过热词 + 近期原话样例）；无过热词返回空串 */
export function buildAntiRepeatHint(hot: string[], recent: string[]): string {
  if (!hot.length) return ''
  const parts = ['【别重复自己】', `你最近总说这些词：${hot.join('、')}。这轮换个说法，别老提它们。`]
  const samples = recent.slice(-4)
    .map(r => r.replace(/\s+/g, ' ').trim().slice(0, 36))
    .filter(Boolean)
  if (samples.length) {
    parts.push('你最近说过（别照抄/别重复）：\n' + samples.map(s => '- ' + s).join('\n'))
  }
  return parts.join('\n')
}

function norm(s: string): string {
  return s.replace(/[\s\p{P}\p{S}]/gu, '')
}

/** 最长公共子串长度（短文本足够） */
function lcsLen(a: string, b: string): number {
  if (!a || !b) return 0
  let prev = new Array<number>(b.length + 1).fill(0)
  let best = 0
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array<number>(b.length + 1).fill(0)
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) {
        cur[j] = prev[j - 1] + 1
        if (cur[j] > best) best = cur[j]
      }
    }
    prev = cur
  }
  return best
}

/** 新回复是否与最近若干条过于相似（近重复），用于跳过复读 */
export function tooSimilar(reply: string, recent: string[], threshold: number): boolean {
  const r = norm(reply)
  if (!r) return false
  for (const p of recent.slice(-8)) {
    const q = norm(p)
    if (!q) continue
    if (lcsLen(r, q) / Math.max(r.length, q.length) >= threshold) return true
  }
  return false
}

/** 追加到近期回复窗口（保留最近 window 条） */
export function pushRecent(list: string[], reply: string, window: number): string[] {
  const next = [...list, reply].filter(s => s.trim())
  return next.slice(-window)
}
