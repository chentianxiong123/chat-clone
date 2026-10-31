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

  // 风格样本：真实聊天记录（数据式人设）——AI 看"我们平时怎么聊"理解并模仿，
  // 粗口/口语/长短句自然体现，不由提示词描述定义。把"本人:"换成 {name} 便于识别。
  if (config.persona.demoDialogs) {
    const lines = config.persona.demoDialogs.split('\n').map(l => l.trim()).filter(Boolean)
    if (lines.length) {
      prompt += '\n\n【真实对话示例】（这是你和朋友平时真实的聊天，照这个味道来）\n' +
        lines.join('\n').replace(/^本人:/gm, `${config.persona.name}:`)
    }
  }

  // 工具契约：工具是唯一行动方式（MUST use tools），精确名调用。
  // reply 一次可返回多条，每条就是一条消息——按工具格式分割，不靠程序切。
  prompt += `
## 工具
工具是唯一行动方式，名字精确调用：
- reply(text)：开口说一句。可一次返回多条，每条就是一条消息（按条发送，不拆分）。
- search_past_memory(query)：唤醒记忆——查你真实说过的原话。
- remember(note)：记住关于朋友的稳定事实/喜好/约定。

## 回复
- 要说话就调 reply，内容就是你对朋友说的话本身。
- 调 reply，把要发的消息放进 messages 数组，想发几条填几条（通常 1-3 条，很短）；别把一个想法拆成一堆，别长篇解释。
- 尽量用你俩平时真实说过的词和说法（口语、粗话、梗都行），别用书面/技术/客服腔，别自己编新词、别给一堆方案。
- 回忆/确认往事先 search_past_memory；想不起就直说"记不清了/忘了"，别说是"翻了翻记忆/检索/查记忆"——你说话就是人话。`
  return prompt
}
