import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── mock 外部依赖（v2 链路：pi 内核 + 统计 + 存储）──

let runOnceMock: ReturnType<typeof vi.fn>

vi.mock('../../pi-provider.js', () => ({
  getPiModel: () => ({ name: 'agnes-test', id: 'agnes-test', cost: { input: 0.5, output: 2, cacheRead: 0, cacheWrite: 0 } }),
  getPiStreamFn: () => { throw new Error('mock: no stream in unit tests') },
}))

// 用 class 而非 arrow fn，否则 "is not a constructor"
vi.mock('../../pi-agent.js', () => {
  class MockPiAgentSession {
    constructor() {}
    runOnce(_q: string): Promise<unknown> {
      return runOnceMock(_q)
    }
  }
  return { PiAgentSession: MockPiAgentSession }
})

vi.mock('../../profile.js', () => ({
  sampleReactMs: () => 0, // mock 掉 sleep，避免 group 场景真实等待
  applyStyle: (s: string) => s,
  replaceMechanismWords: (s: string) => s,
}))

vi.mock('../../stats.js', () => ({
  recordUsage: vi.fn(),
}))

vi.mock('../../v2/store.js', () => ({
  appendEvent: vi.fn(),
  createRun: vi.fn().mockReturnValue({
    id: 'test_run', thread_id: 'test', trigger: 'message',
    started_at: Date.now(), model: '', status: 'pending',
  }),
  finishRun: vi.fn(),
}))

import { AgentRuntime } from '../../v2/runtime.js'
import { recordUsage } from '../../stats.js'
import { sampleReactMs } from '../../profile.js'
import type { EventBus } from '../../v2/bus.js'

function mockBus(): EventBus {
  const listeners: Array<(ev: unknown) => void> = []
  return {
    on: (_ch: string, fn: (ev: unknown) => void) => { listeners.push(fn); return { off: () => {} } },
    emit: (ev: unknown) => listeners.forEach(fn => fn(ev)),
    off: () => {},
  } as unknown as EventBus
}

describe('v2/runtime.ts LLM 用量统计对接（mock 满）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    runOnceMock = vi.fn().mockResolvedValue({
      segments: ['回复了'], sentByTool: true, assistantText: '',
      toolLog: [], tokensIn: 500, tokensOut: 50, cost: 0.0006,
    })
  })

  it('LLM 跑完自动写 usage_log：recordUsage(kind=llm, tokensIn=500, cost=0.0006)', async () => {
    const bus = mockBus()
    const runtime = new AgentRuntime(bus, vi.fn())

    const rec = await runtime.runTurn({
      thread: { channel: 'sim', kind: 'private', externalId: 99999 },
      trigger: { type: 'message', triggerNick: '朋友' },
      messages: [{ role: 'user', text: '测试统计', senderId: 1, senderNick: '朋友' }],
    } as never)

    expect(vi.mocked(recordUsage)).toHaveBeenCalledTimes(1)
    const call = vi.mocked(recordUsage).mock.calls[0][0]
    expect(call.kind).toBe('llm')
    expect(call.tokensIn).toBe(500)
    expect(call.tokensOut).toBe(50)
    expect(call.cost).toBe(0.0006)
    expect(call.ok).toBe(1)
    expect(call.fail).toBe(0)
    expect(call.sub).toContain('agnes-test')
    expect(rec.status).toBe('ok')
  })

  it('LLM 沉默也记录 usage（ok=0, fail=1, tokensIn=200）', async () => {
    runOnceMock = vi.fn().mockResolvedValue({
      segments: [], sentByTool: false, assistantText: '',
      toolLog: [], tokensIn: 200, tokensOut: 0, cost: 0.0001,
    })

    const bus = mockBus()
    const runtime = new AgentRuntime(bus, vi.fn())

    await runtime.runTurn({
      thread: { channel: 'sim', kind: 'private', externalId: 99998 },
      trigger: { type: 'message', triggerNick: '朋友' },
      messages: [{ role: 'user', text: '沉默测试', senderId: 1, senderNick: '朋友' }],
    } as never)

    expect(vi.mocked(recordUsage)).toHaveBeenCalled()
    const call = vi.mocked(recordUsage).mock.calls.at(-1)![0]
    expect(call.ok).toBe(0)
    expect(call.fail).toBe(1)
    expect(call.tokensIn).toBe(200)
  })

  it('group 场景也记录 usage（channel=qq 不跳）', async () => {
    const bus = mockBus()
    const runtime = new AgentRuntime(bus, vi.fn())

    await runtime.runTurn({
      thread: { channel: 'qq', kind: 'group', externalId: 719972557 },
      trigger: { type: 'message', triggerNick: '群友A' },
      messages: [{ role: 'user', text: '群消息', senderId: 2, senderNick: '群友A' }],
    } as never)

    expect(vi.mocked(recordUsage)).toHaveBeenCalled()
  })
})
