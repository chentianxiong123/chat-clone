/**
 * pi AgentTool 版工具集 + search 硬闸门（ReAct 强制检索）：
 * 把 chat-clone 现有效果（记忆召回/记住/回复/状态）转成 pi 的 AgentTool。
 *
 * 闸门设计（用户决策：坚决疯狂调工具搜索，必须搜到跟话题相近的才许回复，绝对不能贸然回复）：
 *   - search_past_memory 每次调用都把搜到的旧记录记进 gate.searchLog
 *   - reply 工具被门禁拦截：
 *       ① 一次 search 都没调过              → 拒绝「你没翻过旧记录，先 search 再回」
 *       ② 搜到的旧记录跟当前话题关键词不重合 → 拒绝「搜到的跟现在话题不沾边，换关键词再搜」
 *       ③ 搜到相近话题                      → 放行 hooks.reply
 *   - 模型被迫"疯狂搜索"：每被拒一次就再 search 一次，直到搜到相近才许开口；搜不到就沉默。
 * 与 tools.ts（ToolSpec 版）并存，v2 换 pi 内核后使用本文件；v1 删除后 tools.ts 可清。
 */
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { config } from './config.js'
import { searchMemoryNote, searchMemoryNoteBatch, createMemoryExecutors } from './tools.js'

/** 把 ToolSpec 风格参数 + execute 组装成 pi AgentTool */
function makeTool(
  name: string,
  description: string,
  parameters: Record<string, unknown>,
  execute: AgentTool<object>['execute'],
): AgentTool<object> {
  return { name, label: name, description, parameters, execute }
}

/**
 * search 硬闸门共享对象（可变，闭包引用；runOnce 时重置/更新）。
 * - userContent：当前要接的那句（相关性参照，runOnce 注入）
 * - searchLog：本会话 search 过的实际旧记录（空串"没想起来"不记）
 * - searchCount：搜了几次
 */
export interface SearchGate {
  userContent: string
  searchLog: string[]
  searchCount: number
}

export function createGate(): SearchGate {
  return { userContent: '', searchLog: [], searchCount: 0 }
}

/** 单轮 search 硬上限：防"疯狂搜索"变死循环（pi 内核无内置轮数限制）。超过后 search 短路，提示沉默 */
const MAX_SEARCHES = 8

const STOP_BIGRAMS = new Set([
  '什么', '怎么', '为什', '这个', '那个', '一个', '没有', '还是', '不是', '可以',
  '我们', '你们', '他们', '现在', '真的', '是不', '有没', '东西', '事情', '问题',
  '时候', '今天', '明天', '昨天', '晚上', '白天',
])

/** 提取关键词 bigram（中文二元组 + 英文/数字词），去停用词 */
function extractGrams(s: string): Set<string> {
  const q = s.replace(/\s+/g, '')
  const grams = new Set<string>()
  for (let i = 0; i < q.length - 1; i++) {
    const g = q.slice(i, i + 2)
    if (/^[\u4e00-\u9fff]{2}$/.test(g) && !STOP_BIGRAMS.has(g)) grams.add(g)
  }
  for (const w of q.match(/[a-zA-Z0-9_]{2,}/g) || []) grams.add(w.toLowerCase())
  return grams
}

/** 当前 user 话题的关键词 bigram，跟 searchLog 里某条旧记录重合 ≥2 即算"搜到相近话题" */
function gateRelevant(gate: SearchGate): boolean {
  const topicGrams = extractGrams(gate.userContent)
  if (!topicGrams.size) return false
  for (const log of gate.searchLog) {
    const logGrams = extractGrams(log)
    let hits = 0
    for (const g of topicGrams) if (logGrams.has(g)) hits++
    if (hits >= 2) return true
  }
  return false
}

