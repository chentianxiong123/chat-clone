import { config } from './config.js'
import { searchRag } from './rag.js'
import { addFact, searchFacts } from './memory.js'
import type { ToolSpec, ToolExecutor } from './llm.js'

/** 过去指代关键词：命中则强制先检索（不依赖模型是否主动调工具） */
const RECALL_RE = /(上次|上回|之前|以前|你说过|我说过|记得|还记得|那时候|当时|是不是说过|你答应|我们聊过|前阵子|前几天)/

export function needsRecall(text: string): boolean {
  return RECALL_RE.test(text)
}

/** 把 RAG 结果压成一句极短的"印象"（≤60 字），防止淹没主上下文 */
function compactNote(raw: string): string {
  if (!raw) return ''
  const first = raw.split('\n--\n').map(s => s.trim()).filter(Boolean)[0] || ''
  const s = first.replace(/\s+/g, ' ').trim()
  const max = config.rag.factMaxChars
  return s.length > max ? s.slice(0, max) + '…' : s
}

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
  for (const g of grams) if (n.includes(g)) return true
  return false
}

/**
 * 取一条记忆：优先查已记住的事实（remember 写入），没有再查历史语料。
 * 返回空串表示没想起来（含相关性不足的情况，宁可不想起也不乱入）。
 */
export async function searchMemoryNote(sceneKey: string, query: string): Promise<string> {
  const facts = searchFacts(sceneKey, query, config.rag.toolMaxItems)
  if (facts.length) return facts[0].slice(0, config.rag.factMaxChars)
  const raw = await searchRag(query)
  const note = compactNote(raw)
  if (!note || !relevant(query, note)) return ''
  return note
}

export const MEMORY_TOOLS: ToolSpec[] = [
  {
    type: 'function',
    function: {
      name: 'search_past_memory',
      description:
        '回忆你和朋友过去真实发生过的事、说过的话。当话题涉及过去（对方提到"上次/之前/你说过/记得"等），' +
        '或你需要确认某件往事时，优先调用它。普通闲聊不要调用。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '要回忆的关键词或问题，例如"上次说要买的耳机"' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remember',
      description:
        '记住关于朋友的稳定事实、喜好、约定或重要信息（一句话，尽量简短）。' +
        '听到值得长期记住的事就调用，比如对方的喜好、计划、约定。',
      parameters: {
        type: 'object',
        properties: {
          fact: { type: 'string', description: '要记住的一句话事实' },
        },
        required: ['fact'],
      },
    },
  },
]

/** 为某个场景生成工具执行器（sceneKey 用于隔离事实记忆） */
export function createMemoryExecutors(sceneKey: string): Record<string, ToolExecutor> {
  return {
    search_past_memory: async (args: Record<string, unknown>) => {
      const q = String(args?.query ?? '').trim()
      if (!q) return '（没想起来）'
      const note = await searchMemoryNote(sceneKey, q)
      return note ? `（你隐约记得：${note}）` : '（没想起来）'
    },
    remember: async (args: Record<string, unknown>) => {
      const fact = String(args?.fact ?? '').trim()
      if (!fact) return '（没记住）'
      addFact(sceneKey, fact.slice(0, config.rag.factMaxChars))
      return '（记住了）'
    },
  }
}
