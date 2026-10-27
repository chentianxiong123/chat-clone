import type { NCWebsocket } from 'node-napcat-ts'
import type { ChannelAdapter } from './base.js'
import type { ThreadRef } from '../types.js'

/** QQ 通道：只负责 NapCat 收发；触发/排队/人格都在 harness + runtime。 */
export class QQAdapter implements ChannelAdapter {
  readonly channel = 'qq' as const

  constructor(private readonly bot: NCWebsocket) {}

  async send(thread: ThreadRef, text: string): Promise<void> {
    if (thread.kind === 'private') {
      await this.bot.send_private_msg({
        user_id: thread.externalId,
        message: [{ type: 'text', data: { text } }],
      })
      return
    }
    await this.bot.send_group_msg({
      group_id: thread.externalId,
      message: [{ type: 'text', data: { text } }],
    })
  }
}
