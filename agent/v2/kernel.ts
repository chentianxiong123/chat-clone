import { EventBus } from './bus.js'
import { AgentRuntime } from './runtime.js'
import { Harness } from './harness.js'
import { SimAdapter } from './channels/sim.js'
import type { QQAdapter } from './channels/qq.js'
import type { EventListener } from './bus.js'
import type { InboundMessage, RunRecord, ThreadMeta, ThreadRef, V2Event } from './types.js'

export class AgentKernel {
  readonly bus = new EventBus()
  readonly sim = new SimAdapter()
  readonly runtime: AgentRuntime
  readonly harness: Harness
  private qq: QQAdapter | null = null

  constructor() {
    this.runtime = new AgentRuntime(this.bus, (thread, text) => this.send(thread, text))
    this.harness = new Harness(this.bus, this.runtime)
  }

  attachQQ(adapter: QQAdapter): void {
    this.qq = adapter
  }

  private send(thread: ThreadRef, text: string): Promise<void> {
    if (thread.channel === 'qq') {
      if (!this.qq) return Promise.reject(new Error('QQ adapter 未接入'))
      return this.qq.send(thread, text)
    }
    return this.sim.send(thread, text)
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
