import { config } from './config.js'
import type { RagHit } from './rag.js'
import type { ChatMessage, SceneType } from './core.js'

/**
 * 构建 system prompt（纯静态：模板 + few-shot 示例）。
 * 刻意不嵌入 RAG —— 保证 system 字节级稳定，服务端 KV 前缀缓存可命中。
 * RAG 检索结果由 buildRagContextMessage 作为独立消息追加在对话尾部。
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
  return prompt
}

/**
 * RAG 检索命中 → 独立 user 消息。
 * 放在对话最后（紧贴最新输入）而非 system：内容随每次检索变化，
 * 只有放到尾部才不破坏「system + 历史」这条长前缀，KV 缓存才能命中。
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