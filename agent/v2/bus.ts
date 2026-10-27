import type { V2Event } from './types.js'

export type EventListener = (ev: V2Event) => void

export class EventBus {
  private listeners = new Set<EventListener>()

  subscribe(fn: EventListener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  emit(ev: V2Event): void {
    for (const fn of this.listeners) {
      try { fn(ev) } catch (e) { console.warn('[Bus] listener error:', (e as Error).message) }
    }
  }
}
