/**
 * pi Agent 封装：每会话一个实例，live 上下文 = agent.state.messages（pi 内存维护）。
 * runOnce：喂一条 user → pi 跑完整 LLM+工具循环 → 收集 reply 工具攒句 或 assistant 文本 → 返回 segments（空=沉默）。
 */
import { Agent, type AgentTool } from '@earendil-works/pi-agent-core'
import { getPiModel, getPiStreamFn } from './pi-provider.js'
import { buildSystemPrompt } from './prompt.js'
import { createPiTools } from './pi-tools.js'

export interface PiRunResult {
  /** 要发的话（一条=一段；空=沉默） */
  segments: string[]
  /** 是否走了 reply 工具 */
  sentByTool: boolean
  /** 最终 assistant 文本（未走 reply 工具时的兜底话语） */
  assistantText: string
  tokensIn: number
  tokensOut: number
  cost: number
}

export class PiAgentSession {
  private agent: Agent
  /** 可变缓冲：reply 工具 execute 写进来，runOnce 清空/读取 */
  private replyBuffer: string[] = []

  constructor(sceneKey: string, sceneType: 'group' | 'private', getState?: () => string) {
    // 工具集：reply 攒进本会话缓冲；get_state 由调用方提供
    const tools = createPiTools(sceneKey, {
      reply: async (texts) => { this.replyBuffer.push(...texts) },
      getState: () => (getState ? getState() : ''),
    })
    this.agent = new Agent({
      streamFn: getPiStreamFn(),
      initialState: {
        systemPrompt: buildSystemPrompt(sceneType),
        model: getPiModel(),
        tools,
      },
    })
  }

  /** 喂一条 user 消息，跑完整 loop，返回要发的话（空=沉默）。 */
  async runOnce(userContent: string): Promise<PiRunResult> {
    this.replyBuffer.length = 0
    const assistantTexts: string[] = []
    let tokensIn = 0
    let tokensOut = 0
    let cost = 0

    const unsub = this.agent.subscribe((event) => {
      if (event.type === 'turn_end') {
        tokensIn = event.message.usage?.input ?? 0
        tokensOut = event.message.usage?.output ?? 0
        cost = event.message.usage?.cost?.total ?? 0
      }
      if (event.type === 'message_end' && event.message.role === 'assistant') {
        const texts = (event.message.content ?? [])
          .filter((c) => c.type === 'text')
          .map((c) => ('text' in c ? (c.text ?? '') : ''))
          .filter(Boolean)
        if (texts.length) assistantTexts.push(texts.join(''))
      }
    })

    await this.agent.prompt(userContent)
    unsub()

    const sentByTool = this.replyBuffer.length > 0
    const assistantText = assistantTexts.at(-1) ?? ''
    const segments = sentByTool ? this.replyBuffer : assistantText ? [assistantText] : []
    console.log(`[Pi] runOnce 完成: ${segments.length ? `走${sentByTool ? 'reply工具' : 'assistant文本'}` : '沉默'} | 上下文${this.messageCount}条 | ${tokensIn}tok进/${tokensOut}tok出`)
    return { segments, sentByTool, assistantText, tokensIn, tokensOut, cost }
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

  /** 直接访问 pi Agent（调试/webui） */
  get raw(): Agent {
    return this.agent
  }
}