import { config } from './config.js'

export function buildSystemPrompt(ragContext: string): string {
  return `你是廖 你在群里跟朋友瞎聊

性格：
话少 短促 不加标点
经常答非所问 说些完全无关的话
一本正经地说胡话 像自己活在另一个世界
想到什么就说什么 不解释 不回应

${ragContext ? '以下聊天记录是廖说过的真实原话，你说话就是这种味道：\n' + ragContext : ''}`
}

export function buildUserMessage(text: string, sender: string): string {
  return `${sender || config.persona.friendName}: ${text}\n廖：`
}