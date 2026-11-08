/**
 * test/fake-stream.ts —— 假 LLM 流（mock pi 内核的 streamFn 边界）
 *
 * PiAgentSession 的 Agent 在没有真实 LLM 供应商时跑完整 ReAct 循环：
 * streamFn 必须返回 AssistantMessageEventStream（push-pull 类，createAssistantMessageEventStream()），
 * 按脚本 push 事件（toolcall_end + done），驱动 pi 内核调 search/reply 工具（工具真实跑，门禁/RAG 真查）。
 *
 * 参照 pi-retry-kit/test/fake-stream.ts 模式，但用 pi-ai 的 AssistantMessageEventStream（push 模型）。
 */
import {
  createAssistantMessageEventStream,
  type AssistantMessageEvent,
  type AssistantMessage,
  type ToolCall,
} from '@earendil-works/pi-ai'

const zeroUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} as const

/** 一条 AssistantMessage（content 块 + usage），供事件 partial 用 */
function msg(content: AssistantMessage['content'], usage?: Partial<AssistantMessage['usage']>): AssistantMessage {
  return {
    role: 'assistant',
    content: (content ?? []) as AssistantMessage['content'],
    stopReason: 'stop',
    timestamp: Date.now(),
    api: 'openai-completions',
    provider: 'fake',
    model: 'fake-model',
    usage: { ...zeroUsage, ...(usage ?? {}) } as AssistantMessage['usage'],
  } as AssistantMessage
}

function partial(m: AssistantMessage): AssistantMessage {
  return { ...m, stopReason: undefined } as AssistantMessage
}

/** 单个 tool call 的事件序列（push 进 AssistantMessageEventStream） */
export function pushToolCall(stream: ReturnType<typeof createAssistantMessageEventStream>, name: string, args: Record<string, unknown>, usage?: Partial<AssistantMessage['usage']>): void {
  const tc: ToolCall = {
    type: 'toolCall',
    id: `call_${Math.random().toString(36).slice(2, 10)}`,
    name,
    arguments: args as never,
  } as ToolCall
  const m = msg([tc] as never, usage)
  const p = partial(m)
  stream.push({ type: 'start', partial: p } as AssistantMessageEvent)
  stream.push({ type: 'toolcall_start', contentIndex: 0, partial: p } as AssistantMessageEvent)
  stream.push({ type: 'toolcall_delta', contentIndex: 0, delta: JSON.stringify(args), partial: p } as AssistantMessageEvent)
  stream.push({ type: 'toolcall_end', contentIndex: 0, toolCall: tc, partial: p } as AssistantMessageEvent)
  stream.push({ type: 'done', reason: 'toolUse', message: m } as AssistantMessageEvent)
}

/** 文本回复的事件序列 */
export function pushText(stream: ReturnType<typeof createAssistantMessageEventStream>, text: string, usage?: Partial<AssistantMessage['usage']>): void {
  const m = msg([{ type: 'text', text } as never], usage)
  const p = partial(m)
  stream.push({ type: 'start', partial: p } as AssistantMessageEvent)
  if (text) {
    stream.push({ type: 'text_start', contentIndex: 0, partial: p } as AssistantMessageEvent)
    stream.push({ type: 'text_delta', contentIndex: 0, delta: text, partial: p } as AssistantMessageEvent)
    stream.push({ type: 'text_end', contentIndex: 0, content: text, partial: p } as AssistantMessageEvent)
  }
  stream.push({ type: 'done', reason: 'stop', message: m } as AssistantMessageEvent)
}

export type StepScript = (stream: ReturnType<typeof createAssistantMessageEventStream>) => void

export interface StepBox {
  /** 当前脚本（pi 内核每次调 streamFn 时按 idx 取下一个 step） */
  steps: StepScript[]
  /** 已消费到第几个 step */
  idx: number
  /** 每次被 streamFn 调用（debug 用） */
  onCall?: () => void
}

/**
 * 假 streamFn 工厂：返回一个 StreamFn，闭包捕获 box。
 * 每次被 pi 内核调用时：
 *  - box.idx < box.steps.length：执行 box.steps[box.idx]（推事件），box.idx++
 *  - 超出：推空文本终止（pi 内核停止循环）
 */
export function fakeStreamFn(box: StepBox) {
  return ((_model: unknown, _context: unknown, _options?: unknown) => {
    box.onCall?.()
    const stream = createAssistantMessageEventStream()
    if (box.idx < box.steps.length) {
      const step = box.steps[box.idx]
      box.idx++
      try { step(stream) } catch { /* step 异常 → 沉默终止 */ }
    } else {
      pushText(stream, '')
    }
    return stream
  }) as never
}