/** 为某个场景生成 pi AgentTool[]（sceneKey 用于隔离事实记忆；gate 注入 search 硬闸门） */
export function createPiTools(sceneKey: string, hooks: AgentToolHooks, gate: SearchGate): AgentTool<object>[] {
  const mem = createMemoryExecutors(sceneKey)

  const searchPastMemory: AgentTool<{ queries?: string[]; query?: string; method?: string }> = makeTool(
    'search_past_memory',
    '查本人和朋友**多年前**真实聊过的话、用过的说法/口癖/梗（历史聊天知识库）。' +
      '**回复前必须先搜**：拿到话题就搜，一次搜尽量多给几个贴当前话题的关键词（批量，别反复单搜），翻到相近旧记录才开口。' +
      '查到的是多年旧记录，只用来学说话语气、回忆旧事，别照抄、别当成现在在聊的话。',
    {
      type: 'object',
      properties: {
        queries: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          maxItems: 6,
          description: '要回忆的关键词列表（**批量**，一次给 2~5 个贴当前话题的词）。例如对方说"加班累死了"就传 ["加班","累死了","休息","打胶"]。每个词各召回一段，合并去重后一次给够上下文。',
        },
        query: {
          type: 'string',
          description: '（兼容单值）只搜一个词时用；优先用 queries 批量。',
        },
        method: {
          type: 'string',
          enum: ['auto', 'all', 'random', 'vec', 'fts', 'like'],
          description:
            '召回方式（可选）：all=三路一起召回；random=随机挑一路；' +
            'vec/fts/like=指定某一路；auto=默认（向量优先+回退）。不填用系统配置。',
        },
      },
    },
    async (_id, params) => {
      // 批量 queries[] 优先；兼容单 query
      const qs = [
        ...(Array.isArray(params?.queries) ? params.queries : []),
        ...(params?.query ? [params.query] : []),
      ].map(s => String(s ?? '').trim()).filter(Boolean)
      const q = qs[0] ?? ''
      if (!q) return { content: [{ type: 'text', text: '（没想起来）' }], details: {} }
      // 防死循环：search 超过上限就短路，提示凭印象回（不死搜）
      if (gate.searchCount >= MAX_SEARCHES) {
        return {
          content: [{
            type: 'text',
            text: `【已翻了 ${gate.searchCount} 遍旧记录，没翻到跟现在话题特别相近的。别再搜了——凭印象直接回一句（像真人凭感觉说话，不一定跟旧记录一模一样），或者沉默。】`,
          }],
          details: {},
        }
      }
      const method = (params?.method ?? '').trim()
      const note = await searchMemoryNoteBatch(sceneKey, qs, method || undefined)
      gate.searchCount++
      // 只有搜到实际旧记录才记进闸门（"没想起来"不算搜到相关）
      if (note && note !== '（没想起来）') gate.searchLog.push(note)
      const hint = note
        ? note + '\n【已翻到跟话题相关的旧记录，可以照着味道回。没相关的话换个关键词再搜；实在翻不到就近凭印象回。】'
        : `（没想起来：这次 ${qs.length} 个关键词都没搜到贴话题的旧记录。换更贴当前话题的关键词再 search 一次；搜到上限还没翻到就凭印象回一句，别死搜）`
      return { content: [{ type: 'text', text: hint }], details: {} }
    },
  )

  const remember: AgentTool<{ fact: string }> = makeTool(
    'remember',
    '记住关于朋友的稳定事实、喜好、约定或重要信息（一句话，尽量简短）。' +
      '听到值得长期记住的事就调用，比如对方的喜好、计划、约定。',
    {
      type: 'object',
      properties: { fact: { type: 'string', description: '要记住的一句话事实' } },
      required: ['fact'],
    },
    async (_id, params) => {
      const fact = (params?.fact ?? '').trim()
      if (!fact) return { content: [{ type: 'text', text: '（没记住）' }], details: {} }
      mem.remember({ fact: fact.slice(0, config.rag.factMaxChars) })
      return { content: [{ type: 'text', text: '（记住了）' }], details: {} }
    },
  )

  const reply: AgentTool<{ messages: string[] }> = makeTool(
    'reply',
    '开口说话。把你要发的所有消息一次性放进 messages 数组，发几条你自己定（1 条就 1 个元素）。' +
      `最多 ${config.agent.replyMaxSegments} 条；通常很短，像真人发群消息，别堆、别长篇解释。` +
      '内容直接是你要对朋友说的话，别带序号/引号。**没搜到跟现在话题相近的旧记录前，别调这个**。',
    {
      type: 'object',
      properties: {
        messages: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          maxItems: config.agent.replyMaxSegments,
          description: '按顺序发送的每条消息，一条一个元素，通常很短（几个字到一两句）。',
        },
      },
      required: ['messages'],
    },
    async (_id, params) => {
      const raw = params?.messages
      const texts = (Array.isArray(raw) ? raw : raw == null ? [] : [raw])
        .map((t) => String(t ?? '').trim())
        .filter(Boolean)
      if (!texts.length) return { content: [{ type: 'text', text: '（没说：内容为空）' }], details: {} }
       // ── 硬闸门：没翻旧记录 / 翻到的不相关 → 拒绝放行，逼模型继续搜；搜到上限没翻到相近的→放行凭印象 ──
       if (gate.searchCount === 0) {
         return {
           content: [{
             type: 'text',
             text: '【拦截：你一次都没翻旧记录（search_past_memory），不能贸然回复。先搜当前话题（例如对方说"加班"就搜"加班/累/休息/打胶"），搜到相近的旧记录再开口。搜不到就沉默，别硬接。】',
           }],
           details: {},
         }
       }
       // search 已翻到上限（MAX_SEARCHES）：不硬拦了，放行让模型凭印象回（或沉默）
       if (gate.searchCount >= MAX_SEARCHES) {
         await hooks.reply(texts)
         return { content: [{ type: 'text', text: '（已说）' }], details: {} }
       }
       if (!gateRelevant(gate)) {
         return {
           content: [{
             type: 'text',
             text: `【拦截：你搜到的旧记录（${gate.searchLog.length}条）跟现在的话题关键词都对不上，不相关。换个更贴当前话题的关键词再 search 一次，翻到相近的再回；翻不到相近的就凭印象回一句或沉默，别拿不相关的旧话乱接。】`,
           }],
           details: {},
         }
       }
      // 通过闸门：真的搜到相近话题了，放行
      await hooks.reply(texts)
      return { content: [{ type: 'text', text: '（已说）' }], details: {} }
    },
  )

  const getState: AgentTool<object> = makeTool(
    'get_state',
    '查看自己此刻的状态（精力/心情/忙碌/消息密度/距离上次说话/当前话题）。' +
      '想确认自己"现在什么状态、该不该短句或敷衍"时调用；一般闲聊不用。',
    { type: 'object', properties: {} },
    async () => {
      const s = await hooks.getState()
      return { content: [{ type: 'text', text: s || '（状态未知）' }], details: {} }
    },
  )

  const tools: AgentTool<object>[] = [searchPastMemory, remember, reply]
  if (config.agent.getStateEnabled) tools.push(getState)
  return tools
}
