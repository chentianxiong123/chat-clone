import { clientFor } from './client.js'
import { listProviders } from './registry.js'
import type { ProviderSpec } from './spec.js'

export interface ProviderHealth {
  id: string
  ok: boolean
  latencyMs: number
  kind: 'chat' | 'embed'
  error?: string
}

/** 仅嵌入上游：配了 embedModel 且对话模型就是该嵌入模型（无独立 chat 模型） */
function isEmbedOnly(spec: ProviderSpec): boolean {
  return !!spec.embedModel && spec.embedModel === spec.model
}

export async function testProvider(spec: ProviderSpec): Promise<{ ok: boolean; latencyMs: number; kind: 'chat' | 'embed'; error?: string }> {
  const t0 = Date.now()
  const kind: 'chat' | 'embed' = isEmbedOnly(spec) ? 'embed' : 'chat'
  try {
    const client = clientFor(spec)
    if (kind === 'embed') {
      await client.embeddings.create({ model: spec.embedModel as string, input: 'ping' })
    } else {
      await client.chat.completions.create({
        model: spec.model,
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 5,
      })
    }
    return { ok: true, latencyMs: Date.now() - t0, kind }
  } catch (e) {
    return { ok: false, latencyMs: Date.now() - t0, kind, error: (e as Error).message }
  }
}

export async function listModelsFor(spec: ProviderSpec): Promise<Array<{ id: string }>> {
  try {
    const resp = await clientFor(spec).models.list()
    return resp.data ?? []
  } catch {
    return []
  }
}

export async function listModels(): Promise<Array<{ providerId: string; providerName: string; models: Array<{ id: string }> }>> {
  const out: Array<{ providerId: string; providerName: string; models: Array<{ id: string }> }> = []
  for (const p of listProviders()) {
    out.push({ providerId: p.id, providerName: p.name, models: await listModelsFor(p) })
  }
  return out
}

export async function healthCheckAll(): Promise<ProviderHealth[]> {
  const specs = listProviders()
  return Promise.all(specs.map(async p => {
    const r = await testProvider(p)
    return { id: p.id, ok: r.ok, latencyMs: r.latencyMs, kind: r.kind, error: r.error }
  }))
}
