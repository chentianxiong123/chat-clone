/**
 * pi AgentTool 版工具集：把 chat-clone 现有效果（记忆召回/记住/回复/状态）转成 pi 的 AgentTool。
 * 与 tools.ts（ToolSpec 版）并存，v2 换 pi 内核后使用本文件；v1 删除后 tools.ts 可清。
 */
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { config } from './config.js'
import { searchMemoryNote, createMemoryExecutors } from './tools.js'
import { AgentToolHooks } from './tools.js'

/** 把 ToolSpec 风格参数 + execute 组装成 pi AgentTool */
function makeTool(
  name: string,
  description: string,
  parameters: Record<string, unknown>,
  execute: AgentTool<object>['execute'],
): AgentTool<object> {
  return { name, label: name, description, parameters, execute }
}

/** 为某个场景生成 pi AgentTool[]（sceneKey 用于隔离事实记忆进来） */
export function createPiTools(sceneKey: string, hooks: AgentToolHooks): AgentTool<object>[] {
  const mem = createMemoryExecutors(sceneKey)

  const searchPastMemory: AgentTool<{ query: string; method?: string }> = makeTool(
    'search_past_memory',
    '查本人和朋友**多年前**真实聊过的话、用过的说法/口癖/梗（历史聊天知识库）。' +
      '拿不准怎么说时可**多次调用**：每次换更聚焦的关键词，逐步逼近想找的说法，像翻旧聊天记录一样。' +
      '查到的是多年旧记录，只用来学说话语气、回忆旧事，别照抄、别当成现在在聊的话。',
    {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要回忆的关键词或问题，例如"上次说要买的耳机"' },
        method: {
          type: 'string',
          enum: ['auto', 'all', 'random', 'vec', 'fts', 'like'],
          description:
            '召回方式（可选）：all=三路一起召回；random=随机挑一路；' +
            'vec/fts/like=指定某一路；auto=默认（向量优先+回退）。不填用系统配置。',
        },
      },
      required: ['query'],
    },
    async (_id, params) => {
      const q = (params?.query ?? '').trim()
      if (!q) return { content: [{ type: 'text', text: '（没想起来）' }], details: {} }
      const method = (params?.method ?? '').trim()
      const note = await searchMemoryNote(sceneKey, q, method || undefined)
      return { content: [{ type: 'text', text: note || '（没想起来）' }], details: {} }
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
      '内容直接是你要对朋友说的话，别带序号/引号。',
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