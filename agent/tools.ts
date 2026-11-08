import { config } from './config.js'
import { searchRag, searchRagBatch } from './rag.js'
import { addFact, searchFacts } from './memory.js'
import type { ToolExecutor } from './llm.js'

const STOP_BIGRAMS = new Set([
  '什么', '怎么', '为什', '这个', '那个', '一个', '没有', '还是', '不是', '可以',
  '我们', '你们', '他们', '现在', '真的', '是不', '有没', '东西', '事情', '问题',
  '时候', '今天', '明天', '昨天', '晚上', '白天',
])

/** 粗略相关性判断：中文二元组 / 英文词是否在记忆里出现，避免无关旧话乱入 */
function relevant(query: string, note: string): boolean {
  const q = query.replace(/\s+/g, '')
  const n = note.replace(/\s+/g, '')
  const grams = new Set<string>()
  for (let i = 0; i < q.length - 1; i++) {
    const g = q.slice(i, i + 2)
    if (/^[\u4e00-\u9fff]{2}$/.test(g) && !STOP_BIGRAMS.has(g)) grams.add(g)
  }
  for (const w of (q.match(/[a-zA-Z0-9_]{2,}/g) || [])) grams.add(w.toLowerCase())
  if (!grams.size) return false
  // 相关性闸门：需共享 ≥2 个不同 bigram（原 1 个太松，无关记忆会塞进来跑题；宁缺毋滥）
  let hits = 0
  for (const g of grams) if (n.includes(g)) hits++
  return hits >= 2
}

/**
 * 取一段记忆：优先查已记住的事实（remember 写入），没有再查历史语料。
 * 返回完整对话对（对方说→你接），模型看真实语境模仿；空串=没想起来。
 */
export async function searchMemoryNote(sceneKey: string, query: string, mode?: string): Promise<string> {
  const facts = searchFacts(sceneKey, query, config.rag.toolMaxItems)
  if (facts.length) return facts[0].slice(0, config.rag.factMaxChars)
  const raw = await searchRag(query, mode)
  if (!raw || !relevant(query, raw)) return ''
  // 对话对：user=对方、assistant=你（本人）。转成"对方/你"标签，模型看真实接话语境。
  // 前缀明确"多年前真实记录，只学语气、别当现在接"（防旧记忆污染当前话题）。
  return `【多年前的真实聊天记录（只学说话语气/口癖，不是现在在聊的）】\n` +
    raw.split('\n').map(l => {
      if (l.startsWith('assistant:')) return `你：${l.replace(/^assistant:\s*/, '').trim()}`
      if (l.startsWith('user:')) return `对方：${l.replace(/^user:\s*/, '').trim()}`
      return l
    }).join('\n')
}

/**
 * 批量版 searchMemoryNote：LLM 一次给多个关键词，一次召回 union。
 * 减少 ReAct 往返——不用反复"搜一个词→没翻到→换词"，一次给够上下文。
 * 每个词各走 searchRagBatch 的 union 召回，拼成一段"多年前真实记录"喂给 LLM。
 */
export async function searchMemoryNoteBatch(
  sceneKey: string, queries: string[], mode?: string,
): Promise<string> {
  const qs = [...new Set(queries.map(q => q.trim()).filter(Boolean))]
  if (!qs.length) return ''
  // 先查 facts（稳定事实，精确命中优先），任一词命中就直接给
  for (const q of qs) {
    const facts = searchFacts(sceneKey, q, config.rag.toolMaxItems)
    if (facts.length) return facts[0].slice(0, config.rag.factMaxChars)
  }
  // 批量 RAG union 召回（rag.ts searchRagBatch：多词各调 searchRag，行级去重）
  const raw = await searchRagBatch(qs, mode)
  if (!raw) return ''
  return `【多年前的真实聊天记录（只学说话语气/口癖，不是现在在聊的）】\n` +
    raw.split('\n').map(l => {
      if (l.startsWith('assistant:')) return `你：${l.replace(/^assistant:\s*/, '').trim()}`
      if (l.startsWith('user:')) return `对方：${l.replace(/^user:\s*/, '').trim()}`
      return l
    }).join('\n')
}

/** 为某个场景生成工具执行器（sceneKey 用于隔离事实记忆） */
export function createMemoryExecutors(sceneKey: string): Record<string, ToolExecutor> {
  return {
    search_past_memory: async (args: Record<string, unknown>) => {
      const q = String(args?.query ?? '').trim()
      if (!q) return '（没想起来）'
      const method = String(args?.method ?? '').trim()
      const note = await searchMemoryNote(sceneKey, q, method || undefined)
      // 直接返回真实对话对（对方说→你接），模型看语境；不再包"你隐约记得"（那是人机痕迹）
      return note || '（没想起来）'
    },
    remember: async (args: Record<string, unknown>) => {
      const fact = String(args?.fact ?? '').trim()
      if (!fact) return '（没记住）'
      addFact(sceneKey, fact.slice(0, config.rag.factMaxChars))
      return '（记住了）'
    },
  }
}

