import OpenAI from 'openai'
import { config } from './config.js'
import { recordUsage } from './stats.js'
import {
  getActiveProvider, getProvider, listProviders, clientFor, testProvider, listModelsFor,
  type ProviderSpec,
} from './models.js'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
  time?: number
}

function priceFor(p: ProviderSpec): { in: number; out: number } {
  return {
    in: typeof p.pricePerMIn === 'number' ? p.pricePerMIn : config.llm.pricePerMIn,
    out: typeof p.pricePerMOut === 'number' ? p.pricePerMOut : config.llm.pricePerMOut,
  }
}

/** 按 provider 价格表计算一次调用的费用（元） */
export function calcLlmCost(tokensIn: number, tokensOut: number): number {
  const active = getActiveProvider()
  const price = active ? priceFor(active) : { in: config.llm.pricePerMIn, out: config.llm.pricePerMOut }
  if (!price.in && !price.out) return 0
  return (tokensIn / 1_000_000) * price.in + (tokensOut / 1_000_000) * price.out
}

interface ProviderHealth {
  id: string
  ok: boolean
  latencyMs: number
  error?: string
}

/** 按活跃 → fallback 链顺序逐一尝试；记录每个 provider 的真实成本/成败 */
export async function callLlmWithProviders(messages: ChatMessage[], opts: {
  maxTokens?: number
  temperature?: number
  attempts?: number
  onAttempt?: (p: ProviderSpec, ok: boolean, err?: string) => void
} = {}): Promise<{ text: string; providerId: string }> {
  const active = getActiveProvider()
  if (!active) return { text: '', providerId: '' }
  const chain: ProviderSpec[] = [active]
  for (const fb of active.fallback ?? []) {
    const p = getProvider(fb)
    if (p && p.enabled !== false && !chain.some(x => x.id === p.id)) chain.push(p)
  }
  const maxTokens = opts.maxTokens ?? active.maxTokens ?? config.llm.maxTokens
  const temperature = opts.temperature ?? active.temperature ?? config.llm.temperature
  const attempts = opts.attempts ?? config.llm.retryAttempts

  for (const p of chain) {
    for (let attempt = 0; attempt < attempts; attempt++) {
      const t0 = Date.now()
      try {
        const resp = await clientFor(p).chat.completions.create({
          model: p.model,
          messages,
          max_tokens: maxTokens,
          temperature,
        })
        const content = resp.choices?.[0]?.message?.content
        const usage = resp.usage
        const cachedTokens = (usage as any)?.prompt_tokens_details?.cached_tokens
          ?? (usage as any)?.prompt_cache_hit_tokens ?? 0
        const price = priceFor(p)
        const cost = (!price.in && !price.out) ? 0
          : ((usage?.prompt_tokens ?? 0) / 1_000_000) * price.in + ((usage?.completion_tokens ?? 0) / 1_000_000) * price.out
        recordUsage({
          kind: 'llm',
          sub: `${p.id}/${p.model}`,
          ok: content ? 1 : 0,
          fail: 0,
          cost,
          tokensIn: usage?.prompt_tokens ?? 0,
          tokensOut: usage?.completion_tokens ?? 0,
          cachedTokens,
          ts: Date.now(),
          durationMs: Date.now() - t0,
        })
        if (content) {
          opts.onAttempt?.(p, true, undefined)
          return { text: content.trim(), providerId: p.id }
        }
        console.warn(`[LLM] ${p.id}/${p.model} 空响应，重试 ${attempt + 1}/${attempts}`)
        await sleep(config.llm.retryDelayMs)
      } catch (e) {
        const err = (e as Error).message
        recordUsage({ kind: 'llm', sub: `${p.id}/${p.model}`, ok: 0, fail: 1, cost: 0, tokensIn: 0, tokensOut: 0, ts: Date.now(), durationMs: Date.now() - t0 })
        opts.onAttempt?.(p, false, err)
        console.warn(`[LLM] ${p.id}/${p.model} 失败(${attempt + 1}/${attempts}): ${err}`)
        await sleep(config.llm.retryDelayMs)
      }
    }
  }
  return { text: '', providerId: chain[0]?.id ?? '' }
}

export async function callLlm(messages: ChatMessage[]): Promise<string> {
  const { text } = await callLlmWithProviders(messages)
  return text
}

// ── Function call 工具 ────────────────────────────────────────────────────
export interface ToolSpec {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}
export type ToolExecutor = (args: Record<string, unknown>) => Promise<string> | string

function isToolUnsupported(err: string): boolean {
  return /tool|function|unsupported|not support|不支持/i.test(err)
}

/**
 * 带工具的有界 agent loop：活跃 provider → fallback 链；
 * 每轮最多 maxIter 次调用，模型发起 tool_calls 就执行并回填，直到产出文本。
 * provider 不支持 tools 时自动降级为无工具单次调用。
 */
