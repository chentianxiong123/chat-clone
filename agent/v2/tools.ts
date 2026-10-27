import type { ToolExecutor, ToolSpec } from '../llm.js'
import { MEMORY_TOOLS, createMemoryExecutors } from '../tools.js'
import { threadKey, type ThreadRef } from './types.js'

export interface ToolContext {
  sentByTool: boolean
  sentTexts: string[]
}

export type SendMessageFn = (thread: ThreadRef, text: string) => Promise<void>

export interface ToolRegistry {
  specs: ToolSpec[]
  executors: Record<string, ToolExecutor>
  context: ToolContext
}

const SEND_TOOL: ToolSpec = {
  type: 'function',
  function: {
    name: 'send_message',
    description:
      '主动发送一条消息到当前会话。最终回复会自动发送，普通聊天不要调用；' +
      '只有需要额外补一句、分多条说、或明确要主动冒泡时才用。每条 text 会作为独立气泡发出。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要发送的一条消息（短句，不要带引号）' },
      },
      required: ['text'],
    },
  },
}

export function createToolRegistry(
  thread: ThreadRef,
  send: SendMessageFn,
): ToolRegistry {
  const context: ToolContext = { sentByTool: false, sentTexts: [] }
  const key = threadKey(thread)
  const memoryExecutors = createMemoryExecutors(key)

  const executors: Record<string, ToolExecutor> = {
    ...memoryExecutors,
    send_message: async (args: Record<string, unknown>) => {
      const text = String(args?.text ?? '').trim()
      if (!text) return '（没有发送：内容为空）'
      context.sentByTool = true
      context.sentTexts.push(text)
      await send(thread, text)
      return '（已发送）'
    },
  }

  return {
    specs: [...MEMORY_TOOLS, SEND_TOOL],
    executors,
    context,
  }
}
