import { config } from './config.js'
import { callLlm } from './llm.js'
import { searchRag } from './rag.js'
import { buildSystemPrompt } from './prompt.js'
import WebSocket from 'ws'

// ── 双触发条件参数 ──────────────────────────────────────────────
const BATCH_N = 5          // 攒够 N 条 → 立即触发
const BATCH_T = 60_000     // 距上一条超过 T ms → 触发（防抖）
// ────────────────────────────────────────────────────────────────

// 按群分组攒批：groupId -> 消息队列
const pending = new Map<number, string[]>()
const timers = new Map<number, ReturnType<typeof setTimeout>>()

const ws = new WebSocket(`ws://${config.napcat.host}:${config.napcat.port}`)

ws.on('open', () => console.log('[Bot] 已连接 NapCat (双触发模式, N=5, T=60s)'))

ws.on('message', raw => {
  try {
    const msg = JSON.parse(raw.toString())
    if (msg.post_type !== 'message') return
    if (msg.message_type !== 'group') return
    // 自己发的消息跳过（NapCat 会推送自己的消息）
    if (msg.self_id && msg.user_id === msg.self_id) return

    const text = extractText(msg.message)
    if (!text) return

    const gid: number = msg.group_id
    const who = msg.sender?.nickname || '朋友'
    const line = `${who}: ${text}`

    if (!pending.has(gid)) pending.set(gid, [])
    pending.get(gid)!.push(line)
    console.log(`[Bot] 攒批 g${gid} (${pending.get(gid)!.length}/${BATCH_N}): ${text.slice(0, 24)}`)

    // 条件A：攒够 N 条 → 立即触发
    if (pending.get(gid)!.length >= BATCH_N) {
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
  const lines = pending.get(gid)
  if (!lines || lines.length === 0) return
  pending.delete(gid)

  const ctx = lines.join('\n')
  console.log(`[Bot] 触发 g${gid}: 共 ${lines.length} 条`)
  try {
    const ragContext = await searchRag(ctx)
    const systemPrompt = buildSystemPrompt(ragContext)
    const userMessage = `${ctx}\n廖：`
    const reply = await callLlm(systemPrompt, userMessage)
    if (!reply) { console.log('[Bot] LLM 无回复，跳过'); return }
    console.log(`[Bot] 回复 g${gid}: ${reply}`)
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