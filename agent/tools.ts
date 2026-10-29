import { config } from './config.js'
import { searchRag } from './rag.js'
import { addFact, searchFacts } from './memory.js'
import type { ToolSpec, ToolExecutor } from './llm.js'

/** 过去指代关键词：命中则强制先检索（不依赖模型是否主动调工具） */
const RECALL_RE = /(上次|上回|之前|以前|你说过|我说过|记得|还记得|那时候|当时|是不是说过|你答应|我们聊过|前阵子|前几天)/

export function needsRecall(text: string): boolean {
  return RECALL_RE.test(text)
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
 * 取一段记忆：优先查已记住的事实（remember 写入），没有再查历史语料。
 * 返回完整对话对（对方说→你接），模型看真实语境模仿；空串=没想起来。
 */
export async function searchMemoryNote(sceneKey: string, query: string): Promise<string> {
  const facts = searchFacts(sceneKey, query, config.rag.toolMaxItems)
  if (facts.length) return facts[0].slice(0, config.rag.factMaxChars)
  const raw = await searchRag(query)
  if (!raw || !relevant(query, raw)) return ''
  // 对话对：user=对方、assistant=你（本人）。转成"对方/你"标签，模型看真实接话语境。
  return raw.split('\n').map(l => {
    if (l.startsWith('assistant:')) return `你：${l.replace(/^assistant:\s*/, '').trim()}`
    if (l.startsWith('user:')) return `对方：${l.replace(/^user:\s*/, '').trim()}`
    return l
  }).join('\n')
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

/**
 * reply 工具：模型开口说一句。可一次返回多条（一次响应里多次调用），
 * 每条就是一条消息——按工具格式分割，程序不再拆分。
 */
export const REPLY_TOOL: ToolSpec = {
  type: 'function',
  function: {
    name: 'reply',
    description:
      '开口说一句话。要说话就调用它；想分几条说就连续调用几次，每次一条消息（按条发送，不要用换行拼成一条）。' +
      '内容直接是你要对朋友说的话，像真人打字，别带序号/引号。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要说的话（一条消息，像真人打字，别带序号/引号）' },
      },
      required: ['text'],
    },
  },
}

/**
 * get_state 工具：模型按需查看自己当前状态（精力/心情/消息密度/话题等）。
 * 纯数据、无倾向指令——只有模型真在意状态时才查，避免每轮被状态牵着走。
 */
export const GET_STATE_TOOL: ToolSpec = {
  type: 'function',
  function: {
    name: 'get_state',
    description:
      '查看自己此刻的状态（精力/心情/忙碌/消息密度/距离上次说话/当前话题）。' +
      '想确认自己"现在什么状态、该不该短句或敷衍"时调用；一般闲聊不用。',
    parameters: { type: 'object', properties: {} },
  },
}

/** 工具执行器回调：reply 说一句（由 core/v2 攒句+发送），getState 返回纯数据状态 */
export interface AgentToolHooks {
  reply: (text: string) => Promise<void>
  getState: () => Promise<string> | string
}

/**
 * 统一 agent 工具集执行器：记忆 + reply + get_state。
 * 供 core（真实 QQ）与 v2（模拟）共用，只差 reply/getState 的具体实现。
 */
export function createAgentExecutors(
  sceneKey: string,
  hooks: AgentToolHooks,
): Record<string, ToolExecutor> {
  return {
    ...createMemoryExecutors(sceneKey),
    reply: async (args: Record<string, unknown>) => {
      const text = String(args?.text ?? '').trim()
      if (!text) return '（没说：内容为空）'
      await hooks.reply(text)
      return '（已说）'
    },
    get_state: async () => {
      const s = await hooks.getState()
      return s || '（状态未知）'
    },
  }
}
