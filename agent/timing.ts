export interface MsgContext {
  text: string
  sender: string
  groupId?: number
  userId?: number
  messageType: 'group' | 'private'
}

export interface TimingResult {
  waitSeconds: number
  burst: number
  shouldReply: boolean
}

export function timingDecision(msg: MsgContext): TimingResult {
  const len = msg.text.length
  const hour = new Date().getHours()
  const isNight = hour >= 23 || hour < 2

  const base = len <= 2 ? { s: 3, ok: true }
    : len <= 8 ? { s: 10, ok: true }
    : len <= 20 ? { s: 25, ok: true }
    : len <= 50 ? { s: 45, ok: true }
    : { s: 60, ok: Math.random() > 0.15 }

  const waitSeconds = isNight ? Math.round(base.s * 0.5) : base.s

  const burst = Math.random() < 0.25 ? (Math.random() < 0.5 ? 2 : 3) : 1

  return { waitSeconds, burst, shouldReply: base.ok }
}