import type { ChannelId, ThreadRef } from '../types.js'

export interface ChannelAdapter {
  channel: ChannelId
  send(thread: ThreadRef, text: string): Promise<void>
  typing?(thread: ThreadRef, on: boolean): Promise<void>
}
