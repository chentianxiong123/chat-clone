import { config } from './config.js'
import { callLlm, type ChatMessage } from './llm.js'
import { searchRag } from './rag.js'
import { buildSystemPrompt } from './prompt.js'
import WebSocket from 'ws'

// ── 双触发条件参数 ──────────────────────────────────────────────
const BATCH_N = 5          // 攒够 N 条 → 立即触发
const BATCH_T = 60_000     // 距上一条超过 T ms → 触发（防抖）
const MAX_HISTORY = 20     // 每群对话表最长消息数（超了丢最老）
// ────────────────────────────────────────────────────────────────

// 按群分组攒批 + 对话表（OpenAI chat 格式）
const pending = new Map<number, { lines: string[] }>()
const dialogs = new Map<number, ChatMessage[]>()  // 不含 system，system 每次现拼
const timers = new Map<number, ReturnType<typeof setTimeout>>()

const ws = new WebSocket(`ws://${config.napcat.host}:${config.napcat.port}`)

ws.on('open', () => console.log('[Bot] 已连接 NapCat (对话表+双触发, N=5, T=60s)'))

ws.on('message', raw => {
  try {
    const msg = JSON.parse(raw.toString())
    if (msg.post_type !== 'message') return
    if (msg.message_type !== 'group') return
    if (msg.self_id && msg.user_id === msg.self_id) return

    const text = extractText(msg.message)
    if (!text) return

    const gid: number = msg.group_id
    const who = msg.sender?.nickname || '朋友'
    const line = `${who}: ${text}`

    let g = pending.get(gid)
    if (!g) { g = { lines: [] }; pending.set(gid, g) }
    g.lines.push(line)
    console.log(`[Bot] 攒批 g${gid} (${g.lines.length}/${BATCH_N}): ${text.slice(0, 24)}`)

    // 条件A：攒够 N 条 → 立即触发
    if (g.lines.length >= BATCH_N) {
      flush(gid)
      return
    }
    // 条件B：防抖重置，T 秒无新消息 → 触发
    const old = timers.get(gid)
    if (old) clearTimeout(old)
    timers.set(gid, setTimeout(() => flush(gid), BATCH_T))
  } catch (e) {
    console.error('[Bot] 消息处理错误:', e)
  }
})

async function flush(gid: number): Promise<void> {
  const old = timers.get(gid)
  if (old) { clearTimeout(old); timers.delete(gid) }
  const g = pending.get(gid)
  if (!g || g.lines.length === 0) return
  pending.delete(gid)

  const ctx = g.lines.join('\n')
  console.log(`[Bot] 触发 g${gid}: 共 ${g.lines.length} 条`)

  try {
    // RAG 搜索 → 动态 system
    const ragContext = await searchRag(ctx)
    const systemPrompt = buildSystemPrompt(ragContext)

    // 拼接对话表：system + 历史 + 本次
    const hist = (dialogs.get(gid) ?? []).slice(-MAX_HISTORY)
    const userMsg: ChatMessage = { role: 'user', content: `${ctx}\n${config.persona.name}：` }
    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt } as ChatMessage,
      ...hist,
      userMsg,
    ]

    const reply = await callLlm(messages)
    if (!reply) { console.log('[Bot] LLM 无回复，跳过'); return }
    console.log(`[Bot] 回复 g${gid}: ${reply}`)

    // 回写对话表（user+assistant 成对追加，超长截断）
    const assistantMsg: ChatMessage = { role: 'assistant', content: reply }
    const updated: ChatMessage[] = [...hist, userMsg, assistantMsg].slice(-MAX_HISTORY)
    dialogs.set(gid, updated)

    ws.send(JSON.stringify({ action: 'send_msg', params: { group_id: gid, message: reply } }))
  } catch (e) {
    console.error('[Bot] flush 错误:', e)
  }
}

/** 从 OneBot 消息（字符串或CQ段数组）提取纯文本 */
function extractText(message: any): string {
  if (typeof message === 'string') return message
  if (Array.isArray(message)) {
    return message
      .filter(seg => seg.type === 'text' && seg.data?.text)
      .map(seg => seg.data.text)
      .join('')
      .trim()
  }
  return ''
}

ws.on('error', e => console.error('[Bot] WS 错误:', e.message))
ws.on('close', () => {
  console.log('[Bot] 连接断开，5秒后退出')
  setTimeout(() => process.exit(1), 5000)
})