export async function callLlmWithTools(messages: ChatMessage[], opts: {
  tools: ToolSpec[]
  executors: Record<string, ToolExecutor>
  maxIter?: number
  maxTokens?: number
  temperature?: number
  onAttempt?: (p: ProviderSpec, ok: boolean, err?: string) => void
  onToolStart?: (info: { name: string; args: Record<string, unknown>; startedAt: number }) => void
  onTool?: (info: {
    name: string
    args: Record<string, unknown>
    result: string
    status: 'ok' | 'error'
    durationMs: number
    startedAt: number
  }) => void
}): Promise<{ text: string; providerId: string; toolCalls: number }> {
  const active = getActiveProvider()
  if (!active) return { text: '', providerId: '', toolCalls: 0 }
  const chain: ProviderSpec[] = [active]
  for (const fb of active.fallback ?? []) {
    const p = getProvider(fb)
    if (p && p.enabled !== false && !chain.some(x => x.id === p.id)) chain.push(p)
  }
  const maxTokens = opts.maxTokens ?? active.maxTokens ?? config.llm.maxTokens
  const temperature = opts.temperature ?? active.temperature ?? config.llm.temperature
  const maxIter = Math.max(1, opts.maxIter ?? 2)
  const base = messages.map(m => ({ role: m.role, content: m.content }))

  for (const p of chain) {
    const working: any[] = base.map(m => ({ ...m }))
    let toolCalls = 0
    let toolsEnabled = opts.tools.length > 0

    for (let iter = 0; iter < maxIter; iter++) {
      const t0 = Date.now()
      let resp: any
      try {
        resp = await clientFor(p).chat.completions.create({
          model: p.model,
          messages: working,
          max_tokens: maxTokens,
          temperature,
          ...(toolsEnabled ? { tools: opts.tools as any, tool_choice: 'auto' as const } : {}),
        } as any)
      } catch (e) {
        const err = (e as Error).message
        // 该 provider 不支持工具 → 关掉工具重试一次
        if (toolsEnabled && isToolUnsupported(err)) {
          console.warn(`[LLM] ${p.id}/${p.model} 不支持 tools，降级为无工具调用`)
          toolsEnabled = false
          working.length = 0
          working.push(...base.map(m => ({ ...m })))
          iter-- // 本次降级重试不计入迭代
          continue
        }
        recordUsage({ kind: 'llm', sub: `${p.id}/${p.model}`, ok: 0, fail: 1, cost: 0, tokensIn: 0, tokensOut: 0, ts: Date.now(), durationMs: Date.now() - t0 })
        opts.onAttempt?.(p, false, err)
        console.warn(`[LLM] ${p.id}/${p.model} 失败: ${err}`)
        break
      }

      const msg = resp.choices?.[0]?.message
      const usage = resp.usage
      const content: string = msg?.content ?? ''
      const calls: any[] | undefined = msg?.tool_calls
      const cachedTokens = (usage as any)?.prompt_tokens_details?.cached_tokens
        ?? (usage as any)?.prompt_cache_hit_tokens ?? 0
      const price = priceFor(p)
      const cost = (!price.in && !price.out) ? 0
        : ((usage?.prompt_tokens ?? 0) / 1_000_000) * price.in + ((usage?.completion_tokens ?? 0) / 1_000_000) * price.out
      recordUsage({
        kind: 'llm',
        sub: `${p.id}/${p.model}`,
        ok: 1,
        fail: 0,
        cost,
        tokensIn: usage?.prompt_tokens ?? 0,
        tokensOut: usage?.completion_tokens ?? 0,
        cachedTokens,
        ts: Date.now(),
        durationMs: Date.now() - t0,
      })

      if (calls && calls.length) {
        toolCalls += calls.length
        working.push({ role: 'assistant', content: content || null, tool_calls: calls })
        for (const c of calls) {
          const name = c?.function?.name
          let args: Record<string, unknown> = {}
          try { args = JSON.parse(c?.function?.arguments || '{}') } catch { /* ignore */ }
          console.log(`[LLM] 工具调用 ${p.id}: ${name}(${JSON.stringify(args)})`)
          const exec = opts.executors[name]
          const toolStart = Date.now()
          opts.onToolStart?.({ name, args, startedAt: toolStart })
          let result = '（未知工具）'
          let status: 'ok' | 'error' = 'ok'
          try {
            result = exec ? String(await exec(args)) : '（未知工具）'
          } catch (e) {
            status = 'error'
            result = `（工具出错：${(e as Error).message}）`
          }
          opts.onTool?.({ name, args, result, status, durationMs: Date.now() - toolStart, startedAt: toolStart })
          working.push({ role: 'tool', tool_call_id: c.id, content: result })
        }
        continue
      }

      if (content.trim()) {
        opts.onAttempt?.(p, true, undefined)
        return { text: content.trim(), providerId: p.id, toolCalls }
      }
      // 空响应 → 换下一个 provider
      break
    }
  }
  return { text: '', providerId: chain[0]?.id ?? '', toolCalls: 0 }
}

/** 直接调用（WebUI 手测 LLM 用），返回完整响应或错误信息 */
export async function callLlmRaw(messages: ChatMessage[], maxTokensOverride?: number): Promise<{ ok: boolean; text?: string; error?: string; usage?: { prompt_tokens: number; completion_tokens: number }; providerId?: string }> {
  const resp = await callLlmWithProviders(messages, { maxTokens: maxTokensOverride })
  if (resp.text) return { ok: true, text: resp.text, providerId: resp.providerId }
  return { ok: false, error: `所有 provider 均失败（last active=${getActiveProvider()?.id}）`, providerId: resp.providerId }
}

/** 列出所有 provider 的模型（WebUI 模型选择用） */
export async function listModels(): Promise<Array<{ providerId: string; providerName: string; models: Array<{ id: string }> }>> {
  const out: Array<{ providerId: string; providerName: string; models: Array<{ id: string }> }> = []
  for (const p of listProviders()) {
    out.push({ providerId: p.id, providerName: p.name, models: await listModelsFor(p) })
  }
  return out
}

/** 全部 provider 健康探测 */
export async function healthCheckAll(): Promise<ProviderHealth[]> {
  const specs = listProviders()
  const health = await Promise.all(specs.map(async p => {
    const r = await testProvider(p)
    return { id: p.id, ok: r.ok, latencyMs: r.latencyMs, error: r.error }
  }))
  return health
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