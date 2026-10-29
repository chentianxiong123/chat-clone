import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { config } from '../../config.js'
import { paths } from '../../paths.js'
import { type ProviderSpec, type ProvidersFile, normalizeProvidersFile } from './spec.js'

let _cache: ProvidersFile | null = null

function loadIfExists(): ProvidersFile | null {
  if (!existsSync(paths.providers)) return null
  try {
    return normalizeProvidersFile(JSON.parse(readFileSync(paths.providers, 'utf8')))
  } catch (e) {
    console.warn('[Models] providers.json 解析失败:', (e as Error).message)
    return null
  }
}

/** 仅当 providers.json 缺失/为空时使用：从 .env 的 LLM_* 生成一次性种子 */
function seedFromEnv(): ProvidersFile {
  return {
    active: 'default',
    providers: [{
      id: 'default',
      name: `${config.llm.model || '默认'} (.env 种子)`,
      type: 'openai-compatible',
      baseUrl: config.llm.baseUrl,
      apiKey: config.llm.apiKey ? '$LLM_API_KEY' : undefined,
      model: config.llm.model || 'gpt-4o-mini',
      maxTokens: config.llm.maxTokens,
      temperature: config.llm.temperature,
      pricePerMIn: config.llm.pricePerMIn,
      pricePerMOut: config.llm.pricePerMOut,
      enabled: true,
      fallback: [],
    }],
  }
}

/**
 * providers.json 是模型的唯一真相源。
 * .env 的 LLM_* 仅在文件缺失时作为种子，并立即落盘，之后运行时不再读取 .env 的模型字段。
 */
export function getProvidersFile(forceReload = false): ProvidersFile {
  if (_cache && !forceReload) return _cache
  const fromFile = loadIfExists()
  if (fromFile && fromFile.providers.length) {
    _cache = fromFile
    return fromFile
  }
  const seed = seedFromEnv()
  try {
    saveProvidersFile(seed)
  } catch (e) {
    console.warn('[Models] 种子 providers.json 落盘失败:', (e as Error).message)
    _cache = seed
  }
  return _cache ?? seed
}

export function saveProvidersFile(pf: ProvidersFile): void {
  const normalized = normalizeProvidersFile(pf)
  mkdirSync(dirname(paths.providers), { recursive: true })
  writeFileSync(paths.providers, JSON.stringify(normalized, null, 2) + '\n', 'utf8')
  _cache = normalized
}

export function resolveKey(key?: string): string {
  if (!key) return ''
  const m = key.match(/^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/)
  if (m) return process.env[m[1]] || ''
  return key
}

export function listProviders(forceReload = false): ProviderSpec[] {
  return getProvidersFile(forceReload).providers.filter(p => p.enabled !== false)
}

export function getProvider(id: string): ProviderSpec | undefined {
  return getProvidersFile().providers.find(p => p.id === id)
}

export function getActiveProvider(): ProviderSpec | undefined {
  const pf = getProvidersFile()
  const find = (id: string) => pf.providers.find(p => p.id === id && p.enabled !== false)
  return find(pf.active || '') ?? pf.providers.find(p => p.enabled !== false)
}

export function setActiveProvider(id: string): { ok: boolean; active?: ProviderSpec; error?: string } {
  const pf = getProvidersFile(true)
  const target = pf.providers.find(p => p.id === id)
  if (!target) return { ok: false, error: `未知 provider: ${id}` }
  if (target.enabled === false) return { ok: false, error: `provider ${id} 未启用` }
  saveProvidersFile({ ...pf, active: id })
  return { ok: true, active: target }
}

export function getEmbedProvider(): ProviderSpec | undefined {
  const pf = getProvidersFile()
  if (config.rag.embedProvider) {
    return pf.providers.find(p => p.id === config.rag.embedProvider && p.enabled !== false && p.embedModel)
  }
  return pf.providers.find(p => p.enabled !== false && p.embedModel)
}

export function listEmbedProviders(): Array<{ id: string; name: string; model: string; embedModel: string }> {
  return getProvidersFile().providers
    .filter(p => p.enabled !== false && p.embedModel)
    .map(p => ({ id: p.id, name: p.name, model: p.model, embedModel: p.embedModel as string }))
}
