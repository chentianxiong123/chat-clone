import type { ChannelAdapter } from './base.js'
import type { ThreadRef } from '../types.js'

/** 模拟通道：没有外部发送，消息通过 EventBus 推给控制台。 */
export class SimAdapter implements ChannelAdapter {
  readonly channel = 'sim' as const

  async send(thread: ThreadRef, text: string): Promise<void> {
    console.log(`[Sim] -> ${thread.kind}:${thread.externalId} ${text}`)
  }
}
