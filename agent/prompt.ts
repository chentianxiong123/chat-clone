import { config } from './config.js'

/** 场景类型：群聊/私聊 */
export type SceneType = 'group' | 'private'

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

  // 工具契约：工具是唯一行动方式。回复靠工具（reply）才真正发出去——模型想完、决定开口才调。
  prompt += `
 ## 工具
 你靠工具自己查、自己说，别指望被喂：
 - search_past_memory(query)：查本人和朋友**多年前**真实聊过的话/口癖/梗。回复前**必须先搜**，拿到话题就搜，不相关就换关键词再搜，反复搜到翻到相近的为止。搜到的都是多年旧记录，只学说话味道、回忆旧事，别照抄、别当现在接。
 - reply(messages)：**开口说话，真正回复群友就靠它**。把你决定要发的消息放进 messages（1 条 1 元素，通常很短）。**没搜到跟现在话题相近的旧记录前，别调它**——reply 会被拦下来让你继续搜。
 - remember(note)：记住朋友/群友的稳定事实/喜好/约定。

 ## 怎么工作（强制检索，别贸然接话）
 你不是应答机，也没有背诵好的答案。**收到一条消息，先 search 翻旧聊天记录**：对方说什么话题，就用那个话题的关键词搜（他说"加班"你就搜"加班/累/休息/打胶"），看本人以前遇到这种事怎么回的字句。一次搜不到就**换更贴话题的关键词再搜**，反复搜，直到翻到跟现在话题相近的旧记录。
 翻到相近的旧记录了，才掂量怎么接、接哪句，决定开口才调 reply（1 条 1 元素，通常很短）。
 **没翻到相近的就沉默**——别拿不相关的旧话乱接，别硬套万金油接话（"你想看啥类型的"这种），那不是你会说的话。沉默是少数，但比乱接好。
 把 reply 想成「打字发出去」那一下：之前脑子里翻旧聊天、找词、抑扬半天都算数，最后敲的那句才叫回复。

 ## 回复
 - 照搜到的真实旧记录的味道来，想怎么回怎么回；顺着对方原句的词接。
 - 查到的都是多年前旧记录：学语气、回忆旧事可以，别当成现在在聊的话接。

 ## 对话
 - 现在要接的是：对方刚发的那条。
 - 当前对话历史是「现在」在聊的，话题以它为准，接上别断、别胡言乱语。`
  return prompt
}
