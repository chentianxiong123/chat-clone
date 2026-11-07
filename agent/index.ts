import { NCWebsocket } from 'node-napcat-ts'
import { config } from './config.js'
import { startWebUI, bindTransport } from './webui.js'
import { createKernel } from './v2/kernel.js'
import { QQAdapter } from './v2/channels/qq.js'
import { NapCatTransport } from './v2/channels/napcat.js'
import { MilkyTransport } from './v2/channels/milky.js'
import { milkyCtl } from './milky-ctl.js'
import { logReply } from './reply-log.js'
import type { BotTransport } from './v2/channels/transport.js'

const v2 = createKernel()

// ── WebUI（先起，便于连不上协议端时也能进控制台）──
startWebUI(v2)

// ── 触发协议端：milky 由 agent spawn（全控制），fs.watch 事件驱动状态；崩了等用户手动拉起 ──
milkyCtl.init()

// ── 协议端插头：按 config.channel 自由切换（napcat | milky），核心零改动 ──
let transport: BotTransport
if (config.channel === 'milky') {
  transport = new MilkyTransport({ host: config.milky.host, port: config.milky.port, token: config.milky.token })
  // 登录成功（.ks 写入，fs.watch 事件）→ milky 3000 起来 → 重连消息通道（事件驱动，非轮询）
  milkyCtl.onLogin(() => transport.reconnect())
  // 有登录态但用户手动点「拉起」→ milky 自动登录恢复 → 3000 起 → 延迟重连一次（单次定时非轮询，milky 由用户子进程控制）
  if (milkyCtl.hasLogin()) {
    const un = milkyCtl.subscribe(s => {
      if (s.running && s.loggedIn) {
        un()
        setTimeout(() => transport.reconnect(), 3000)
      }
    })
  }
} else {
  const bot = new NCWebsocket({
    protocol: config.napcat.protocol,
    host: config.napcat.host,
    port: config.napcat.port,
    accessToken: config.napcat.token || undefined,
    reconnection: { enable: true, attempts: 10, delay: 3000 },
  })
  const nap = new NapCatTransport(bot)
  nap.attach()
  v2.attachQQ(new QQAdapter(bot))
  transport = nap
}
// 面板「重连」需要操作当前插头
bindTransport(transport)
const channelName = config.channel === 'milky' ? 'Milky' : 'NapCat'

try {
  await transport.connect()
  v2.setConnected(true)
  console.log(`[Bot] 已连接 ${channelName}`)
} catch (e) {
  console.error(`[Bot] 连接 ${channelName} 失败（稍后重连）:`, (e as Error).message)
  v2.setConnected(false)
}

// ── 连接状态 ──
transport.onStatus(ok => v2.setConnected(ok))

// ── v2 回复出口：路由到当前 transport（milky/napcat）──
v2.setSender(async (thread, text) => {
  logReply(thread.kind === 'group' ? 'group' : 'private', thread.externalId, text)
  if (thread.kind === 'group') await transport.sendGroup(thread.externalId, text)
  else await transport.sendPrivate(thread.externalId, text)
})

// ── 群聊消息（v2 内核：攒批+群静默在 harness）──
transport.onGroup(e => {
  try {
    void v2.handleMessage({
      thread: { channel: 'qq', kind: 'group', externalId: e.groupId },
      senderId: e.senderId,
      senderNick: e.senderNick,
      text: e.text,
      atBot: e.atBot,
      at: Date.now(),
    })
  } catch (err) {
    console.error('[Bot] 群消息处理错误:', err)
  }
})

// ── 私聊消息 ──
transport.onPrivate(e => {
  try {
    void v2.handleMessage({
      thread: { channel: 'qq', kind: 'private', externalId: e.senderId },
      senderId: e.senderId,
      senderNick: e.senderNick,
      text: e.text,
      at: Date.now(),
    })
  } catch (err) {
    console.error('[Bot] 私聊处理错误:', err)
  }
})

// 主动说话心跳（可选；v2 暂无主动说话，保留定时钩子占位）
if (config.humanlike.schedule.proactiveGapMs > 0) {
  setInterval(() => { /* v2 proactive 待接 */ }, 60_000)
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
