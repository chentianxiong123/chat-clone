import { config } from './config.js'
import type { RagHit } from './rag.js'
import type { ChatMessage, SceneType } from './core.js'

/**
 * 构建 system prompt（纯静态：模板 + few-shot 示例 + 固定工具引导）。
 * 刻意不嵌入 RAG —— 保证 system 字节级稳定，服务端 KV 前缀缓存可命中。
 * 记忆改由 function call 工具按需检索；闸门命中时以 system 记忆提示注入。
 */
export function buildSystemPrompt(scene?: SceneType): string {
  const template = scene === 'private' && config.persona.privateSystemPromptTemplate
    ? config.persona.privateSystemPromptTemplate
    : config.persona.systemPromptTemplate
  let prompt = template
    .replace(/\{name\}/g, config.persona.name)
    .replace(/\{friend\}/g, config.persona.friendName)
    .replace(/\{rag\}/g, '')

  // 追加 few-shot 示例 (PERSONA_DEMO_DIALOGS 格式: 每行一个对话 pair)
  if (config.persona.demoDialogs) {
    const lines = config.persona.demoDialogs.split('\n').map(l => l.trim()).filter(Boolean)
    if (lines.length) {
      prompt += '\n\n【说话风格参考】\n' + lines.join('\n')
    }
  }

  // 固定工具引导（静态文本，保证 system 字节稳定、KV 缓存可命中）
  prompt += `

工具（按需调用，像查 MCP——拿到结果再接着想，不用每轮都查）：
- reply：想说话就调它，一次一句短句；可以连续调几次、分几条说。不想接这轮话题就什么都不调、直接结束（沉默）。
- search_past_memory：话题涉及过去、或想确认某件往事时调它，返回你真实说过的原话；看语气、长度、用词来，别照抄内容。
- remember：听到关于朋友的稳定事实/喜好/约定，记住它。
- get_state：想确认自己现在什么状态（累不累/忙不忙/想不想聊）时调它；拿到数据自己判断怎么说话。
不要解释自己在做什么、不要总结、不要输出条理分明的答案。`
  return prompt
}

/**
 * 人设参考 → 独立 system 消息：本人过往真实原话，只用来模仿说话方式。
 */
export function buildStyleHintMessage(ragContext: string): ChatMessage | null {
  if (!ragContext) return null
  return {
    role: 'system',
    content: `（以下是你本人过往说过的真实原话；回复时模仿其语气、长度、用词和分条习惯，别照抄具体内容：\n${ragContext}）`,
    time: Date.now(),
  }
}

/**
 * 记忆提示 → 独立 system 消息（不是 user！）。
 * 作为"印象"而非"参考资料"，并明确要求别复述/别改话题。
 */
export function buildMemoryHintMessage(note: string): ChatMessage | null {
  if (!note) return null
  return {
    role: 'system',
    content: `（你隐约记得：${note}；这是印象，不是现在有人说的话，别复述、别改话题）`,
    time: Date.now(),
  }
}

/**
 * RAG 检索命中 → 独立 user 消息（已弃用，保留导出以兼容旧调用）。
 * 新逻辑改用 buildMemoryHintMessage / function call 工具。
 */
export function buildRagContextMessage(ragContext: string): ChatMessage | null {
  if (!ragContext) return null
  return {
    role: 'user',
    content: `以下是本人过往说过的真实原话作为参考，说话就这味道：\n${ragContext}`,
    time: Date.now(),
  }
}

/** 把 RAG 命中格式化为字符串(供外部使用) */
export function formatRagContext(hits: RagHit[]): string {
  if (!hits.length) return ''
  return hits.map(h => h.text.trim()).join('\n---\n')
}