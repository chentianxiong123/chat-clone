/**
 * pi Agent 封装：每会话一个实例，live 上下文 = agent.state.messages（pi 内存维护）。
 * runOnce：喂一条 user → pi 跑完整 LLM+工具循环 → 收集 reply 工具攒句 或 assistant 文本 → 返回 segments（空=沉默）。
 */
import { Agent } from '@earendil-works/pi-agent-core'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import { calculateCost } from '@earendil-works/pi-ai'
import { getPiModel, getPiStreamFn } from './pi-provider.js'
import { buildSystemPrompt } from './prompt.js'
import { createPiTools, createGate, type SearchGate } from './pi-tools.js'
import { config } from './config.js'

export interface PiRunResult {
  /** 要发的话（一条=一段；空=沉默） */
  segments: string[]
  /** 是否走了 reply 工具 */
  sentByTool: boolean
  /** 最终 assistant 文本（未走 reply 工具时的兜底话语） */
  assistantText: string
  /** 本轮工具调用流水（关键节点：search 搜了什么/reply 发了啥/被门禁拦没拦），供前端 agent 视图全显示 */
  toolLog: PiToolNode[]
  tokensIn: number
  tokensOut: number
  cost: number
}

/** 一次工具调用的关键节点（前端 agent 视图渲染用） */
export interface PiToolNode {
  name: string
  args: Record<string, unknown>
  resultText: string
  isError: boolean
  /** 是否被 search 门禁拦截（resultText 含"拦截"） */
  intercepted: boolean
  durationMs?: number
}

/**
 * 估算一条 pi AgentMessage 的 token（粗略：字符数 / 2，中文≈1 字 1 token，英文≈4 字 1 token 折中）。
 * 用于 live 上下文超限监测；不精确但够用（pi 官方示例也是 estimateTokens 粗估）。
 */
export function estimateMessageTokens(m: AgentMessage): number {
  const c = m.content
  let text = ''
  if (typeof c === 'string') text = c
  else if (Array.isArray(c)) {
    // pi 的 content 是 (TextContent | ThinkingContent | ToolCall | ImageContent)[]
    for (const b of c) {
      if (typeof b === 'string') text += b
      else if (b && typeof b === 'object') {
        const o = b as unknown as Record<string, unknown>
        if (typeof o.text === 'string') text += o.text
        if (o.input && typeof o.input === 'object') text += JSON.stringify(o.input)
        if (o.content && typeof o.content === 'string') text += o.content
      }
    }
  }
  return Math.max(1, Math.ceil([...text].length / 2))
}

/**
 * pi 官方 transformContext 钩子：live 上下文超 token 上限时裁旧轮次（最近 N 轮逐字保留）。
 * 不超就原样返回——不限制模型正常发挥；只在堆到爆窗口前裁最旧的。
 * 按"轮"裁（一轮 = 一次 user prompt 起），不裁半截工具调用。
 */
export async function transformLiveContext(messages: AgentMessage[]): Promise<AgentMessage[]> {
  const maxTokens = config.llm.maxTokens
  if (maxTokens <= 0) return messages
  const total = messages.reduce((s, m) => s + estimateMessageTokens(m), 0)
  if (total <= maxTokens) return messages // 没超，不动
  // 超了：保留 system + 最近 N 轮。从尾部往前找"轮边界"（user 消息开头），保留 N 轮
  const keepRounds = Math.max(3, config.agent.maxContextTurns)
  // 轮边界 = 非 system 的首个 user 消息。从尾部数 keepRounds 个 user 消息
  const userIdx: number[] = []
  for (let i = 0; i < messages.length; i++) {
    if ((messages[i] as { role?: string }).role === 'user') userIdx.push(i)
  }
  const startKeep = userIdx.length > keepRounds ? userIdx[userIdx.length - keepRounds] : 0
  const pruned = messages.slice(startKeep)
  if (pruned.length > 0 && pruned.length < messages.length) {
    const after = pruned.reduce((s, m) => s + estimateMessageTokens(m), 0)
    console.log(`[Pi] 上下文超限裁剪: ${messages.length}条(${total}tok) → ${pruned.length}条(${after}tok)，保留最近${keepRounds}轮`)
  }
  return pruned.length > 0 ? pruned : messages // 裁完还超就保留现状（不裁到 0，模型得有点上下文）
}

export class PiAgentSession {
  private agent: Agent
  /** 可变缓冲：reply 工具 execute 写进来，runOnce 清空/读取 */
  private replyBuffer: string[] = []
  /** search 硬闸门（闭包共享，runOnce 时重置）：逼模型疯狂搜索、搜到相近才许 reply */
  private gate: SearchGate

