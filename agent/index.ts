import { config } from './config.js'
import { callLlm, type ChatMessage } from './llm.js'
import { searchRag } from './rag.js'
import { buildSystemPrompt } from './prompt.js'
import { NCWebsocket } from 'node-napcat-ts'

// ── 双触发条件参数 ──────────────────────────────────────────────
const BATCH_N = 5          // 攒够 N 条 → 立即触发
const BATCH_T = 60_000     // 距上一条超过 T ms → 触发（防抖）
const MAX_HISTORY = 20     // 每群对话表最长消息数（超了丢最老）
const REPLY_COOLDOWN = 25_000 // 两条回复之间的最小间隔（防刷屏/防风控）
// ────────────────────────────────────────────────────────────────

let lastReplyAt = 0          // 上次发送回复的时间戳

// 按群分组攒批 + 对话表（OpenAI chat 格式）
const pending = new Map<number, { lines: string[] }>()
const dialogs = new Map<number, ChatMessage[]>()  // 不含 system，system 每次现拼
const timers = new Map<number, ReturnType<typeof setTimeout>>()

const bot = new NCWebsocket({
  protocol: 'ws',
  host: config.napcat.host,
  port: config.napcat.port,
  reconnection: { enable: true, attempts: 10, delay: 3000 },
})

await bot.connect()
console.log('[Bot] 已连接 NapCat (对话表+双触发, N=5, T=60s)')

bot.on('message.group.normal', async e => {
  try {
    // 自己发的消息跳过（NapCat 会推送自己的消息）
    if (e.user_id === e.self_id) return

    const text = e.raw_message.trim()
    if (!text) return

    const gid = e.group_id
    const who = e.sender?.nickname || '朋友'
    const line = `${who}: ${text}`

    let g = pending.get(gid)
    if (!g) { g = { lines: [] }; pending.set(gid, g) }
    g.lines.push(line)
    console.log(`[Bot] 攒批 g${gid} (${g.lines.length}/${BATCH_N}): ${text.slice(0, 24)}`)

    // 条件A：攒够 N 条 → 立即触发
    if (g.lines.length >= BATCH_N) {
      void flush(gid)
      return
    }
    // 条件B：防抖重置，T 秒无新消息 → 触发
    const old = timers.get(gid)
    if (old) clearTimeout(old)
    timers.set(gid, setTimeout(() => void flush(gid), BATCH_T))
  } catch (err) {
    console.error('[Bot] 消息处理错误:', err)
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

    // 发消息一定要慢：距上一条回复至少 REPLY_COOLDOWN
    const wait = lastReplyAt + REPLY_COOLDOWN - Date.now()
    if (wait > 0) await sleep(wait)
    await bot.send_group_msg({ group_id: gid, message: [{ type: 'text', data: { text: reply } }] })
    lastReplyAt = Date.now()
  } catch (err) {
    console.error('[Bot] flush 错误:', err)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}