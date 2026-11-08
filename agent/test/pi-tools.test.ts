import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── mock 外部依赖（tools.js 的 searchMemoryNoteBatch 不真查 RAG）──
vi.mock('../../tools.js', () => ({
  searchMemoryNote: vi.fn().mockResolvedValue('（mock 旧记录）'),
  searchMemoryNoteBatch: vi.fn().mockResolvedValue('（mock 批量旧记录）'),
  createMemoryExecutors: vi.fn(() => ({})),
  addFact: vi.fn(),
}))

import { createGate, createPiTools, MAX_SEARCHES, type AgentToolHooks } from '../../pi-tools.js'

function makeTools(gate = createGate()) {
  const hooks: AgentToolHooks = {
    reply: vi.fn().mockResolvedValue(undefined),
  }
  const tools = createPiTools('sim:p:test', hooks, gate)
  return { hooks, tools, gate }
}

describe('pi-tools.ts 搜索门禁 + 批量搜索（mock 满）', () => {
  it('createGate 初始 state', () => {
    const g = createGate()
    expect(g.searchCount).toBe(0)
    expect(g.searchLog.length).toBe(0)
  })

  it('search_past_memory：批量 queries 传多词一次调用，gate.searchCount 递增', async () => {
    const { tools, hooks, gate } = makeTools()
    const search = tools.find(t => t.name === 'search_past_memory')!
    const tool = search as unknown as { execute: (_id: string, params: Record<string, unknown>) => Promise<{ content: { type: string; text: string }[] }> }

    const res = await tool.execute('id1', { queries: ['加班', '累', '休息'] })
    // 返回结果非空（mock 或"没搜到"提示都算有效调用）
    expect(res.content[0].text.length).toBeGreaterThan(0)
    expect(gate.searchCount).toBe(1)
  })

  it('search_past_memory：MAX_SEARCHES 上限后短路提示凭印象回', async () => {
    const gate = createGate()
    gate.searchCount = MAX_SEARCHES // 强制到达上限
    const { tools } = makeTools(gate)
    const search = tools.find(t => t.name === 'search_past_memory')!
    const tool = search as unknown as { execute: (_id: string, params: Record<string, unknown>) => Promise<{ content: { type: string; text: string }[] }> }

    const res = await tool.execute('id2', { queries: ['加班'] })
    // 到上限 → 提示"别再搜了"或"凭印象回"
    expect(res.content[0].text).toMatch(/别再搜了|凭印象/)
  })

  it('reply：没搜过被拦截（逼模型先搜）', async () => {
    const { tools, hooks } = makeTools()
    const reply = tools.find(t => t.name === 'reply')!
    const tool = reply as unknown as { execute: (_id: string, params: Record<string, unknown>) => Promise<{ content: { type: string; text: string }[] }> }

    const res = await tool.execute('id3', { messages: ['测试回复'] })
    expect(res.content[0].text).toContain('拦截')
    expect(res.content[0].text).toContain('没翻旧记录')
    // 没搜过 → hooks.reply 不该被调用
    expect(hooks.reply).not.toHaveBeenCalled()
  })

  it('reply：搜过相关 → 放行（hooks.reply 被调）', async () => {
    const gate = createGate()
    gate.searchCount = 1
    gate.userContent = '确实麻了 累死了'  // 当前话题
    // searchLog 跟话题有"确实"bigram 重合 ≥2
    gate.searchLog.push('你：确实麻了\n你：麻了麻了')
    const { tools, hooks } = makeTools(gate)
    const reply = tools.find(t => t.name === 'reply')!
    const tool = reply as unknown as { execute: (_id: string, params: Record<string, unknown>) => Promise<{ content: { type: string; text: string }[] }> }

    const res = await tool.execute('id4', { messages: ['确实麻了'] })
    expect(res.content[0].text).toContain('已说')
    expect(hooks.reply).toHaveBeenCalledWith(['确实麻了'])
  })

  it('reply：搜到不相关被拦截（gateRelevant 挡）', async () => {
    const gate = createGate()
    gate.searchCount = 1
    gate.userContent = '加班 累死了'  // 当前话题：加班
    // 搜到的是"日本旅游"，跟"加班" bigram 重合 < 2 → 不相关
    gate.searchLog.push('你：日本好玩吗\n你：东京塔怎么去')
    const { tools, hooks } = makeTools(gate)
    const reply = tools.find(t => t.name === 'reply')!
    const tool = reply as unknown as { execute: (_id: string, params: Record<string, unknown>) => Promise<{ content: { type: string; text: string }[] }> }

    const res = await tool.execute('id5', { messages: ['加班烦死了'] })
    // 不相关 → 拦截
    expect(res.content[0].text).toContain('拦截')
    expect(hooks.reply).not.toHaveBeenCalled()
  })
})
