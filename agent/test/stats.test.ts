import { describe, it, expect, vi } from 'vitest'

// ── mock SQLite（stats.js openDb 不真建库）──
vi.mock('node:sqlite', () => ({
  DatabaseSync: vi.fn().mockImplementation(() => ({
    prepare: vi.fn().mockReturnValue({ run: vi.fn(), get: vi.fn(), all: vi.fn().mockReturnValue([]) }),
    exec: vi.fn(),
  })),
}))

import { recordUsage, getUsageSummary } from '../../stats.js'

describe('stats.ts 用量统计（mock 满）', () => {
  it('recordUsage 调用不崩（SQLite mock）', () => {
    expect(() => recordUsage({
      kind: 'llm', sub: 'agnes-test', ok: 1, fail: 0,
      cost: 0.001, tokensIn: 500, tokensOut: 50, ts: Date.now(),
    })).not.toThrow()
  })

  it('getUsageSummary 返回结构（mock 空数据）', () => {
    const s = getUsageSummary(24)
    expect(s).toHaveProperty('totals')
    expect(s).toHaveProperty('agg')
    expect(s.agg).toHaveProperty('llm')
    expect(s.agg).toHaveProperty('embed')
    expect(s.agg.llm).toHaveProperty('calls')
    expect(s.agg.llm).toHaveProperty('tokensIn')
    expect(s.agg.llm).toHaveProperty('cost')
  })

  it('getUsageSummary hours 参数合法', () => {
    expect(() => getUsageSummary(1)).not.toThrow()
    expect(() => getUsageSummary(72)).not.toThrow()
    expect(() => getUsageSummary(0)).not.toThrow()
  })
})
