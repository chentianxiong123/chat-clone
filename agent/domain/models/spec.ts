export interface ProviderSpec {
  id: string
  name: string
  type: 'openai' | 'azure' | 'openai-compatible'
  baseUrl?: string
  apiKey?: string
  model: string
  temperature?: number
  maxTokens?: number
  pricePerMIn?: number
  pricePerMOut?: number
  fallback?: string[]
  timeout?: number
  enabled?: boolean
  embedModel?: string
  proxy?: string
}

export interface ProvidersFile {
  active?: string
  providers: ProviderSpec[]
}

function num(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return undefined
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined
}

function normalizeProvider(raw: unknown): ProviderSpec | null {
  if (!raw || typeof raw !== 'object') return null
  const p = raw as Record<string, unknown>
  const id = str(p.id)
  const model = str(p.model)
  if (!id || !model) return null
  const spec: ProviderSpec = {
    id,
    name: str(p.name) || id,
    type: (p.type === 'azure' || p.type === 'openai') ? p.type : 'openai-compatible',
    model,
    baseUrl: str(p.baseUrl),
    apiKey: typeof p.apiKey === 'string' ? p.apiKey : undefined,
    temperature: num(p.temperature),
    maxTokens: num(p.maxTokens),
    pricePerMIn: num(p.pricePerMIn),
    pricePerMOut: num(p.pricePerMOut),
    timeout: num(p.timeout),
    embedModel: str(p.embedModel),
    proxy: str(p.proxy),
    enabled: p.enabled !== false,
    fallback: Array.isArray(p.fallback) ? p.fallback.filter((x): x is string => typeof x === 'string') : [],
  }
  return spec
}

export function normalizeProvidersFile(raw: unknown): ProvidersFile {
  const file = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {}
  const providers = Array.isArray(file.providers)
    ? file.providers.map(normalizeProvider).filter((p): p is ProviderSpec => p !== null)
    : []
  return {
    active: str(file.active),
    providers,
  }
}
