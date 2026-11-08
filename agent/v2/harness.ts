import { config } from '../config.js'
import type { EventBus } from './bus.js'
import type { AgentRuntime } from './runtime.js'
import {
  appendEvent, ensureThread, getThreadDetail, getThreadMeta, listEvents, listThreads, markRead, setArchived, setPaused,
  threadMessageCounts, touchThread,
} from './store.js'
import {
  isSimGroupId, parseThreadKey, threadKey, threadTitle,
  type InboundMessage, type RunRecord, type ThreadMeta, type ThreadRef, type V2Event,
} from './types.js'
import { recordGroupMsg } from '../stats.js'

interface Pending {
  thread: ThreadRef
  lines: InboundMessage[]
  targetN: number
  woke: boolean
  lastNick: string
  triggerNick: string
  deadlineAt: number
}

const randInt = (min: number, max: number): number => {
  if (max <= min) return min
  return min + Math.floor(Math.random() * (max - min + 1))
}

function quietHours(): boolean {
  const q = config.humanlike.schedule.quietHours
  if (!q) return false
  const m = q.match(/(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/)
  if (!m) return false
  const [, sh, sm, eh, em] = m
  const now = new Date()
  const cur = now.getHours() * 60 + now.getMinutes()
  const s = Number(sh) * 60 + Number(sm)
  const e = Number(eh) * 60 + Number(em)
  if (s <= e) return cur >= s && cur <= e
  return cur >= s || cur <= e
}

function sceneAllowed(thread: ThreadRef): boolean {
  if (thread.channel === 'sim') {
    // 模拟群：除真群外的一切群 + 私聊（号段不再限制）
    return thread.kind === 'private' || !config.sim.realGroups.includes(thread.externalId)
  }
  // qq 通道 = 唯一真群
  const key = threadKey(thread)
  const bare = String(thread.externalId)
  if (config.agent.denyScenes.some(x => x === key || x === bare)) return false
  if (config.agent.allowScenes.length && !config.agent.allowScenes.some(x => x === key || x === bare)) return false
  return true
}

function wokeBy(msg: InboundMessage): boolean {
  if (msg.atBot) return true
  return config.persona.wakeWords.some(w => msg.text.includes(w))
}

export class Harness {
  private pending = new Map<string, Pending>()
  private timers = new Map<string, ReturnType<typeof setTimeout>>()
  private inflight = new Set<string>()
  private connected = false

  /** 协议端连接状态（QQ/milky 插上/断开） */
  setConnected(v: boolean): void {
    if (this.connected === v) return
    this.connected = v
    this.emitStored({ type: 'connection.changed', thread: '', connected: v, at: Date.now() } as unknown as V2Event)
  }

  /** 清空全部内存上下文（对齐 pi reset：模拟/QQ 会话都清，归档不动） */
  clearAll(): void {
    for (const t of this.timers.values()) clearTimeout(t)
    this.timers.clear()
    this.pending.clear()
    this.inflight.clear()
    this.runtime.clearSessions()
  }

  constructor(
    private readonly bus: EventBus,
    private readonly runtime: AgentRuntime,
  ) {}

  private emitStored(ev: V2Event): void {
    appendEvent(ev)
    this.bus.emit(ev)
  }

  async handleMessage(msg: InboundMessage): Promise<RunRecord | null> {
    const thread = msg.thread
    if (!sceneAllowed(thread)) {
      console.log(`[Harness] 拒绝场景 ${threadKey(thread)}（白/黑名单或模拟号段）`)
      return null
    }
    const key = threadKey(thread)
    const meta = touchThread(msg)
    this.emitStored({ type: 'message.received', thread: key, message: msg, at: msg.at ?? Date.now() })
    this.emitStored({ type: 'thread.updated', thread: key, at: Date.now() })
    console.log(`[V2] 收到 ${key} ${msg.atBot ? '(@)' : ''} ${msg.senderNick}: ${msg.text.slice(0, 40)}`)

    // 真群消息计数（group_stats，sim 不记）
    if (thread.channel === 'qq' && thread.kind === 'group' && thread.externalId) {
      recordGroupMsg(Number(thread.externalId))
    }

    if (meta.paused) {
      console.log(`[V2] ${key} 已暂停，只记录不回复`)
      return null
    }

    // 静默时段（凌晨睡觉时间）直接不回复——sim 通道跳过（测试要随时能测）
    if (thread.channel !== 'sim' && quietHours()) {
      console.log(`[V2] ${key} 静默时段，不回复`)
      return null
    }

    if (thread.channel === 'sim' && !msg.policy) {
      console.log(`[V2] 模拟直发 ${key}（不攒批）`)
      return this.runNow(thread, [msg], {
        reason: msg.atBot ? 'mention' : 'message',
        batchSize: 1,
        triggerNick: msg.senderNick,
        woke: !!msg.atBot,
      })
    }

    // QQ 通道：保留旧 core 的「攒批 + 群静默」策略；v2 目前先用于模拟通道。
    let g = this.pending.get(key)
    if (!g) {
      g = {
        thread,
        lines: [],
        targetN: thread.kind === 'private' ? config.agent.privateBatchN : randInt(config.batch.nMin, config.batch.nMax),
        woke: false,
        lastNick: msg.senderNick,
        triggerNick: msg.senderNick,
        deadlineAt: 0,
      }
      this.pending.set(key, g)
    }
    g.lines.push(msg)
    g.lastNick = msg.senderNick
    if (msg.atBot || wokeBy(msg)) {
      g.woke = true
      g.triggerNick = msg.senderNick
    }
    if (g.lines.length > g.targetN) g.lines = g.lines.slice(-g.targetN)
    console.log(`[V2] 攒批 ${key} (${g.lines.length}/${g.targetN}${g.woke ? '' : ' 待唤醒'}): ${msg.text.slice(0, 30)}`)

    if (thread.kind === 'private') {
      void this.flush(key)
    } else {
      this.armIdle(key, thread)
    }
    return null
  }

  private armIdle(key: string, _thread: ThreadRef): void {
    const old = this.timers.get(key)
    if (old) clearTimeout(old)
    const g = this.pending.get(key)
    if (!g) return
    const deadlineAt = Date.now() + config.batch.t
    g.deadlineAt = deadlineAt
    const handle = setTimeout(() => {
      this.timers.delete(key)
      const cur = this.pending.get(key)
      if (!cur) return
      const n = cur.lines.length
      const shouldFlush = cur.woke || n >= cur.targetN
      console.log(`[V2] 群静默到期 ${key} (${n}/${cur.targetN}${cur.woke ? ' 唤醒' : ''}) → ${shouldFlush ? '触发' : '继续等'}`)
      if (shouldFlush) void this.flush(key)
    }, config.batch.t)
    this.timers.set(key, handle)
  }

  private async flush(key: string, force = false): Promise<void> {
    if (this.inflight.has(key)) return
    const g = this.pending.get(key)
    if (!g) return
    if (!force && g.thread.kind === 'group' && !g.woke && g.lines.length < g.targetN) return
    console.log(`[V2] 触发 ${key} ${g.lines.length}条 ${g.woke ? '(唤醒)' : '(攒够)'}`)
    this.pending.delete(key)
    const timer = this.timers.get(key)
    if (timer) { clearTimeout(timer); this.timers.delete(key) }
    this.inflight.add(key)
    try {
      await this.runtime.runTurn({
        thread: g.thread,
        messages: g.lines,
        trigger: {
          reason: g.woke ? 'mention' : 'timer',
          batchSize: g.lines.length,
          triggerNick: g.triggerNick,
          woke: g.woke,
        },
      })
    } finally {
      this.inflight.delete(key)
      if (this.pending.has(key)) {
        const next = this.pending.get(key)!
        if (next.thread.kind === 'private') void this.flush(key)
        else this.armIdle(key, next.thread)
      }
    }
  }

  flushThread(id: string): boolean {
    if (!this.pending.has(id)) return false
    void this.flush(id, true)
    return true
  }

  private async runNow(
    thread: ThreadRef,
    messages: InboundMessage[],
    trigger: { reason: 'message' | 'mention'; batchSize: number; triggerNick: string; woke: boolean },
  ): Promise<RunRecord> {
    const key = threadKey(thread)
    this.inflight.add(key)
    try {
      return await this.runtime.runTurn({ thread, messages, trigger })
    } finally {
      this.inflight.delete(key)
    }
  }

  // ── 控制台 API ─────────────────────────────────────────────────────────
  getThreads(): ThreadMeta[] {
    return listThreads()
  }

  getThreadsWithCounts(): { threads: ThreadMeta[]; counts: Record<string, number> } {
    return { threads: listThreads(), counts: threadMessageCounts() }
  }

  getThread(id: string) {
    return getThreadDetail(id)
  }

  getEvents(thread?: string, limit = 200): V2Event[] {
    return listEvents(thread, limit)
  }

  markRead(id: string): void {
    markRead(id)
  }

  setPaused(id: string, paused: boolean): ThreadMeta | null {
    setPaused(id, paused)
    const meta = getThreadDetail(id).meta
    if (meta) this.emitStored({ type: 'thread.updated', thread: id, at: Date.now() })
    return meta
  }

  archiveThread(id: string, archived: boolean): ThreadMeta | null {
    const t = this.timers.get(id)
    if (t) { clearTimeout(t); this.timers.delete(id) }
    this.pending.delete(id)
    const meta = setArchived(id, archived)
    if (meta) this.emitStored({ type: 'thread.updated', thread: id, at: Date.now() })
    return meta
  }

  /** 归档全部模拟群（测试素材）：只标记 archived=1，不删数据，释放 SIM_MAX_THREADS 配额 */
  archiveAllSim(): number {
    const sims = listThreads().filter(t => t.channel === 'sim' && !t.archived)
    for (const t of sims) {
      const timer = this.timers.get(t.id)
      if (timer) { clearTimeout(timer); this.timers.delete(t.id) }
      this.pending.delete(t.id)
      setArchived(t.id, true)
      this.emitStored({ type: 'thread.updated', thread: t.id, at: Date.now() })
    }
    return sims.length
  }

  createSimThread(kind: 'group' | 'private', id?: number): ThreadMeta {
    const externalId = kind === 'group'
      ? (id ?? config.sim.defaultGroup)
      : (id || 10001)
    if (kind === 'group' && !isSimGroupId(externalId)) {
      throw new Error(`群号 ${externalId} 是真群（SIM_REAL_GROUPS），不能创建为模拟群`)
    }
    const key = threadKey({ channel: 'sim', kind, externalId })
    if (!getThreadMeta(key)) {
      const activeSims = listThreads().filter(t => t.channel === 'sim' && !t.archived).length
      if (activeSims >= config.sim.maxThreads) {
        throw new Error(`模拟群已达上限 ${config.sim.maxThreads}（SIM_MAX_THREADS），请先归档/清理旧的`)
      }
    }
    return ensureThread({ channel: 'sim', kind, externalId })
  }

  parseThread(id: string): ThreadRef | null {
    return parseThreadKey(id)
  }

  threadTitle(ref: ThreadRef): string {
    return threadTitle(ref)
  }

  getSnapshot(): Record<string, unknown> {
    return {
      connected: this.connected,
      mode: 'v2-pi',
      batch: { nMin: config.batch.nMin, nMax: config.batch.nMax, t: config.batch.t },
      batchN: config.batch.nMin,
      batchT: config.batch.t,
      sim: {
        groupMin: config.sim.groupMin,
        groupMax: config.sim.groupMax,
        defaultGroup: config.sim.defaultGroup,
      },
      pending: [...this.pending.entries()].map(([key, g]) => ({
        key,
        size: g.lines.length,
        targetN: g.targetN,
        woke: g.woke,
        deadlineAt: g.deadlineAt,
        lines: g.lines.map(m => `${m.senderNick}: ${m.text}`),
      })),
      inflight: [...this.inflight],
    }
  }
}
