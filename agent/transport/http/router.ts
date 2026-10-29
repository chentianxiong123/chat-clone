import type { Ctx } from './http.js'

export type Handler = (ctx: Ctx) => void | Promise<void>

interface Entry {
  method: string
  match: (path: string) => boolean
  handler: Handler
}

export class Router {
  private entries: Entry[] = []

  get(path: string, handler: Handler): this {
    return this.add('GET', path, handler)
  }

  post(path: string, handler: Handler): this {
    return this.add('POST', path, handler)
  }

  add(method: string, path: string, handler: Handler): this {
    this.entries.push({ method, match: p => p === path, handler })
    return this
  }

  /** 命中并处理返回 true；未命中返回 false（交给后续路由/兜底） */
  async dispatch(ctx: Ctx): Promise<boolean> {
    for (const e of this.entries) {
      if (e.method !== ctx.req.method) continue
      if (!e.match(ctx.path)) continue
      await e.handler(ctx)
      return true
    }
    return false
  }
}
