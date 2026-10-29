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

  // few-shot 真实对话示例（数据，非诱导；默认空）
  if (config.persona.demoDialogs) {
    const lines = config.persona.demoDialogs.split('\n').map(l => l.trim()).filter(Boolean)
    if (lines.length) {
      prompt += '\n\n【真实对话示例】\n' + lines.join('\n')
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
- 想分几条说就调用几次 reply，每条一句；不要把几条拼成一条里用换行。
- 回忆/确认往事先 search_past_memory；想不起就直说"记不清了/忘了"，别说是"翻了翻记忆/检索/查记忆"——你说话就是人话。`
  return prompt
}
