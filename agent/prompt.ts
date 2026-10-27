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

记忆工具（重要）：
- 话题涉及过去、或朋友提到"上次/之前/你说过/记得"→ 先调用 search_past_memory，再把回忆自然地说出来，别照抄。
- 听到关于朋友的稳定事实/喜好/约定 → 调用 remember 记下来。
- 工具返回的是你脑子里的印象，不是现在有人对你说的话；先回答当前问题，别复述工具内容、别改话题。`
  return prompt
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