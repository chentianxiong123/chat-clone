import { config } from './config.js'
import type { RagHit } from './rag.js'

/** 构建 system prompt: 模板 + ragContext + few-shot 示例 */
export function buildSystemPrompt(ragContext: string): string {
  let prompt = config.persona.systemPromptTemplate
    .replace(/\{name\}/g, config.persona.name)
    .replace(/\{friend\}/g, config.persona.friendName)
    .replace(/\{rag\}/g, ragContext ? `以下聊天记录是本人说过的真实原话，你说话就这味道：\n${ragContext}` : '')

  // 追加 few-shot 示例 (PERSONA_DEMO_DIALOGS 格式: 每行一个对话 pair)
  if (config.persona.demoDialogs) {
    const lines = config.persona.demoDialogs.split('\n').map(l => l.trim()).filter(Boolean)
    if (lines.length) {
      prompt += '\n\n【说话风格参考】\n' + lines.join('\n')
    }
  }
  return prompt
}

/** 把 RAG 命中格式化为 system 字符串(供外部使用) */
export function formatRagContext(hits: RagHit[]): string {
  if (!hits.length) return ''
  return hits.map(h => h.text.trim()).join('\n---\n')
}