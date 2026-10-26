import { createServer } from 'node:http'
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join, extname, normalize } from 'node:path'
import { AgentCore } from './core.js'
import { config } from './config.js'
import { ragSearch, ragStatus } from './rag.js'
import { callLlmRaw, listModels } from './llm.js'
import { getUsageSummary } from './stats.js'
import { listSceneSummaries } from './memory.js'
import { fileURLToPath } from 'node:url'

const WEB_DIR = join(fileURLToPath(new URL('.', import.meta.url)), 'web')
const ENV_PATH = join(fileURLToPath(new URL('.', import.meta.url)), '.env')

export function startWebUI(core: AgentCore): ReturnType<typeof createServer> {
  const clients = new Set<{ write: (s: string) => void }>()

  // 核心状态变化 → SSE 广播
  const unsubscribe = core.subscribe(snap => {
    const payload = `data: ${JSON.stringify({ type: 'state', snap })}\n\n`
    for (const c of clients) c.write(payload)
  })

  let logPos = 0
  void logPos
  const logLines: Array<{ t: string; l: string; level: string }> = []
  const origLog = console.log
  const origErr = console.error
  const origWarn = console.warn
  const pushLog = (level: 'info' | 'warn' | 'error', args: unknown[]): void => {
    const line = args.map(String).join(' ').replace(/\u001b\[\d*m/g, '')
    const entry = { t: new Date().toISOString(), l: line, level }
    logLines.push(entry)
    if (logLines.length > 2000) logLines.shift()
    const payload = `data: ${JSON.stringify({ type: 'log', entry })}\n\n`
    for (const c of clients) c.write(payload)
  }
  console.log = (...a) => { origLog(...a); pushLog('info', a) }
  console.warn = (...a) => { origWarn(...a); pushLog('warn', a) }
  console.error = (...a) => { origErr(...a); pushLog('error', a) }

  // 直接发一帧初始 log 让前端拿到已有 buffer（此时为空，之后靠 SSE 增量）

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
    const path = decodeURIComponent(url.pathname)

    try {
      // ── SSE 状态流 ──
      if (path === '/api/stream') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        })
        res.write(`data: ${JSON.stringify({ type: 'state', snap: core.getSnapshot() })}\n\n`)
        const client = { write: (s: string) => res.write(s) }
        clients.add(client)
        req.on('close', () => {
          clients.delete(client)
        })
        return
      }

      // ── 日志回放 ──
      if (path === '/api/logs') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(logLines))
        return
      }

      // ── RAG 检索 ──
      if (path === '/api/rag') {
        const q = url.searchParams.get('q') || ''
        if (!q) return json(res, 400, { error: 'missing q' })
        const result = await ragSearch(q)
        return json(res, 200, { q, ...result })
      }

      // ── RAG / LLM 能力状态 ──
      if (path === '/api/status') {
        const rag = await ragStatus()
        return json(res, 200, {
          rag,
          llm: { model: config.llm.model, baseUrl: config.llm.baseUrl, configured: !!config.llm.apiKey },
          batch: { n: config.batch.n, t: config.batch.t },
          persona: config.persona,
          agent: config.agent,
          ragConfig: {
            dbPath: config.rag.dbPath,
            embedEndpoint: config.rag.embedEndpoint,
            embedModel: config.rag.embedModel,
            embedConfigured: !!config.rag.embedEndpoint,
            vec0: config.rag.vec0,
            topK: config.rag.topK,
          },
        })
      }

      // ── 实时状态（快照）──
      if (path === '/api/state') {
        return json(res, 200, core.getSnapshot())
      }

      // ── 用量统计 ──
      if (path === '/api/stats') {
        const hours = Number(url.searchParams.get('hours')) || 24
        return json(res, 200, getUsageSummary(hours))
      }

      // ── 记忆摘要 ──
      if (path === '/api/memory') {
        return json(res, 200, {
          enabled: config.agent.memoryPersist,
          maxTokens: config.agent.memoryMaxTokens,
          threshold: config.agent.memoryCompressThreshold,
          keepRecentRatio: config.agent.memoryKeepRecentRatio,
          scenes: listSceneSummaries(),
        })
      }

      // ── 手测 LLM ──
      if (path === '/api/llm' && req.method === 'POST') {
        const body = await readBody(req)
        const prompt = body.prompt || ''
        const withRag = body.withRag !== false
        let ragCtx = ''
        if (withRag) {
          const r = await ragSearch(prompt)
          const picked = r.vec.length ? r.vec : r.fts.length ? r.fts : r.like
          ragCtx = picked.map(x => x.text.trim()).join('\n---\n')
        }
        const system = `你是${config.persona.name} 你在群里跟朋友瞎聊\n\n接话规则：\n- 别人问"在吗/有人吗/吃了没"这类 → 不回答 直接说自己正在做的事\n- 别人征求意见 → 一本正经分析 像专家发表见解\n- 别人催你 → 岔开说自己忙的事\n- 别人怼你 → 不屑式短回 不解释\n\n回复最多3句 不加标点\n${ragCtx ? '以下聊天记录是本人说过的真实原话，你说话就这味道：\n' + ragCtx : ''}`
        const result = await callLlmRaw([{ role: 'system', content: system }, { role: 'user', content: prompt }])
        return json(res, 200, result)
      }

      // ── 模型列表 ──
      if (path === '/api/models') {
        return json(res, 200, { models: await listModels() })
      }

      // ── 模拟注入 ──
      if (path === '/api/simulate' && req.method === 'POST') {
        const body = await readBody(req)
        const scene: 'group' | 'private' = body.scene === 'private' ? 'private' : 'group'
        const id = Number(body.groupId || body.senderId) || 10000
        const who = body.senderNick || '测试员'
        const text = body.text || ''
        if (!text) return json(res, 400, { error: 'empty text' })
        core.handleMessage({
          scene,
          groupId: id,
          senderId: id,
          senderNick: who,
          text,
          atBot: !!body.atBot,
        })
        return json(res, 200, { ok: true, scene, id })
      }

      // ── 立即触发攒批 ──
      if (path === '/api/flush' && req.method === 'POST') {
        const body = await readBody(req)
        const key = body.key || `g:${body.groupId}`
        core.flush(key)
        return json(res, 200, { ok: true })
      }

      // ── 清空会话记忆 ──
      if (path === '/api/clear' && req.method === 'POST') {
        const body = await readBody(req)
        const key = body.key ?? undefined
        core.clearDialog(key)
        return json(res, 200, { ok: true })
      }

      // ── 读取完整配置快照 ──
      if (path === '/api/config') {
        const raw = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf8') : ''
        const rag = await ragStatus()
        return json(res, 200, {
          env: raw,
          active: config,
          rag,
        })
      }

      // ── 写回 .env（需重启生效）──
      if (path === '/api/config' && req.method === 'POST') {
        const body = await readBody(req)
        if (typeof body.env !== 'string') return json(res, 400, { error: 'env must be string' })
        writeFileSyncSafe(ENV_PATH, body.env)
        return json(res, 200, { ok: true, note: '配置已保存，重启 agent 后生效' })
      }

      // ── 静态文件 ──
      const filePath = serveStatic(path)
      if (filePath) {
        const ext = extname(filePath)
        const types: Record<string, string> = {
          '.html': 'text/html; charset=utf-8',
          '.js': 'text/javascript; charset=utf-8',
          '.css': 'text/css; charset=utf-8',
          '.json': 'application/json; charset=utf-8',
          '.svg': 'image/svg+xml',
          '.png': 'image/png',
          '.woff2': 'font/woff2',
        }
        res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' })
        res.end(readFileSync(filePath))
        return
      }

      json(res, 404, { error: 'not found' })
    } catch (e) {
      console.error('[WebUI] 请求处理错误:', (e as Error).message)
      if (!res.headersSent) json(res, 500, { error: (e as Error).message })
    }
  })

  server.listen(config.webui.port, config.webui.host, () => {
    console.log(`[WebUI] http://${config.webui.host}:${config.webui.port}`)
  })

  return server
}

function serveStatic(path: string): string | null {
  // 安全：只允许 / 或 /web 前缀，路径规范化后必须在 WEB_DIR 内
  let rel = path === '/' ? 'index.html' : path.replace(/^\/+/, '')
  // /web/* 剥掉前缀（浏览器引用的静态资源路径），其余按 WEB_DIR 相对路径
  if (rel.startsWith('web/')) rel = rel.slice(4)
  if (rel.startsWith('api/')) return null
  const full = normalize(join(WEB_DIR, rel))
  if (!full.startsWith(WEB_DIR)) return null
  if (!existsSync(full) || statSync(full).isDirectory()) return null
  return full
}

function json(res: { writeHead: (code: number, h: Record<string, string>) => void; end: (s: string) => void }, code: number, obj: unknown): void {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(obj))
}

function readBody(req: { on: (e: 'data' | 'end', cb: (c?: unknown) => void) => void }, lim = 2 * 1024 * 1024): Promise<any> {
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
      } catch (e) {
        reject(new Error('bad json'))
      }
    })
  })
}

function writeFileSyncSafe(path: string, content: string): void {
  writeFileSync(path, content, 'utf8')
}