import OpenAI from 'openai'
import { config } from './config.js'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

const client = new OpenAI({
  baseURL: config.llm.baseUrl,
  apiKey: config.llm.apiKey,
})

export async function callLlm(messages: ChatMessage[]): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await client.chat.completions.create({
        model: config.llm.model,
        messages,
        max_tokens: 1024,
        temperature: 1.0,
      }, {
        body: { chat_template_kwargs: { enable_thinking: false } },
      })
      const content = resp.choices?.[0]?.message?.content
      if (content) return content.trim()
      console.warn(`[LLM] 重试 ${attempt + 1}/3: 空响应`)
      await sleep(1000)
    } catch (e) {
      console.warn(`[LLM] 重试 ${attempt + 1}/3: ${(e as Error).message}`)
      await sleep(1000)
    }
  }
  return ''
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}