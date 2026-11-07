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

  // 工具契约：工具是唯一行动方式，精确名调用。回复一次可返回多条，每条即一条消息。
  prompt += `
## 工具
你是正常对话模型，靠工具自己查，别指望被喂：
- search_past_memory(query)：查本人和朋友的历史聊天（口癖/知识库）。多查多用，学本人怎么说话、用过的词和梗。
- reply(text)：开口说一句。
- remember(note)：记住关于朋友/群友的稳定事实/喜好/约定。

## 回复
- 照真实聊天记录的味道来，想怎么回怎么回；顺着对方原句的词接。
- 多用 search_past_memory 查真实记录，用查到的说法接现在这句。

## 对话
- 现在要接的是：对方刚发的那条。
- 当前对话历史是「现在」在聊的，话题以它为准，接上别断、别胡言乱语。
- search_past_memory 查到的是「多年前」真实记录：只学说话味道、回忆旧事，别当成现在的话接、别照抄整句。`
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
      let sample = shuffled.slice(0, Math.min(40, lines.length))
      // 口癖去噪：把样本里「含口癖的本人应答行」压到 ≤15%（防满口口癖被照抄），保留少量点缀。
      // 口癖列表复用 style.fillers（emm/啊这/……/2333/离谱），模型自己写口癖、程序不硬插。
      const fillers = (config.humanlike.style?.fillers || []).map(f => f.trim()).filter(Boolean)
      if (fillers.length) {
        const isFill = (l: string) => fillers.some(f => l.includes(f))
        const selfFillIdx = sample
          .map((l, i) => ({ l, i }))
          .filter(({ l }) => l.startsWith('本人:') && isFill(l))
          .map(({ i }) => i)
        const maxFills = Math.max(1, Math.round(sample.length * 0.15))
        if (selfFillIdx.length > maxFills) {
          const drop = new Set(selfFillIdx.slice(0, selfFillIdx.length - maxFills))
          sample = sample.filter((_, i) => !drop.has(i))
        }
      }
      return '\n\n【多年前的真实对话示例】（你和朋友平时真实的聊天，随机抽的，学那个味道，别照抄整句）\n' +
        sample.join('\n').replace(/^本人:/gm, `${config.persona.name}:`)
    }
  }
  return ''
}
