import OpenAI from 'openai'
import { config } from './config.js'
import { recordUsage } from './stats.js'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
  time?: number
}

/** 按配置的价格表计算一次调用的费用（元） */
export function calcLlmCost(tokensIn: number, tokensOut: number): number {
  const pIn = config.llm.pricePerMIn
  const pOut = config.llm.pricePerMOut
  if (!pIn && !pOut) return 0
  return (tokensIn / 1_000_000) * pIn + (tokensOut / 1_000_000) * pOut
}

const client = new OpenAI({
  baseURL: config.llm.baseUrl,
  apiKey: config.llm.apiKey,
  defaultHeaders: { 'User-Agent': 'chat-clone-agent/0.1.0' },
})

export async function callLlm(messages: ChatMessage[]): Promise<string> {
  const maxTokens = config.llm.maxTokens
  const temperature = config.llm.temperature
  const attempts = config.llm.retryAttempts

  for (let attempt = 0; attempt < attempts; attempt++) {
    const t0 = Date.now()
    try {
      const resp = await client.chat.completions.create({
        model: config.llm.model,
        messages,
        max_tokens: maxTokens,
        temperature,
      })
      const content = resp.choices?.[0]?.message?.content
      const usage = resp.usage
      const cachedTokens = (usage as any)?.prompt_tokens_details?.cached_tokens ?? 0
      recordUsage({
        kind: 'llm',
        sub: config.llm.model,
        ok: content ? 1 : 0,
        fail: 0,
        cost: calcLlmCost(usage?.prompt_tokens ?? 0, usage?.completion_tokens ?? 0),
        tokensIn: usage?.prompt_tokens ?? 0,
        tokensOut: usage?.completion_tokens ?? 0,
        cachedTokens,
        ts: Date.now(),
        durationMs: Date.now() - t0,
      })
      if (content) return content.trim()
      console.warn(`[LLM] 重试 ${attempt + 1}/${attempts}: 空响应`)
      await sleep(config.llm.retryDelayMs)
    } catch (e) {
      recordUsage({ kind: 'llm', sub: config.llm.model, ok: 0, fail: 1, cost: 0, tokensIn: 0, tokensOut: 0, ts: Date.now(), durationMs: Date.now() - t0 })
      console.warn(`[LLM] 重试 ${attempt + 1}/${attempts}: ${(e as Error).message}`)
      await sleep(config.llm.retryDelayMs)
    }
  }
  return ''
}

/** 直接调用（WebUI 手测 LLM 用），返回完整响应或错误信息 */
export async function callLlmRaw(messages: ChatMessage[], maxTokensOverride?: number): Promise<{ ok: boolean; text?: string; error?: string; usage?: { prompt_tokens: number; completion_tokens: number } }> {
  const t0 = Date.now()
  try {
    const resp = await client.chat.completions.create({
      model: config.llm.model,
      messages,
      max_tokens: maxTokensOverride ?? config.llm.maxTokens,
      temperature: config.llm.temperature,
    })
    const content = resp.choices?.[0]?.message?.content
    const usage = resp.usage
    const cachedTokens = (usage as any)?.prompt_tokens_details?.cached_tokens ?? 0
    recordUsage({
      kind: 'llm',
      sub: config.llm.model,
      ok: 1,
      fail: 0,
      cost: calcLlmCost(usage?.prompt_tokens ?? 0, usage?.completion_tokens ?? 0),
      tokensIn: usage?.prompt_tokens ?? 0,
      tokensOut: usage?.completion_tokens ?? 0,
      cachedTokens,
      ts: Date.now(),
      durationMs: Date.now() - t0,
    })
    if (content) return { ok: true, text: content.trim(), usage }
    return { ok: true, text: '', usage }
  } catch (e) {
    recordUsage({ kind: 'llm', sub: config.llm.model, ok: 0, fail: 1, cost: 0, tokensIn: 0, tokensOut: 0, ts: Date.now(), durationMs: Date.now() - t0 })
    return { ok: false, error: (e as Error).message }
  }
}

/** 列出可用模型（WebUI 模型选择用） */
export async function listModels(): Promise<Array<{ id: string }>> {
  try {
    const resp = await client.models.list()
    return resp.data ?? []
  } catch (e) {
    console.warn('[LLM] 模型列表失败:', (e as Error).message)
    return []
  }
}

/** 文本向量化（RAG 检索用），返回 1024 维向量 */
export async function embed(text: string): Promise<Float32Array | null> {
  if (!config.rag.embedEndpoint || !config.rag.embedEnabled) return null
  try {
    const res = await fetchWithProxy(config.rag.embedEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'chat-clone-agent/0.1.0',
        ...(config.rag.embedApiKey ? { Authorization: `Bearer ${config.rag.embedApiKey}` } : {}),
      },
      body: JSON.stringify({ model: config.rag.embedModel, input: text }),
    })
    if (!res.ok) {
      console.warn(`[Embed] HTTP ${res.status}: ${await res.text()}`)
      recordUsage({ kind: 'embed', sub: config.rag.embedModel, ok: 0, fail: 1, cost: 0, tokensIn: 0, tokensOut: 0, ts: Date.now() })
      return null
    }
    const data = await res.json() as { data?: Array<{ embedding?: number[] }> }
    const arr = data?.data?.[0]?.embedding
    if (!Array.isArray(arr)) {
      console.warn('[Embed] 响应缺 data[0].embedding')
      recordUsage({ kind: 'embed', sub: config.rag.embedModel, ok: 0, fail: 1, cost: 0, tokensIn: 0, tokensOut: 0, ts: Date.now() })
      return null
    }
    recordUsage({
      kind: 'embed',
      sub: config.rag.embedModel,
      ok: 1,
      fail: 0,
      cost: config.embed.pricePerCall,
      tokensIn: 0,
      tokensOut: 0,
      ts: Date.now(),
    })
    return new Float32Array(arr)
  } catch (e) {
    console.warn('[Embed] 请求失败:', (e as Error).message)
    recordUsage({ kind: 'embed', sub: config.rag.embedModel, ok: 0, fail: 1, cost: 0, tokensIn: 0, tokensOut: 0, ts: Date.now() })
    return null
  }
}

/** 带可选代理的 fetch（EMBED_PROXY 走手机 mihomo 出口） */
async function fetchWithProxy(url: string, init: RequestInit): Promise<Response> {
  if (!config.rag.embedProxy) return fetch(url, init)
  const { ProxyAgent, fetch: ufetch } = await import('undici')
  const agent = new ProxyAgent(config.rag.embedProxy)
  return ufetch(url, { ...init, dispatcher: agent } as never)
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}