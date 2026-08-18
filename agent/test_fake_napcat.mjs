// 假 NapCat：验证双触发逻辑（不碰真QQ）
import { WebSocketServer } from 'ws'

const PORT = 3999
const wss = new WebSocketServer({ port: PORT })
const replies = []
let agentWs = null

wss.on('connection', ws => {
  agentWs = ws
  console.log('[fake] agent 已连接 ✓')
  ws.on('message', raw => {
    const msg = JSON.parse(raw.toString())
    if (msg.action === 'send_msg') {
      replies.push(msg.params.message)
      console.log(`[fake] 📨 agent 回复: ${msg.params.message}`)
    }
  })

  // 测试1：5条连发 → 条件A 立即触发（预期1次回复）
  console.log('\n[fake] ── 测试1：连发5条(条件A: 数量≥5) ──')
  const batch = [
    { who: '明月', text: '其实' },
    { who: '明月', text: '不是' },
    { who: '明月', text: '别尬黑' },
    { who: '群友A', text: '这就对了' },
    { who: '群友A', text: '直接打靶' },
  ]
  batch.forEach((m, i) => setTimeout(() => send(ws, m), i * 800))

  // 测试2：1条后等40秒无新消息 → 条件B 防抖触发
  setTimeout(() => {
    console.log('\n[fake] ── 测试2：单发1条后停40s(条件B: 防抖) ──')
    send(ws, { who: '群友B', text: '你们别吵了' })
  }, 12000)

  // 60s 后看结果
  setTimeout(() => {
    console.log(`\n[fake] 总回复数: ${replies.length}（期望测试1约1条 + 测试2约1条 = 2条左右）`)
    process.exit(0)
  }, 90000)
})

function send(ws, m) {
  ws.send(JSON.stringify({
    post_type: 'message', message_type: 'group', group_id: 719972557,
    user_id: 10001, sender: { nickname: m.who }, message: m.text, self_id: 999,
  }))
}