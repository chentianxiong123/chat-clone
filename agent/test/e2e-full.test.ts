import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'

// ── 全局 mock 边界（e2e 只 mock 这些，其余真跑）──

// 1. RAG 库 + stats 库 → 临时 SQLite（测试语料/统计），不查生产 230MB 库、不碰生产 data/stats.db
vi.mock('../config.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../config.js')>()
  const { makeTempDbs } = await import('./e2e-utils.js')
  const { ragDb, statsDb, cleanup } = makeTempDbs()
  ;(globalThis as Record<string, unknown>).__cleanupTempDbs = cleanup
  ;(globalThis as Record<string, string>).__tempStatsDb = statsDb
  // 让 stats.ts 的 openDb 开临时库（DB_PATH 读 STATS_DB_PATH env）
  process.env.STATS_DB_PATH = statsDb
  return {
    ...orig,
    config: {
      ...orig.config,
      rag: { ...orig.config.rag, dbPath: ragDb, embedEnabled: false, embedEndpoint: '' },
      sim: { ...orig.config.sim, reactMsMin: 0, reactMsMax: 0 },
      humanlike: { ...orig.config.humanlike, react: { min: 0, max: 0, p: 1 } },
    },
  }
})

// 2. LLM 供应商 → 假 streamFn（按脚本返回 tool call 事件），不真调 LLM
import { fakeStreamFn, pushToolCall, pushText, type StepBox, type StepScript } from './fake-stream.js'

// 全局单例容器：fakeStreamFn 闭包捕获这个 box，测试里改 box.steps（vi.mock hoisted 读 box 最新值）
const stepBox: StepBox = { steps: [], idx: 0 }
export function setFakeStreamSteps(steps: StepScript[]) {
  stepBox.steps = steps
  stepBox.idx = 0
}

vi.mock('../pi-provider.js', () => ({
  getPiModel: () => ({
    name: 'agnes-test', id: 'agnes-test',
    cost: { input: 0.5, output: 2, cacheRead: 0, cacheWrite: 0 },
  }),
  getPiStreamFn: () => fakeStreamFn(stepBox),
}))

// 3. v2/store → mock（不碰生产 data/agent.db）：runtime 的 createRun/finishRun/appendEvent
vi.mock('../v2/store.js', () => {
  const mem = new Map<string, Record<string, unknown>>()
  return {
    createRun: (rec: Record<string, unknown>) => { mem.set(String(rec.id), { ...rec }); return rec },
    finishRun: (rec: Record<string, unknown>) => { const r = mem.get(String(rec.id)); if (r) Object.assign(r, rec) },
    appendEvent: () => {},
    getRun: (id: string) => mem.get(id) ?? null,
  }
})

// 4. profile.js → sampleReactMs 返回 0（防 group 场景 sleep 超时）
vi.mock('../profile.js', () => ({
  sampleReactMs: () => 0,
  applyStyle: (s: string) => s,
  replaceMechanismWords: (s: string) => s,
}))

// 5. 导入被测对象（真跑链路：runtime → pi-agent(pi 内核) → pi-tools(门禁+批量) → rag(真查临时库) → stats(真写临时库)）
import { AgentRuntime } from '../v2/runtime.js'
import { searchRag, searchRagBatch } from '../rag.js'
import type { EventBus } from '../v2/bus.js'

/** 查临时 stats.db 的 usage_log（stats.ts 真跑写这里） */
function readTempUsageLog() {
  const p = (globalThis as Record<string, string>).__tempStatsDb
  if (!p) return []
  const db = new DatabaseSync(p)
  const rows = db.prepare('SELECT ts,kind,sub,ok,fail,cost,tokens_in,tokens_out FROM usage_log ORDER BY ts DESC').all()
  db.close()
  return rows as Array<Record<string, unknown>>
}

function mockBus(): EventBus {
  const listeners: Array<(ev: unknown) => void> = []
  return {
    on: (_ch: string, fn: (ev: unknown) => void) => { listeners.push(fn); return { off: () => {} } },
    emit: (ev: unknown) => listeners.forEach(fn => fn(ev)),
    off: () => {},
  } as unknown as EventBus
}

