import { config } from './config.js'
import type { SceneType } from './core.js'

/**
 * 构建 system prompt（纯静态：身份 + 工具存在性说明）。
 * 刻意不嵌 RAG、不写任何行为约束/风格诱导——LLM 给什么都会在意，
 * 约束性文字（"挑着回/不总结/别照抄/别复述"）会让模型过度执行甚至反向强化。
 * 行为决策（回不回、多长、几条、冷却、主动冒泡）全部由外部系统（代码）控制；
 * LLM 上下文只留：稳定身份 + 客观数据（历史、工具返回的真实原话）。
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

  // 工具存在性说明：只告诉有哪些工具、干什么用的，不写"想不想用/该不该用/别照抄"——
  // 那是决策，交给外部系统；模型只负责用工具产出内容。
  prompt += `
可用工具：
- reply(text)：输出你说的话（一次一句，可多次）。
- search_past_memory(query)：查你真实说过的原话。
- remember(note)：记住关于朋友的稳定事实/喜好/约定。`
  return prompt
}
