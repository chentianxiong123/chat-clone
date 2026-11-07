import { EventBus } from './bus.js'
import { AgentRuntime } from './runtime.js'
import { Harness } from './harness.js'
import { SimAdapter } from './channels/sim.js'
import type { QQAdapter } from './channels/qq.js'
import type { EventListener } from './bus.js'
import { threadKey } from './types.js'
import type { InboundMessage, RunRecord, ThreadMeta, ThreadRef, V2Event } from './types.js'

export class AgentKernel {
  readonly bus = new EventBus()
  readonly sim = new SimAdapter()
  readonly runtime: AgentRuntime
  readonly harness: Harness
  private qq: QQAdapter | null = null
  private sender: ((thread: ThreadRef, text: string) => Promise<void>) | null = null

  constructor() {
    this.runtime = new AgentRuntime(this.bus, (thread, text) => this.send(thread, text))
    this.harness = new Harness(this.bus, this.runtime)
  }

  attachQQ(adapter: QQAdapter): void {
    this.qq = adapter
  }

  /** 协议端连接状态（QQ/milky 插上/断开） */
  setConnected(v: boolean): void {
    this.harness.setConnected(v)
  }

  /** 清空全部内存上下文（对齐 pi reset：清 live 上下文，归档不动） */
  clearDialog(): void {
    this.harness.clearAll()
  }

private send(thread: ThreadRef, text: string): Promise<void> {
    console.log(`[V2] 发送 ${threadKey(thread)}: ${text.slice(0, 50)}`)
    if (thread.channel === 'sim') return this.sim.send(thread, text)
    // 非 sim（qq/milky）：优先走外部注入的真实发送（当前 transport）
    if (this.sender) return this.sender(thread, text)
    if (!this.qq) return Promise.reject(new Error('QQ adapter 未接入'))
    return this.qq.send(thread, text)
  }

  /** 注入真实发送：路由到当前 transport（milky/napcat）。优先于内置 adapter。 */
  setSender(fn: (thread: ThreadRef, text: string) => Promise<void>): void {
    this.sender = fn
  }

  handleMessage(msg: InboundMessage): Promise<RunRecord | null> {
    return this.harness.handleMessage(msg)
  }

  subscribe(fn: EventListener): () => void {
    return this.bus.subscribe(fn)
  }

  getThreads(): ThreadMeta[] {
    return this.harness.getThreads()
  }

  getThreadsWithCounts(): { threads: ThreadMeta[]; counts: Record<string, number> } {
    return this.harness.getThreadsWithCounts()
  }

  getThread(id: string) {
    return this.harness.getThread(id)
  }

  getEvents(thread?: string, limit = 200): V2Event[] {
    return this.harness.getEvents(thread, limit)
  }

  getSnapshot(): Record<string, unknown> {
    return this.harness.getSnapshot()
  }

  markRead(id: string): void {
    this.harness.markRead(id)
  }

  flushThread(id: string): boolean {
    return this.harness.flushThread(id)
  }

  setPaused(id: string, paused: boolean): ThreadMeta | null {
    return this.harness.setPaused(id, paused)
  }

  archiveThread(id: string, archived: boolean): ThreadMeta | null {
    return this.harness.archiveThread(id, archived)
  }

  /** 归档全部模拟群（测试素材）：只标记 archived=1，不删数据，释放配额 */
  archiveAllSim(): number {
    return this.harness.archiveAllSim()
  }

  createSimThread(kind: 'group' | 'private', id?: number): ThreadMeta {
    return this.harness.createSimThread(kind, id)
  }

  parseThread(id: string): ThreadRef | null {
    return this.harness.parseThread(id)
  }
}

export function createKernel(): AgentKernel {
  return new AgentKernel()
}
