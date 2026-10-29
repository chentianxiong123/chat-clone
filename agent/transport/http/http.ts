import type { IncomingMessage, ServerResponse } from 'node:http'

export interface Ctx {
  req: IncomingMessage
  res: ServerResponse
  url: URL
  path: string
}

export function json(res: ServerResponse, code: number, obj: unknown): void {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(obj))
}

export function readBody(req: IncomingMessage, lim = 2 * 1024 * 1024): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > lim) { reject(new Error('body too large')); return }
      chunks.push(c)
    })
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8')
        resolve(raw ? JSON.parse(raw) : {})
      } catch {
        reject(new Error('bad json'))
      }
    })
  })
}
