import OpenAI from 'openai'
import { config } from './config.js'
import { recordUsage } from './stats.js'
import {
  getActiveProvider, getProvider, clientFor, getEmbedProvider,
  type ProviderSpec,
} from './domain/models/index.js'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
  time?: number
}

function priceFor(p: ProviderSpec): { in: number; out: number } {
  return {
    in: p.pricePerMIn ?? 0,
    out: p.pricePerMOut ?? 0,
  }
}

/** 按 provider 价格表计算一次调用的费用（元） */
export function calcLlmCost(tokensIn: number, tokensOut: number): number {
  const active = getActiveProvider()
  if (!active) return 0
  const price = priceFor(active)
  if (!price.in && !price.out) return 0
  return (tokensIn / 1_000_000) * price.in + (tokensOut / 1_000_000) * price.out
}

export interface LlmResult {
  text: string
  providerId: string
  toolCalls?: number
  tokensIn?: number
  tokensOut?: number
  cost?: number
}

/** 按活跃 → fallback 链顺序逐一尝试；记录每个 provider 的真实成本/成败 */
export async function callLlmWithProviders(messages: ChatMessage[], opts: {
  maxTokens?: number
  temperature?: number
  attempts?: number
  onAttempt?: (p: ProviderSpec, ok: boolean, err?: string) => void
} = {}): Promise<LlmResult> {
  const active = getActiveProvider()
  if (!active) return { text: '', providerId: '', tokensIn: 0, tokensOut: 0, cost: 0 }
  const chain: ProviderSpec[] = [active]
  for (const fb of active.fallback ?? []) {
    const p = getProvider(fb)
    if (p && p.enabled !== false && !chain.some(x => x.id === p.id)) chain.push(p)
  }
  const maxTokens = opts.maxTokens ?? active.maxTokens ?? 2048
  const temperature = opts.temperature ?? active.temperature ?? 1
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
          return {
            text: content.trim(),
            providerId: p.id,
            tokensIn: usage?.prompt_tokens ?? 0,
            tokensOut: usage?.completion_tokens ?? 0,
            cost,
          }
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
  return { text: '', providerId: chain[0]?.id ?? '', tokensIn: 0, tokensOut: 0, cost: 0 }
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
}): Promise<LlmResult> {
  const active = getActiveProvider()
  if (!active) return { text: '', providerId: '', toolCalls: 0, tokensIn: 0, tokensOut: 0, cost: 0 }
  const chain: ProviderSpec[] = [active]
  for (const fb of active.fallback ?? []) {
    const p = getProvider(fb)
    if (p && p.enabled !== false && !chain.some(x => x.id === p.id)) chain.push(p)
  }
  const maxTokens = opts.maxTokens ?? active.maxTokens ?? 2048
  const temperature = opts.temperature ?? active.temperature ?? 1
  const maxIter = Math.max(1, opts.maxIter ?? 2)
  const base = messages.map(m => ({ role: m.role, content: m.content }))

  let tokensIn = 0
  let tokensOut = 0
  let cost = 0
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
      const callTokensIn = usage?.prompt_tokens ?? 0
      const callTokensOut = usage?.completion_tokens ?? 0
      const callCost = (!price.in && !price.out) ? 0
        : (callTokensIn / 1_000_000) * price.in + (callTokensOut / 1_000_000) * price.out
      tokensIn += callTokensIn
      tokensOut += callTokensOut
      cost += callCost
      recordUsage({
        kind: 'llm',
        sub: `${p.id}/${p.model}`,
        ok: 1,
        fail: 0,
        cost: callCost,
        tokensIn: callTokensIn,
        tokensOut: callTokensOut,
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
        return { text: content.trim(), providerId: p.id, toolCalls, tokensIn, tokensOut, cost }
      }
      // 空响应 → 换下一个 provider
      break
    }
  }
  // 循环结束仍无 content：保留已执行工具计数（模型可能只调了工具就停，如 reply 攒句）
  return { text: '', providerId: chain[0]?.id ?? '', toolCalls, tokensIn, tokensOut, cost }
}

/** 直接调用（WebUI 手测 LLM 用），返回完整响应或错误信息 */
export async function callLlmRaw(messages: ChatMessage[], maxTokensOverride?: number): Promise<{ ok: boolean; text?: string; error?: string; usage?: { prompt_tokens: number; completion_tokens: number }; providerId?: string }> {
  const resp = await callLlmWithProviders(messages, { maxTokens: maxTokensOverride })
  if (resp.text) return { ok: true, text: resp.text, providerId: resp.providerId }
  return { ok: false, error: `所有 provider 均失败（last active=${getActiveProvider()?.id}）`, providerId: resp.providerId }
}

/** 文本向量化（RAG 检索用），返回 1024 维向量 */
export async function embed(text: string): Promise<Float32Array | null> {
  // 嵌入只按次计数（不报 token）：成功记录 ok=1 + 按次费用，失败记录 fail=1；token 字段恒 0
  const rec = (ok: number, cost = 0, sub?: string) => recordUsage({
    kind: 'embed',
    sub: sub || (getEmbedProvider()?.id ? `${getEmbedProvider()!.id}/${getEmbedProvider()!.embedModel}` : config.rag.embedModel),
    ok,
    fail: ok ? 0 : 1,
    cost,
    tokensIn: 0,
    tokensOut: 0,
    ts: Date.now(),
  })

  // 优先走 provider 体系（providers.json 配 embedModel 的上游）
  const embedProvider = getEmbedProvider()
  if (embedProvider && config.rag.embedEnabled) {
    try {
      const client = clientFor(embedProvider)
      const resp = await client.embeddings.create({
        model: embedProvider.embedModel as string,
        input: text,
      })
      const arr = resp.data?.[0]?.embedding
      if (!arr) {
        console.warn('[Embed] 响应缺 data[0].embedding')
        rec(0, 0, `${embedProvider.id}/${embedProvider.embedModel}`)
        return null
      }
      const cost = (!priceFor(embedProvider).in && !priceFor(embedProvider).out)
        ? (config.embed.pricePerCall || 0)
        : 0 // 按次计：token 不报，费用统一用 pricePerCall
      rec(1, cost, `${embedProvider.id}/${embedProvider.embedModel}`)
      return new Float32Array(arr)
    } catch (e) {
      console.warn('[Embed] provider 请求失败:', (e as Error).message)
      rec(0, 0, `${embedProvider.id}/${embedProvider.embedModel}`)
      return null
    }
  }

  // 兼容旧路径：独立 EMBED_ENDPOINT（未配 provider 体系时）
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
      rec(0, 0, config.rag.embedModel)
      return null
    }
    const data = await res.json() as { data?: Array<{ embedding?: number[] }> }
    const arr = data?.data?.[0]?.embedding
    if (!Array.isArray(arr)) {
      console.warn('[Embed] 响应缺 data[0].embedding')
      rec(0, 0, config.rag.embedModel)
      return null
    }
    rec(1, config.embed.pricePerCall, config.rag.embedModel)
    return new Float32Array(arr)
  } catch (e) {
    console.warn('[Embed] 请求失败:', (e as Error).message)
    rec(0, 0, config.rag.embedModel)
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