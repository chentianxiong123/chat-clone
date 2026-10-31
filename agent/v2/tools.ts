import type { ToolExecutor, ToolSpec } from '../llm.js'
import { MEMORY_TOOLS, REPLY_TOOL, GET_STATE_TOOL, createAgentExecutors } from '../tools.js'
import { threadKey, type ThreadRef } from './types.js'

export type SendMessageFn = (thread: ThreadRef, text: string) => Promise<void>

export interface ToolContext {
  sentByTool: boolean
  sentTexts: string[]
}

export interface ToolRegistry {
  specs: ToolSpec[]
  executors: Record<string, ToolExecutor>
  context: ToolContext
}

/**
 * 统一 MCP 式工具集：记忆 + reply（攒句，_runTurn 末尾统一发送）+ get_state（按需）。
 * reply 可多次=短句分条；模型不调 reply 且无 content = 沉默。
 */
export function createToolRegistry(
  thread: ThreadRef,
  getState?: () => string,
): ToolRegistry {
  const context: ToolContext = { sentByTool: false, sentTexts: [] }
  const key = threadKey(thread)
  const executors = createAgentExecutors(key, {
    reply: async (texts) => {
      context.sentByTool = true
      context.sentTexts.push(...texts)
    },
    getState: () => (getState ? getState() : ''),
  })
  const specs: ToolSpec[] = [
    ...MEMORY_TOOLS,
    REPLY_TOOL,
    ...(getState ? [GET_STATE_TOOL] : []),
  ]
  return { specs, executors, context }
}
