/**
 * 防复读：只在外部系统（代码层）判定"新回复与近期过于相似"时跳过，绝不注入 LLM——
 * "别重复/别照抄/别老提这些词"这类提示是诱导，会让模型过度执行，已废弃。
 */
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
