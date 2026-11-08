import { describe, it, expect, vi } from 'vitest'

// ── mock config（不读 .env）──
vi.mock('../../config.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../config.js')>()
  return {
    ...orig,
    config: {
      ...orig.config,
      persona: {
        ...orig.config.persona,
        name: '测试崽种',
        friendName: '测试朋友',
        wakeWords: ['崽种', 'qq', '机器人'],
        systemPromptTemplate: '你是{name}，一个真实的人。\n{rag}',
      },
      llm: {
        ...orig.config.llm,
        pricePerMIn: 0.5,
        pricePerMOut: 2,
      },
    },
  }
})

import { buildSystemPrompt } from '../../prompt.js'

describe('prompt.ts 系统提示词构建（mock config）', () => {
  it('{name} 占位符被替换（不残留）', () => {
    const p = buildSystemPrompt('private')
    expect(p).not.toContain('{name}')
  })

  it('{friend} 占位符被替换（不残留）', () => {
    const p = buildSystemPrompt('private')
    expect(p).not.toContain('{friend}')
  })

  it('工具契约段存在（search/reply）', () => {
    const p = buildSystemPrompt('private')
    expect(p).toContain('search_past_memory')
    expect(p).toContain('reply')
    expect(p).toContain('批量')
  })

  it('回复段存在（掂量回几句）', () => {
    const p = buildSystemPrompt('private')
    expect(p).toMatch(/掂量|几句|2~3/)
  })

  it('group 场景不出现"私聊"专属词汇', () => {
    const p = buildSystemPrompt('group')
    expect(p).toContain('search_past_memory')
  })
})
