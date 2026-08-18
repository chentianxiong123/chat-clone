import { config } from './config.js'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export async function callLlm(messages: ChatMessage[]): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await fetch(`${config.llm.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.llm.apiKey}`,
        },
        body: JSON.stringify({
          model: config.llm.model,
          messages,
          max_tokens: 1024,
          temperature: 1.0,
          chat_template_kwargs: { enable_thinking: false },
        }),
      })

      if (!resp.ok) {
        const text = await resp.text()
        console.warn(`[LLM] 重试 ${attempt + 1}/3: ${resp.status} ${text.slice(0, 80)}`)
        await sleep(1000)
        continue
      }

      const data: any = await resp.json()
      const content = data.choices?.[0]?.message?.content
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