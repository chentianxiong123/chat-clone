/**
 * 统一协议端抽象层（Transport）：
 * 核心只认这个接口，NapCat(OneBot 11) 与 Milky 都是插头，通过 config.channel 自由切换。
 * 核心逻辑（AgentCore / handleMessage / 人格 / 记忆 / WebUI）零改动。
 */

export interface GroupMsg {
  groupId: number
  senderId: number
  senderNick: string
  text: string
  atBot: boolean
}

export interface PrivateMsg {
  senderId: number
  senderNick: string
  text: string
}

export interface BotTransport {
  /** 建立连接（含事件挂载） */
  connect(): Promise<void>
  /** 发群聊文本 */
  sendGroup(groupId: number, text: string): Promise<void>
  /** 发私聊文本 */
  sendPrivate(userId: number, text: string): Promise<void>
  /** 注册群消息回调 */
  onGroup(cb: (e: GroupMsg) => void): void
  /** 注册私聊消息回调 */
  onPrivate(cb: (e: PrivateMsg) => void): void
  /** 注册连接状态回调 */
  onStatus(cb: (connected: boolean) => void): void
}
