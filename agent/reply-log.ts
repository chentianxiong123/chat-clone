export interface ReplyEntry {
  scene: 'group' | 'private'
  id: number
  text: string
  at: number
  seq: number
}

const MAX = 100
const buf: ReplyEntry[] = []
let seq = 0

export function logReply(scene: 'group' | 'private', id: number, text: string): void {
  buf.push({ scene, id, text, at: Date.now(), seq: ++seq })
  if (buf.length > MAX) buf.splice(0, buf.length - MAX)
}

export function getReplies(limit = 20): ReplyEntry[] {
  return buf.slice(-limit)
}

export function clearReplies(): void {
  buf.length = 0
}
