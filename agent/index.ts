import { NCWebsocket } from 'node-napcat-ts'
import { config } from './config.js'
import { AgentCore, sceneKey, type SceneType } from './core.js'
import { startWebUI } from './webui.js'

const core = new AgentCore()

// ── WebUI（先起，便于连不上 NapCat 时也能进控制台）──
startWebUI(core)

// ── NapCat 连接（失败不 crash，WebUI 仍可工作）──
const bot = new NCWebsocket({
  protocol: 'ws',
  host: config.napcat.host,
  port: config.napcat.port,
  reconnection: { enable: true, attempts: 10, delay: 3000 },
})

try {
  await bot.connect()
  core.setConnected(true)
  console.log(`[Bot] 已连接 NapCat (攒批 N=${core.getSnapshot().batchN}, T=${core.getSnapshot().batchT}ms)`)
} catch (e) {
  console.error('[Bot] 连接 NapCat 失败（稍后重连）:', (e as Error).message)
  core.setConnected(false)
}

// ── 群聊消息 ──
bot.on('message.group.normal', async e => {
  try {
    // 自己发的消息跳过
    if (e.user_id === e.self_id) return
    const text = e.raw_message.trim()
    if (!text) return
    const atBot = (e.raw_message || '').includes(`[CQ:at,qq=${e.self_id}]`)
    core.handleMessage({
      scene: 'group',
      groupId: e.group_id,
      senderId: e.user_id,
      senderNick: e.sender?.nickname || '朋友',
      text,
      atBot,
    })
  } catch (err) {
    console.error('[Bot] 群消息处理错误:', err)
  }
})

// ── 私聊消息 ──
bot.on('message.private', async e => {
  try {
    if (e.user_id === e.self_id) return
    const text = e.raw_message.trim()
    if (!text) return
    core.handleMessage({
      scene: 'private',
      senderId: e.user_id,
      senderNick: e.sender?.nickname || '朋友',
      text,
    })
  } catch (err) {
    console.error('[Bot] 私聊处理错误:', err)
  }
})

bot.on('ws.reconnect', () => core.setConnected(false))
bot.on('ws.close', () => core.setConnected(false))

core.onReply = async (scene, id, reply) => {
  if (scene === 'private') {
    await bot.send_private_msg({ user_id: id, message: [{ type: 'text', data: { text: reply } }] })
  } else {
    await bot.send_group_msg({ group_id: id, message: [{ type: 'text', data: { text: reply } }] })
  }
}

// 主动说话心跳（可选）
if (config.humanlike.schedule.proactiveGapMs > 0) {
  setInterval(() => { void core.proactiveTick() }, 60_000)
}

process.on('SIGTERM', () => {
  console.log('[Bot] SIGTERM，退出')
  process.exit(0)
})

// 全局兜底：单条消息/单次请求异常不拖垮整个进程
process.on('unhandledRejection', reason => {
  console.error('[Bot] unhandledRejection:', reason)
})
process.on('uncaughtException', err => {
  console.error('[Bot] uncaughtException:', err)
})

// 保活
setInterval(() => {}, 60_000)