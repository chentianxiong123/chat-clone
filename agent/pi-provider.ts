/**
 * pi-ai 自定义 provider：把 chat-clone 的 providers.json 活跃上游（agnes-2.5-flash，OpenAI 兼容）
 * 注册成 pi-ai 的 Model + streamFn，让 pi-agent-core 复用 pi 的流式/工具循环。
 *
 * 只依赖 pi 的 core（pi-agent-core + pi-ai），不碰 pi-durable/其他应用层。
 */
import { createModels, createProvider } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import type { StreamFn } from '@earendil-works/pi-agent-core'
import { getActiveProvider, resolveKey } from './domain/models/index.js'

export { getActiveProvider }
import { config } from './config.js'

let _models: ReturnType<typeof createModels> | null = null
let _streamFn: StreamFn | null = null

/** 构造 pi-ai Models（懒初始化），返回 streamSimple 绑定的 streamFn，Agent 用它跑 loop。 */
export function getPiStreamFn(): StreamFn {
  if (_streamFn) return _streamFn

  const p = getActiveProvider()
  if (!p) throw new Error('pi-provider: 无活跃 provider（providers.json 空）')

  const baseUrl = p.baseUrl || config.llm.baseUrl || 'http://127.0.0.1:9999/v1'
  const apiKey = resolveKey(p.apiKey)
  const modelId = p.model || config.llm.model || 'agnes-2.5-flash'
  // pi 库 calculateCost 假设 cost.input/output 是「每百万 token 价格」（内部 /1e6），
  // 这里传原始 pricePerMIn/Out（每百万），别提前除（否则双重除 1e6 → cost≈0）
  const inputPrice = p.pricePerMIn ?? 0
  const outputPrice = p.pricePerMOut ?? 0
  const maxTokens = p.maxTokens || config.llm.maxTokens || 2048

  const provider = createProvider({
    id: p.id || 'local',
    name: p.name || '本地模型',
    baseUrl,
    auth: {
      apiKey: {
        name: 'API key',
        resolve: async () => (apiKey ? { auth: { apiKey } } : undefined),
      },
    },
    models: [
      {
        id: modelId,
        name: p.name || modelId,
        api: 'openai-completions',
        baseUrl,
        provider: p.id || 'local',
        reasoning: false,
        input: ['text'],
        cost: { input: inputPrice, output: outputPrice, cacheRead: 0, cacheWrite: 0 },
        contextWindow: maxTokens * 8,
        maxTokens,
        type: 'chat',
      },
    ],
    api: openAICompletionsApi(),
  })

  _models = createModels()
  _models.setProvider(provider)
  _streamFn = _models.streamSimple.bind(_models)
  return _streamFn
}

/** 已构造的 pi-ai Models（无则懒建）。内部用。 */
function getPiModels(): ReturnType<typeof createModels> {
  getPiStreamFn()
  return _models!
}

/** 已注册的 chat model（Agent initialState.model 用）。 */
export function getPiModel(): ReturnType<ReturnType<typeof createModels>['getAllModels']>[number] {
  const models = getPiModels()
  const all = models.getAllModels()
  const chat = all.find((m) => m.type === 'chat' || !m.type)
  if (!chat) throw new Error('pi-provider: 无已注册 chat model')
  return chat
}