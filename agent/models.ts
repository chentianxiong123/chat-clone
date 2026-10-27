import OpenAI from 'openai'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from './config.js'

/**
 * ── 模型注册表 / Provider 管理 ─────────────────────────────────────────────
 * 参考 AstrBot provider 体系：结构化 JSON 存多套 provider，
 * 运行时热切换活跃模型，支持 fallback 链与健康测试。
 *
 * 配置文件: <DATA_DIR>/providers.json
 *    key 支持 "$ENV_VAR" 引用（不落明文密钥，同 AstrBot $KEY 约定）
 */

const DATA_DIR = join(dirname(fileURLToPath(new URL('.', import.meta.url))), 'data')
const PROVIDERS_PATH = join(DATA_DIR, 'providers.json')

export interface ProviderSpec {
  id: string
  name: string
  type: 'openai' | 'azure' | 'openai-compatible'
  /** api base；为空则用 openai 官方 */
  baseUrl?: string
  /** 支持 "$ENV_VAR" 引用 */
  apiKey?: string
  model: string
  temperature?: number
  maxTokens?: number
  pricePerMIn?: number
  pricePerMOut?: number
  /** 失败时按顺序顺延的 provider id */
  fallback?: string[]
  timeout?: number
  enabled?: boolean
}

interface ProvidersFile {
  active?: string
  providers: ProviderSpec[]
}

let _cache: ProvidersFile | null = null
let _clients = new Map<string, OpenAI>()

function loadIfExists(): ProvidersFile | null {
  if (!existsSync(PROVIDERS_PATH)) return null
  try {
    return JSON.parse(readFileSync(PROVIDERS_PATH, 'utf8')) as ProvidersFile
  } catch (e) {
    console.warn('[Models] providers.json 解析失败:', (e as Error).message)
    return null
  }
}

/** 读取 providers；文件不存在时用 .env 的 LLM_* 生成默认 provider（兼容旧配置） */
export function getProvidersFile(forceReload = false): ProvidersFile {
  if (_cache && !forceReload) return _cache
  const fromFile = loadIfExists()
  if (fromFile && fromFile.providers?.length) {
    _cache = fromFile
    return fromFile
  }
  // 兜底：.env 单模型
  const fallback: ProvidersFile = {
    active: 'default',
    providers: [{
      id: 'default',
      name: `${config.llm.model || '默认'} (.env)`,
      baseUrl: config.llm.baseUrl,
      apiKey: config.llm.apiKey,
      model: config.llm.model,
      maxTokens: config.llm.maxTokens,
      temperature: config.llm.temperature,
      pricePerMIn: config.llm.pricePerMIn,
      pricePerMOut: config.llm.pricePerMOut,
    }],
  }
  _cache = fallback
  return fallback
}

/** 持久化 providers（保留 unknow fields） */
export function saveProvidersFile(pf: ProvidersFile): void {
  mkdirSync(DATA_DIR, { recursive: true })
  writeFileSync(PROVIDERS_PATH, JSON.stringify(pf, null, 2) + '\n', 'utf8')
  _cache = pf
}

/** 解析 key：$ENV 引用 → 环境变量实际值 */
export function resolveKey(key?: string): string {
  if (!key) return ''
  const m = key.match(/^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/)
  if (m) return process.env[m[1]] || ''
  return key
}

/** 所有 enabled provider 列表 */
export function listProviders(forceReload = false): ProviderSpec[] {
  return getProvidersFile(forceReload).providers.filter(p => p.enabled !== false)
}

export function getProvider(id: string): ProviderSpec | undefined {
  return getProvidersFile().providers.find(p => p.id === id)
}

/** 当前活跃 provider（活跃 id 不存在或被禁则回退第一个可用） */
export function getActiveProvider(): ProviderSpec | undefined {
  const pf = getProvidersFile()
  const activeId = pf.active
  const all = pf.providers
  const find = (id: string) => all.find(p => p.id === id && p.enabled !== false)
  return find(activeId || '') ?? all.find(p => p.enabled !== false)
}

/** 热切换活跃模型，写盘持久化（重启仍保留）。返回新活跃 provider */
export function setActiveProvider(id: string): { ok: boolean; active?: ProviderSpec; error?: string } {
  const pf = getProvidersFile(true)
  const target = pf.providers.find(p => p.id === id)
  if (!target) return { ok: false, error: `未知 provider: ${id}` }
  if (target.enabled === false) return { ok: false, error: `provider ${id} 未启用` }
  pf.active = id
  saveProvidersFile(pf)
  return { ok: true, active: target }
}

/** 懒加载每个 provider 的 OpenAI client（首次用到才建，切模型无需重启） */
export function clientFor(spec: ProviderSpec): OpenAI {
  const cached = _clients.get(spec.id)
  if (cached) return cached
  const client = new OpenAI({
    baseURL: spec.baseUrl || undefined,
    apiKey: resolveKey(spec.apiKey) || 'sk-none',
    timeout: spec.timeout ?? 120_000,
    defaultHeaders: { 'User-Agent': 'chat-clone-agent/0.1.0' },
  })
  _clients.set(spec.id, client)
  return client
}

/** 列出某 provider 可用模型（模型下拉用） */
export async function listModelsFor(spec: ProviderSpec): Promise<Array<{ id: string }>> {
  try {
    const resp = await clientFor(spec).models.list()
    return resp.data ?? []
  } catch (e) {
    return []
  }
}

/** 健康测试：发一个最小 chat completion，返回通不通/耗时/错误 */
export async function testProvider(spec: ProviderSpec): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const t0 = Date.now()
  try {
    const client = clientFor(spec)
    await client.chat.completions.create({
      model: spec.model,
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 5,
    })
    return { ok: true, latencyMs: Date.now() - t0 }
  } catch (e) {
    return { ok: false, latencyMs: Date.now() - t0, error: (e as Error).message }
  }
}