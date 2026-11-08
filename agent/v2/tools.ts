import type { ThreadRef } from './types.js'

export type SendMessageFn = (thread: ThreadRef, text: string) => Promise<void>
