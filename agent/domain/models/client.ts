import OpenAI from 'openai'
import { resolveKey } from './registry.js'
import type { ProviderSpec } from './spec.js'

const _clients = new Map<string, OpenAI>()

export function clientFor(spec: ProviderSpec): OpenAI {
  const cached = _clients.get(spec.id)
  if (cached) return cached
  const client = new OpenAI({
    baseURL: spec.baseUrl || undefined,
    apiKey: resolveKey(spec.apiKey) || 'sk-none',
    timeout: spec.timeout ?? 120_000,
    defaultHeaders: { 'User-Agent': 'chat-clone-agent/0.1.0' },
    ...(spec.proxy ? { fetch: proxiedFetch(spec.proxy) } : {}),
  })
  _clients.set(spec.id, client)
  return client
}

export function clearClientCache(id?: string): void {
  if (id) _clients.delete(id)
  else _clients.clear()
}

function proxiedFetch(proxyUrl: string): typeof fetch {
  let agent: import('undici').ProxyAgent | null = null
  return (async (input: any, init?: any) => {
    if (!agent) {
      const { ProxyAgent } = await import('undici')
      agent = new ProxyAgent(proxyUrl)
    }
    const { fetch: ufetch } = await import('undici')
    return ufetch(input, { ...(init ?? {}), dispatcher: agent })
  }) as typeof fetch
}
