// 校验 RAG 搜索在无向量情况下（vec 不可用）的 fts/like 命中质量
import { ragSearch, ragStatus } from './rag.js'

const status = await ragStatus()
console.log('=== RAG 状态 ===')
console.log('vecLoaded:', status.vecLoaded, '(sqlite-vec 扩展是否加载成功)')
console.log('ftsOk:', status.ftsOk, '(FTS5 是否可用)')
console.log('embedOk:', status.embedOk, '(embed 端点是否配置)')
console.log('strategy:', status.strategy.join(','))
console.log('enabledModes:', status.enabledModes.join(','), '(实际能跑的路)')
console.log('dbPath:', status.dbPath, '| chunks:', status.count)
console.log()

// 实测几个真实聊天 query（都是"没有向量"场景下，看 fts/like 能不能搜到相近旧记录）
const queries = [
  '电脑又蓝屏了 烦死',
  '天天加班 好累',
  '想去看电影 有啥推荐',
  '机械键盘 茶轴 声音大',
  '上次说买耳机 买了没',
  '周末有安排没',
]
for (const q of queries) {
  const res = await ragSearch(q)
  const fts = res.fts.slice(0, 2)
  const like = res.like.slice(0, 2)
  const vec = res.vec.length
  console.log(`── query:「${q}」`)
  console.log(`  vec: ${vec}条 | fts: ${res.fts.length}条 | like: ${res.like.length}条 | usedEmbed: ${res.usedEmbed}`)
  for (const h of fts) {
    const first = h.text.split('\n').find(l => l.includes('assistant:')) || h.text.split('\n')[0]
    console.log(`  [fts ${h.score.toFixed(2)}] ${first.slice(0, 50)}`)
  }
  for (const h of like) {
    const first = h.text.split('\n').find(l => l.includes('assistant:')) || h.text.split('\n')[0]
    console.log(`  [like ${h.score.toFixed(2)}] ${first.slice(0, 50)}`)
  }
  console.log()
}
