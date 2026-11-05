import { config } from './config.js'
import type { SceneType } from './core.js'

/**
 * 构建 system prompt（成熟 agent 稳定前缀结构，参照 OpenClaw/Hermes）：
 *   [身份行 + 行为规范（SOUL.md）] → [工具契约] → [回复契约]
 * 全部静态、字节级稳定（服务端 KV 前缀缓存命中）；不嵌 RAG、不注入动态状态。
 * 行为决策（回不回/冷却/静默）由外部系统控制；措辞规范在 SOUL（长度匹配/防废话/不确定直说）。
 */
export function buildSystemPrompt(scene?: SceneType): string {
  const template = scene === 'private' && config.persona.privateSystemPromptTemplate
    ? config.persona.privateSystemPromptTemplate
    : config.persona.systemPromptTemplate
  let prompt = template
    .replace(/\{name\}/g, config.persona.name)
    .replace(/\{friend\}/g, config.persona.friendName)
    .replace(/\{rag\}/g, '')

  // 纯净模式：一切提示词都不要（连身份都不给），纯 LLM 直答
  if (config.agent.pureMode) {
    return ''
  }

  // 工具契约：工具是唯一行动方式（MUST use tools），精确名调用。
  // reply 一次可返回多条，每条就是一条消息——按工具格式分割，不靠程序切。
  prompt += `
## 工具
你是正常对话模型，靠工具自己查，别指望被喂：
- search_past_memory(query)：查本人和朋友的历史聊天（口癖/知识库）。每次开口前先查一下，用本人以前用过的词、说法、梗，别自己编新的。
- reply(text)：开口说一句。可一次返回多条，每条就是一条消息（按条发送，不拆分）。
- remember(note)：记住关于朋友/群友的稳定事实/喜好/约定。

## 回复
- 你的味道就是"崽种"：口语、粗话、短句、直接、有态度，跟历史聊天记录一个味。
- 每次回复前先用 search_past_memory 查本人和朋友怎么聊的；用查到的说法/口癖接现在这句。
- 你只能说本人真实说过的话（search_past_memory 和示例里查到的词句），可以自己组合，但不能编造没出现过的词、表情、句式。
- 组合时只能把真实句子的词拼起来，别给词添字（"爬"就是"爬"，别说成"爬呗"；"呗"只在真实出现过的地方用）。
- 调 reply 发消息，1-3 条，每条很短；不解释、不给方案、不科普。
- 表情只能从真实聊天出现过的（😅👴）里选；口癖（啊这/emm/离谱）偶尔有一句就行，别每条都带。`
  return prompt
}

/**
 * 风格样本（数据式人设）：真实聊天记录，AI 看"我们平时怎么聊"理解并模仿。
 * 关键：这是「动态内容」——每次随机抽子集（多样性，避免教坏/口癖单一），
 * 因此必须作为独立消息放「消息数组尾部」（历史之后），绝不能进 system prompt
 * （官方最佳实践：静态前缀/动态尾部；动态值进 system 会破坏前缀缓存命中）。
 */
export function buildDemoDialog(): string {
  if (config.persona.demoDialogs) {
    const lines = config.persona.demoDialogs.split('\n').map(l => l.trim()).filter(Boolean)
    if (lines.length) {
      const shuffled = [...lines].sort(() => Math.random() - 0.5)
      const sample = shuffled.slice(0, Math.min(40, lines.length))
      return '\n\n【真实对话示例】（你和朋友平时真实的聊天，随机抽的，照这个味道来）\n' +
        sample.join('\n').replace(/^本人:/gm, `${config.persona.name}:`)
    }
  }
  return ''
}
