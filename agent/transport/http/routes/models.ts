import type { Router } from '../router.js'
import { json, readBody } from '../http.js'
import {
  listProviders, getActiveProvider, setActiveProvider, getProvider,
  listModels, healthCheckAll, testProvider,
} from '../../../domain/models/index.js'

export function registerModelsRoutes(r: Router): void {
  r.get('/api/models', async ({ res }) => {
    const active = getActiveProvider()
    const providers = listProviders().map(p => ({
      id: p.id,
      name: p.name,
      model: p.model,
      baseUrl: p.baseUrl,
      pricePerMIn: p.pricePerMIn,
      pricePerMOut: p.pricePerMOut,
      fallback: p.fallback ?? [],
      active: active?.id === p.id,
    }))
    json(res, 200, {
      active: active?.id ?? null,
      providers,
      remote: await listModels(),
    })
  })

  r.get('/api/models/health', async ({ res }) => {
    json(res, 200, { health: await healthCheckAll() })
  })

  r.post('/api/models/switch', async ({ req, res }) => {
    const body = await readBody(req)
    const r2 = setActiveProvider(String(body.id || ''))
    if (!r2.ok) return json(res, 400, { error: r2.error })
    json(res, 200, { ok: true, active: r2.active?.id })
  })

  r.post('/api/models/test', async ({ req, res }) => {
    const body = await readBody(req)
    const id = String(body.id || '')
    const spec = getProvider(id)
    if (!spec) return json(res, 400, { error: 'unknown provider' })
    json(res, 200, { id, ...await testProvider(spec) })
  })
}
