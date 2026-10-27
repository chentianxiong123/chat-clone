import { config } from '../config.js'

export type ChannelId = 'qq' | 'sim'
export type ThreadKind = 'group' | 'private'

export interface ThreadRef {
  channel: ChannelId
  kind: ThreadKind
  externalId: number
}

export interface InboundMessage {
  thread: ThreadRef
  senderId: number
  senderNick: string
  text: string
  atBot?: boolean
  at?: number
  simulated?: boolean
  /** sim 群聊是否走真实群策略（攒批+静默）；false=立即回复 */
  policy?: boolean
}

export type TriggerReason = 'message' | 'mention' | 'timer' | 'manual' | 'proactive'

export interface TriggerInfo {
  reason: TriggerReason
  batchSize: number
  triggerNick?: string
  woke?: boolean
}

export interface TurnRequest {
  thread: ThreadRef
  messages: InboundMessage[]
  trigger: TriggerInfo
}

export interface ThreadMeta {
  id: string
  channel: ChannelId
  kind: ThreadKind
  externalId: number
  title: string
  createdAt: number
  updatedAt: number
  lastMessageAt: number
  lastPreview: string
  unread: number
  paused: boolean
}

export interface RunRecord {
  id: string
  threadId: string
  trigger: string
  status: 'running' | 'ok' | 'skipped' | 'error'
  startedAt: number
  endedAt?: number
  model?: string
  tokensIn?: number
  tokensOut?: number
  cost?: number
  error?: string
  reply?: string
  toolCalls?: number
}

export interface ToolTrace {
  id: string
  runId: string
  name: string
  args: Record<string, unknown>
  result: string
  status: 'ok' | 'error'
  startedAt: number
  durationMs: number
}

export type V2Event =
  | { type: 'message.received'; thread: string; message: InboundMessage; at: number }
  | { type: 'assistant.message'; thread: string; runId: string; text: string; segments: string[]; at: number }
  | { type: 'assistant.segment'; thread: string; runId: string; text: string; index: number; total: number; at: number }
  | { type: 'run.started'; thread: string; runId: string; trigger: string; at: number }
  | { type: 'run.finished'; thread: string; runId: string; status: string; reply?: string; error?: string; at: number }
  | { type: 'tool.started'; thread: string; runId: string; callId: string; name: string; args: Record<string, unknown>; at: number }
  | { type: 'tool.finished'; thread: string; runId: string; callId: string; name: string; result: string; status: string; durationMs: number; at: number }
  | { type: 'thread.updated'; thread: string; at: number }

export function threadKey(ref: ThreadRef): string {
  const kind = ref.kind === 'group' ? 'g' : 'p'
  if (ref.channel === 'qq') return `${kind}:${ref.externalId}`
  return `${ref.channel}:${kind}:${ref.externalId}`
}

export function parseThreadKey(key: string): ThreadRef | null {
  const m = key.match(/^(?:(qq|sim):)?([gp]):(\d+)$/)
  if (!m) return null
  const channel: ChannelId = m[1] === 'sim' ? 'sim' : 'qq'
  return {
    channel,
    kind: m[2] === 'g' ? 'group' : 'private',
    externalId: Number(m[3]),
  }
}

export function threadTitle(ref: ThreadRef): string {
  if (ref.channel === 'sim') {
    return ref.kind === 'group' ? `模拟群 ${ref.externalId}` : `模拟私聊 ${ref.externalId}`
  }
  return ref.kind === 'group' ? `QQ群 ${ref.externalId}` : `私聊 ${ref.externalId}`
}

export function isSimGroupId(id: number): boolean {
  return Number.isInteger(id) && id >= config.sim.groupMin && id <= config.sim.groupMax
}

export function isSimThread(key: string): boolean {
  return key.startsWith('sim:')
}
