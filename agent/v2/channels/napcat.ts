import type { NCWebsocket } from 'node-napcat-ts'
import type { BotTransport, GroupMsg, PrivateMsg } from './transport.js'

/**
 * NapCat 协议端（OneBot 11）：node-napcat-ts 双向 WS，行为与旧 index.ts 完全一致。
 */
export class NapCatTransport implements BotTransport {
  private groupCb: ((e: GroupMsg) => void) | null = null
  private privateCb: ((e: PrivateMsg) => void) | null = null
  private statusCb: ((c: boolean) => void) | null = null

  constructor(private readonly bot: NCWebsocket) {}

  /** 挂事件（须在 connect 前调用） */
  attach(): void {
    this.bot.on('message.group.normal', async (e: unknown) => {
      const m = e as { user_id: number; self_id: number; group_id: number; raw_message: string; sender?: { nickname?: string } }
      if (!this.groupCb) return
      if (m.user_id === m.self_id) return
      const text = (m.raw_message || '').trim()
      if (!text) return
      const atBot = (m.raw_message || '').includes(`[CQ:at,qq=${m.self_id}]`)
      this.groupCb({ groupId: m.group_id, senderId: m.user_id, senderNick: m.sender?.nickname || '朋友', text, atBot })
    })

    const onPrivate = async (e: unknown): Promise<void> => {
      const m = e as { user_id: number; self_id: number; raw_message: string; sender?: { nickname?: string } }
      if (!this.privateCb) return
      if (m.user_id === m.self_id) return
      const text = (m.raw_message || '').trim()
      if (!text) return
      this.privateCb({ senderId: m.user_id, senderNick: m.sender?.nickname || '朋友', text })
    }
    this.bot.on('message.private.friend', onPrivate)
    this.bot.on('message.private.group', onPrivate)

    this.bot.on('socket.open', () => this.statusCb?.(true))
    this.bot.on('socket.close', () => this.statusCb?.(false))
    this.bot.on('socket.error', () => this.statusCb?.(false))
  }

  async connect(): Promise<void> {
    await this.bot.connect()
  }

  async sendGroup(groupId: number, text: string): Promise<void> {
    await this.bot.send_group_msg({ group_id: groupId, message: [{ type: 'text', data: { text } }] })
  }

  async sendPrivate(userId: number, text: string): Promise<void> {
    await this.bot.send_private_msg({ user_id: userId, message: [{ type: 'text', data: { text } }] })
  }

  onGroup(cb: (e: GroupMsg) => void): void {
    this.groupCb = cb
  }

  onPrivate(cb: (e: PrivateMsg) => void): void {
    this.privateCb = cb
  }

  onStatus(cb: (c: boolean) => void): void {
    this.statusCb = cb
  }
}