describe('e2e：全盘 mock 边界（LLM/RAG/stats），真跑 runtime+pi 内核+工具+门禁', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    stepBox.idx = 0
  })

  afterAll(() => {
    const cleanup = (globalThis as Record<string, unknown>).__cleanupTempDbs
    if (typeof cleanup === 'function') cleanup()
  })

  it('RAG 临时库可查（加班语料命中）', async () => {
    const result = await searchRag('加班')
    expect(result.length).toBeGreaterThan(0)
    expect(result).toMatch(/加班|麻了|辞职|累/)
  })

  it('searchRagBatch 批量 union 召回（多词一次给够）', async () => {
    const result = await searchRagBatch(['加班', '蓝屏', '键盘'])
    expect(result.length).toBeGreaterThan(0)
    expect(result).toMatch(/加班|蓝屏|键盘|麻了|草|茶轴/)
  })

  it('完整 ReAct：假 LLM 先 search 再 reply（门禁放行 + 真实发出）', async () => {
    // 假 LLM 脚本：第 1 轮调 search_past_memory（批量），第 2 轮调 reply（门禁放行），第 3 轮文本终止
    setFakeStreamSteps([
      (s) => pushToolCall(s, 'search_past_memory', { queries: ['加班', '累', '休息'] }, { input: 300, output: 20 }),
      (s) => pushToolCall(s, 'reply', { messages: ['确实麻了 天天加班'] }, { input: 300, output: 20 }),
      (s) => pushText(s, '', { input: 10, output: 0 }),
    ])

    const bus = mockBus()
    const sent: string[] = []
    const runtime = new AgentRuntime(bus, (_thread, text) => { sent.push(text) })

    const rec = await runtime.runTurn({
      thread: { channel: 'sim', kind: 'private', externalId: 88888 },
      trigger: { type: 'message', triggerNick: '朋友' },
      messages: [{ role: 'user', text: '天天加班累死了', senderId: 1, senderNick: '朋友' }],
    } as never)

    // 回复真发出（门禁放行后 send 被调）
    expect(rec.status).toBe('ok')
    expect(sent.length).toBeGreaterThan(0)
    expect(sent.join(' ')).toMatch(/麻了|加班|累/)

    // usage_log 真写（stats.ts 真跑写临时库）
    const logs = readTempUsageLog()
    expect(logs.length).toBeGreaterThan(0)
    const latest = logs[0]
    expect(latest.kind).toBe('llm')
    expect(latest.tokens_in).toBeGreaterThan(0)
    expect(latest.cost).toBeGreaterThanOrEqual(0)
  })

  it('门禁拦截：假 LLM 不搜就 reply → 被拦（不发出）', async () => {
    // 第 1 轮不搜直接 reply（被门禁拦），第 2 轮沉默终止
    setFakeStreamSteps([
      (_s) => pushToolCall(_s, 'reply', { messages: ['万金油接话'] }, { input: 100, output: 10 }),
      (_s) => pushText(_s, '', { input: 100, output: 0 }),
      (_s) => pushText(_s, '', { input: 10, output: 0 }),
    ])

    const bus = mockBus()
    const sent: string[] = []
    const runtime = new AgentRuntime(bus, (_t, text) => { sent.push(text) })

    await runtime.runTurn({
      thread: { channel: 'sim', kind: 'private', externalId: 88889 },
      trigger: { type: 'message', triggerNick: '朋友' },
      messages: [{ role: 'user', text: '周末有安排没', senderId: 1, senderNick: '朋友' }],
    } as never)

    // 门禁拦住了"万金油接话"（没搜过），没真发
    expect(sent.length).toBe(0)
  })

  it('MAX_SEARCHES 短路：反复搜 8 次后凭印象回（不死循环）', async () => {
    // 连 8 次 search（"没话题"库里没有 → 全没翻到）+ 第 9 次 reply（到上限放行凭印象）
    const searches: Array<StepScript> = []
    for (let i = 0; i < 8; i++) {
      searches.push((_s) => pushToolCall(_s, 'search_past_memory', { queries: ['冷门话题没语料'] } , { input: 50, output: 5 }))
    }
    searches.push((_s) => pushToolCall(_s, 'reply', { messages: ['凭印象回的'] }, { input: 50, output: 10 }))
    searches.push((_s) => pushText(_s, '', { input: 10, output: 0 }))
    setFakeStreamSteps(searches)

    const bus = mockBus()
    const sent: string[] = []
    const runtime = new AgentRuntime(bus, (_t, text) => { sent.push(text) })

    const rec = await runtime.runTurn({
      thread: { channel: 'sim', kind: 'private', externalId: 88890 },
      trigger: { type: 'message', triggerNick: '朋友' },
      messages: [{ role: 'user', text: '冷门话题没语料', senderId: 1, senderNick: '朋友' }],
    } as never)

    // 搜到上限后短路，reply 放行凭印象回
    expect(rec.status).toBe('ok')
    expect(sent.some(s => s.includes('凭印象'))).toBe(true)
  })

  it('沉默场景：LLM 不调 reply → status=skipped + usage_log ok=0', async () => {
    setFakeStreamSteps([
      (_s) => pushText(_s, '', { input: 100, output: 0 }),
    ])

    const bus = mockBus()
    const runtime = new AgentRuntime(bus, vi.fn())

    const rec = await runtime.runTurn({
      thread: { channel: 'sim', kind: 'private', externalId: 88891 },
      trigger: { type: 'message', triggerNick: '朋友' },
      messages: [{ role: 'user', text: '沉默测试', senderId: 1, senderNick: '朋友' }],
    } as never)

    expect(rec.status).toBe('skipped')
    // usage_log 仍记录（ok=0）
    const logs = readTempUsageLog()
    expect(logs.length).toBeGreaterThan(0)
    expect(logs[0].ok).toBe(0)
  })
})