  constructor(sceneKey: string, sceneType: 'group' | 'private', getState?: () => string) {
    this.gate = createGate()
    // 工具集：reply 走门禁（查 gate）；get_state 由调用方提供；gate 闭包引用
    const tools = createPiTools(sceneKey, {
      reply: async (texts) => { this.replyBuffer.push(...texts) },
      getState: () => (getState ? getState() : ''),
    }, this.gate)
    this.agent = new Agent({
      streamFn: getPiStreamFn(),
      // live 上下文按 token 监测，超 LLM_MAX_TOKENS 才裁旧轮次（最近 N 轮逐字保留），不限制模型正常发挥
      transformContext: transformLiveContext,
      initialState: {
        systemPrompt: buildSystemPrompt(sceneType),
        model: getPiModel() as never,
        tools,
      },
    })
  }

  /** 喂一条 user 消息，跑完整 loop，返回要发的话（空=沉默）。 */
  async runOnce(userContent: string): Promise<PiRunResult> {
    this.replyBuffer.length = 0
    // 重置 search 硬闸门：本轮相关性参照=当前要接的 user 消息；清掉上轮搜过的记录
    this.gate.userContent = userContent
    this.gate.searchLog.length = 0
    this.gate.searchCount = 0
    const assistantTexts: string[] = []
    const toolLog: PiToolNode[] = []
    const toolStart = new Map<string, { name: string; args: Record<string, unknown>; at: number }>()
    let tokensIn = 0
    let tokensOut = 0
    let cost = 0

    const unsub = this.agent.subscribe((event) => {
      if (event.type === 'turn_end') {
        const usage = (event.message as { usage?: { input?: number; output?: number; cost?: Record<string, number> } }).usage
        // 累加（一次 run 可能多个 LLM turn，每个 turn_end 都要加，不能只留最后一个）
        tokensIn += usage?.input ?? 0
        tokensOut += usage?.output ?? 0
        // 用 pi 库的 calculateCost 算 cost（读 model.cost 的 pricePerMIn/Out × 实际 usage token 数）
        if (usage) {
          try {
            const m = getPiModel()
            // calculateCost 会写 usage.cost，先初始化 cost 字段防崩
            const u = usage as unknown as { cost?: Record<string, unknown> }
            u.cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, totalFromProvider: false }
            cost += calculateCost(m, usage as never)?.total ?? 0
          } catch {
            cost += usage?.cost?.total ?? 0
          }
        }
      }
      if (event.type === 'message_end' && event.message.role === 'assistant') {
        const texts = (event.message.content ?? [])
          .filter((c) => c.type === 'text')
          .map((c) => ('text' in c ? (c.text ?? '') : ''))
          .filter(Boolean)
        if (texts.length) assistantTexts.push(texts.join(''))
      }
      // 工具关键节点：search 搜了什么/reply 发了啥/门禁拦截，前端 agent 视图全显示
      if (event.type === 'tool_execution_start') {
        toolStart.set(event.toolCallId, { name: event.toolName, args: event.args ?? {}, at: Date.now() })
      }
      if (event.type === 'tool_execution_end') {
        const st = toolStart.get(event.toolCallId)
        toolStart.delete(event.toolCallId)
        const resultText = String(event.result?.content?.[0]?.text ?? event.result ?? '').trim()
        toolLog.push({
          name: st?.name ?? event.toolName,
          args: st?.args ?? {},
          resultText: resultText.slice(0, 400),
          isError: event.isError,
          intercepted: st?.name === 'reply' && /拦截/.test(resultText),
          durationMs: event.durationMs ?? (st ? Date.now() - st.at : undefined),
        })
      }
    })

    await this.agent.prompt(userContent)
    unsub()

    const sentByTool = this.replyBuffer.length > 0
    const assistantText = assistantTexts.at(-1) ?? ''
    const segments = sentByTool ? this.replyBuffer : assistantText ? [assistantText] : []
    const searched = this.gate.searchCount
    const foundRelevant = this.gate.searchLog.length > 0
    const interceptedCount = toolLog.filter(t => t.intercepted).length
    console.log(`[Pi] runOnce 完成: ${segments.length ? `走${sentByTool ? 'reply工具' : 'assistant文本'}` : '沉默'} | 搜了${searched}次(${foundRelevant ? '翻到相关' : '没翻到相关'})${interceptedCount ? `| 门禁拦了${interceptedCount}次` : ''} | 上下文${this.messageCount}条 | ${tokensIn}tok进/${tokensOut}tok出`)
    return { segments, sentByTool, assistantText, toolLog, tokensIn, tokensOut, cost }
  }

  /** 清空当前会话（对齐 pi reset：保留 system baseline） */
  reset(): void {
    this.agent.reset()
    this.replyBuffer.length = 0
  }

  /** 当前 live 上下文轮数 */
  get messageCount(): number {
    return this.agent.state.messages.length
  }
}