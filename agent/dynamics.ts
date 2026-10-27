/** 常见虚词二元组，避免"什么/这个"制造虚假相关 */
const STOP = new Set([
  '什么', '怎么', '为什', '这个', '那个', '一个', '没有', '还是', '不是', '可以',
  '我们', '你们', '他们', '现在', '真的', '是不', '有没', '东西', '事情', '问题',
  '时候', '今天', '明天', '昨天', '晚上', '白天', '自己', '知道', '觉得', '感觉',
  '应该', '可能', '然后', '所以', '但是', '因为', '如果', '就是', '这么', '那么',
  '这样', '那样', '一样', '一点', '有点', '已经', '还有', '也是', '都是', '只是',
  '不能', '不会', '不要', '不用', '不过', '而且', '或者', '虽然', '于是', '其实',
])

/** 去掉每行开头的"昵称："，否则同一个人的名字会被误判成话题相关 */
function stripSpeakers(text: string): string {
  return text.split('\n').map(l => l.replace(/^[^\s:：]{1,20}[:：](?!\/\/)\s*/, '')).join('\n')
}

function contentGrams(text: string): Set<string> {
  const s = stripSpeakers(text).replace(/\s+/g, '')
  const out = new Set<string>()
  for (let i = 0; i + 1 < s.length; i++) {
    const g = s.slice(i, i + 2)
    if (/^[\u4e00-\u9fff]{2}$/.test(g) && !STOP.has(g)) out.add(g)
  }
  for (const w of (s.match(/[a-zA-Z0-9_]{2,}/g) || [])) out.add(w.toLowerCase())
  return out
}

/**
 * 粗略相关度 0~1：中文二元组 / 英文词的重叠系数（命中数 / 较短一方的词数）。
 * 用于"上一条 vs 下一条"是否接着聊，决定回复概率。
 */
export function relevanceScore(a: string, b: string): number {
  if (!a || !b) return 0
  const A = contentGrams(a)
  const B = contentGrams(b)
  if (!A.size || !B.size) return 0
  let hit = 0
  for (const g of A) if (B.has(g)) hit++
  if (!hit) return 0
  // 只要有一个实词重叠就视为"接着聊"（0.3 起），重叠越多分越高
  return Math.min(1, 0.3 + 0.7 * hit / Math.min(A.size, B.size))
}
