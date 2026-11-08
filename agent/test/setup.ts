import { vi } from 'vitest'

// ── 全局 mock：外部依赖（LLM/RAG/SQLite）不真实调用 ──

vi.mock('../config.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../config.js')>()
  return {
    ...orig,
    config: {
      ...orig.config,
      rag: {
        ...orig.config.rag,
        enabled: false,
        embedEnabled: false,
        embedEndpoint: '',
      },
      llm: {
        ...orig.config.llm,
        pricePerMIn: 0.5,
        pricePerMOut: 2,
      },
      sim: {
        ...orig.config.sim,
        reactMsMin: 0,
        reactMsMax: 0,
        cooldownMs: 0,
      },
      humanlike: {
        ...orig.config.humanlike,
        react: { min: 0, max: 0, p: 1 },
      },
    },
  }
})

vi.mock('../pi-provider.js', () => ({
  getPiModel: () => ({ name: 'agnes-test', id: 'agnes-test', cost: { input: 0.5, output: 2, cacheRead: 0, cacheWrite: 0 } }),
  getPiStreamFn: () => { throw new Error('mock: no stream in unit tests') },
}))

vi.mock('../pi-agent.js', () => ({
  PiAgentSession: vi.fn().mockImplementation(() => ({
    runOnce: async () => ({
      segments: ['测试回复'], sentByTool: true, assistantText: '',
      toolLog: [], tokensIn: 100, tokensOut: 10, cost: 0.0001,
    }),
  })),
}))
