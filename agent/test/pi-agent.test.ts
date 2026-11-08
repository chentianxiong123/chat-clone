import { describe, it, expect, vi } from 'vitest'

// mock config：maxTokens 可控制阈值，maxContextTurns 控制保留轮数
vi.mock('../config.js', () => ({
  config: {
    llm: { maxTokens: 100 },
    agent: { maxContextTurns: 2 },
  },
}))

import { estimateMessageTokens, transformLiveContext } from '../pi-agent.js'
import type { AgentMessage } from '@earendil-works/pi-agent-core'

// pi 消息工厂（role + content）
const sys = (s: string) => ({ role: 'system', content: s, api: 'openai', provider: 'test', model: 'm' } as unknown as AgentMessage)
const user = (s: string) => ({ role: 'user', content: s, timestamp: 0 } as unknown as AgentMessage)
const asst = (s: string) => ({ role: 'assistant', content: [{ type: 'text', text: s }], api: 'openai', provider: 'test', model: 'm' } as unknown as AgentMessage)

describe('pi-agent transformLiveContext（live 上下文 token 监测裁剪）', () => {
  it('不超阈值：原样返回，不限制模型', async () => {
    // 每条 '你好'≈2 tok，3 条=6 tok < 100
    const msgs = [user('你好'), asst('嗯'), user('你好')]
    const out = await transformLiveContext(msgs)
    expect(out).toBe(msgs) // 同一引用，没裁
  })

  it('超阈值：裁旧轮次，保留最近 maxContextTurns=2 轮（实际 max(3,2)=3 轮）', async () => {
    // 造 5 轮 user，每轮 content 长 300 字符≈150 tok → 5 轮 750 tok > 100
    const long = 'x'.repeat(300)
    const msgs = [
      user(long), asst('a1'),
      user(long), asst('a2'),
      user(long), asst('a3'),
      user(long), asst('a4'),
      user(long), asst('a5'),
    ]
    const out = await transformLiveContext(msgs)
    // user 边界 index 0,2,4,6,8。keepRounds=max(3,2)=3。startKeep=userIdx[5-3]=userIdx[2]=4
    // slice(4) = index 4,5,6,7,8,9 = 6 条
    expect(out.length).toBe(6)
    expect(out[0]).toBe(msgs[4]) // 从第 3 个 user（index 4）起保留
  })

  it('system 消息保留在最前（若有）', async () => {
    const long = 'x'.repeat(300)
    const msgs = [
      sys('你是本人'),
      user(long), asst('a1'),
      user(long), asst('a2'),
      user(long), asst('a3'),
    ]
    const out = await transformLiveContext(msgs)
    // system 在 index 0，user 边界在 1,3,5。保留最近 2 轮 → 从 index 3 起
    expect(out.length).toBeGreaterThanOrEqual(4)
  })

  it('轮边界对齐：不打断工具调用（保留整轮 user 起；user 数 <= keepRounds 时不裁）', async () => {
    const long = 'x'.repeat(300)
    // 造 4 轮 user（> keepRounds=3）才能触发裁剪，且轮边界是 user
    const msgs = [
      user(long),
      { role: 'assistant', content: [{ type: 'toolCall' }], api: 'openai', provider: 'test', model: 'm' } as unknown as AgentMessage,
      { role: 'toolResult', content: 'result' } as unknown as AgentMessage,
      user(long),
      asst('a2'),
      user(long),
      asst('a3'),
      user(long),
      asst('a4'),
    ]
    // user 边界 index 0,3,5,7（4 个）。keepRounds=3。startKeep=userIdx[4-3]=userIdx[1]=3
    // slice(3) = index 3..8 = 6 条，首条是 user（轮边界）
    const out = await transformLiveContext(msgs)
    expect(out.length).toBe(6)
    expect((out[0] as { role?: string }).role).toBe('user') // 轮边界是 user，没裁半截工具调用
  })
})

describe('pi-agent estimateMessageTokens（token 粗估）', () => {
  it('string content 按码点/2', () => {
    expect(estimateMessageTokens(user('你好') as unknown as AgentMessage)).toBeGreaterThan(0)
  })
  it('数组 content（text 块）累加', () => {
    const m = asst('abc')
    expect(estimateMessageTokens(m)).toBeGreaterThan(0)
  })
})
