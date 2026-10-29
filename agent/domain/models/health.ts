import { clientFor } from './client.js'
import { listProviders } from './registry.js'
import type { ProviderSpec } from './spec.js'

export interface ProviderHealth {
  id: string
  ok: boolean
  latencyMs: number
  error?: string
}

export async function testProvider(spec: ProviderSpec): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const t0 = Date.now()
  try {
    await clientFor(spec).chat.completions.create({
      model: spec.model,
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 5,
    })
    return { ok: true, latencyMs: Date.now() - t0 }
  } catch (e) {
    return { ok: false, latencyMs: Date.now() - t0, error: (e as Error).message }
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
    return { id: p.id, ok: r.ok, latencyMs: r.latencyMs, error: r.error }
  }))
}
