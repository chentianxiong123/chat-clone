import { config } from './config.js'
import { callLlm } from './llm.js'
import { timingDecision, type MsgContext } from './timing.js'
import { searchRag } from './rag.js'
import { buildSystemPrompt, buildUserMessage } from './prompt.js'
import WebSocket from 'ws'

const ws = new WebSocket(`ws://${config.napcat.host}:${config.napcat.port}`)

ws.on('open', () => console.log('[Bot] 已连接 NapCat'))
ws.on('message', async raw => {
  try {
    const msg = JSON.parse(raw.toString())
    if (msg.post_type !== 'message') return

    const ctx: MsgContext = {
      text: msg.message || '',
      sender: msg.sender?.nickname || '朋友',
      groupId: msg.group_id,
      userId: msg.user_id,
      messageType: msg.message_type === 'group' ? 'group' : 'private',
    }

    const decision = timingDecision(ctx)
    if (!decision.shouldReply) {
      console.log(`[Bot] 忽略: ${ctx.text.slice(0, 30)}`)
      return
    }

    console.log(`[Bot] 等待 ${decision.waitSeconds}s 后回复 (burst=${decision.burst})`)
    await sleep(decision.waitSeconds * 1000)

    const ragContext = await searchRag(ctx.text)
    const systemPrompt = buildSystemPrompt(ragContext)
    const userMessage = buildUserMessage(ctx.text, ctx.sender)

    const reply = await callLlm(systemPrompt, userMessage)
    if (!reply) return

    const targetKey = ctx.messageType === 'group' ? 'group_id' : 'user_id'
    const targetVal = ctx.messageType === 'group' ? ctx.groupId : ctx.userId

    if (decision.burst > 1 && reply.length > 4) {
      const splitPoint = Math.floor(reply.length * 0.5)
      const part1 = reply.slice(0, splitPoint).trim()
      const part2 = reply.slice(splitPoint).trim()
      if (part1 && part2) {
        ws.send(JSON.stringify({ action: 'send_msg', params: { [targetKey]: targetVal, message: part1 } }))
        await sleep(1500)
        ws.send(JSON.stringify({ action: 'send_msg', params: { [targetKey]: targetVal, message: part2 } }))
        return
      }
    }

    ws.send(JSON.stringify({ action: 'send_msg', params: { [targetKey]: targetVal, message: reply } }))
  } catch (e) {
    console.error('[Bot] 错误:', e)
  }
})

ws.on('error', e => console.error('[Bot] WS 错误:', e.message))
ws.on('close', () => {
  console.log('[Bot] 连接断开，5秒后重连')
  setTimeout(() => process.exit(1), 5000)
})

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}