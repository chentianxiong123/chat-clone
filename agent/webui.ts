import { createServer } from 'node:http'
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join, extname, normalize } from 'node:path'
import { AgentCore } from './core.js'
import { config, minedProfileMeta } from './config.js'
import { ragSearch, ragStatus } from './rag.js'
import { callLlmRaw, listModels } from './llm.js'
import { getUsageSummary } from './stats.js'
import { listSceneSummaries } from './memory.js'
import { fileURLToPath } from 'node:url'

const WEB_DIR = join(fileURLToPath(new URL('.', import.meta.url)), 'web')
const ENV_PATH = join(fileURLToPath(new URL('.', import.meta.url)), '.env')

// ── 配置预设模板（只改行为/节律相关键，保留密钥与基础设施配置）──
const PRESET_DEFAULTS: Record<string, string> = {
  RESPOND_MODE: 'auto',
  PROACTIVE_GAP_MS: '0',
  QUIET_HOURS: '',
  BATCH_N: '5',
  BATCH_T: '60000',
  HL_IGNORE_SHORT_MIN_CHARS: '0',
  HL_IGNORE_SHORT_PROB: '0',
  HL_STATE_MODEL: 'true',
  HL_STATE_INJECT: 'true',
}

const ENV_PRESETS: Array<{ name: string; label: string; description: string; patch: Record<string, string> }> = [
  {
    name: 'default',
    label: '默认（推荐）',
    description: '自动接话、不主动冒泡、近期状态开启',
    patch: PRESET_DEFAULTS,
  },
  {
    name: 'quiet',
    label: '安静（只回 @）',
    description: '仅 @/唤醒词触发，忽略敷衍短句',
    patch: {
      RESPOND_MODE: 'mention',
      PROACTIVE_GAP_MS: '0',
      HL_IGNORE_SHORT_MIN_CHARS: '2',
      HL_IGNORE_SHORT_PROB: '0.5',
    },
  },
  {
    name: 'active',
    label: '活跃（多接话）',
    description: '自动接话，3 条/30 秒攒批，偶尔主动冒泡',
    patch: {
      RESPOND_MODE: 'auto',
      PROACTIVE_GAP_MS: '1800000',
      BATCH_N: '3',
      BATCH_T: '30000',
      HL_IGNORE_SHORT_MIN_CHARS: '0',
      HL_IGNORE_SHORT_PROB: '0',
    },
  },
  {
    name: 'night',
    label: '夜间静默',
    description: '00:30–08:00 完全静默，不主动',
    patch: {
      QUIET_HOURS: '00:30-08:00',
      PROACTIVE_GAP_MS: '0',
    },
  },
  {
    name: 'state-off',
    label: '经典（关闭近期状态）',
    description: '关闭精力/心情等状态模型与提示词注入',
    patch: {
      HL_STATE_MODEL: 'false',
      HL_STATE_INJECT: 'false',
    },
  },
]

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
          humanlike: config.humanlike,
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

      // ── 预设模板列表 ──
      if (path === '/api/config/presets') {
        return json(res, 200, {
          presets: ENV_PRESETS.map(({ name, label, description }) => ({ name, label, description })),
        })
      }

      // ── 应用预设模板（写入 .env，重启后生效）──
      if (path === '/api/config/preset' && req.method === 'POST') {
        const body = await readBody(req)
        const name = String(body.name || '')
        const preset = ENV_PRESETS.find(p => p.name === name)
        if (!preset) return json(res, 400, { error: 'unknown preset' })
        const raw = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf8') : ''
        const next = applyEnvPatch(raw, preset.patch)
        const backup = writeEnvWithBackup(next)
        return json(res, 200, {
          ok: true,
          env: next,
          note: `已应用「${preset.label}」，重启 agent 后生效${backup ? `（已备份 ${backup.split('/').pop()}）` : ''}`,
        })
      }

      // ── 恢复默认配置（仅触发/节律/近期状态相关项，保留密钥与基础设施配置）──
      if (path === '/api/config/reset' && req.method === 'POST') {
        const raw = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf8') : ''
        const next = applyEnvPatch(raw, PRESET_DEFAULTS)
        const backup = writeEnvWithBackup(next)
        return json(res, 200, {
          ok: true,
          env: next,
          note: `已恢复默认配置，重启 agent 后生效${backup ? `（已备份 ${backup.split('/').pop()}）` : ''}`,
        })
      }

      // ── 读取完整配置快照 ──
      if (path === '/api/config') {
        const raw = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf8') : ''
        const rag = await ragStatus()
        return json(res, 200, {
          env: raw,
          active: config,
          rag,
          profileMeta: minedProfileMeta,
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

/** 把 patch 合并进 .env：更新所有同名活跃行（保留行内注释），缺失的追加到末尾 */
function applyEnvPatch(raw: string, patch: Record<string, string>): string {
  const lines = raw ? raw.split(/\r?\n/) : []
  const seen = new Set<string>()
  const out = lines.map(line => {
    const m = line.match(/^(\s*)([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/)
    if (!m) return line
    const key = m[2]
    if (!Object.prototype.hasOwnProperty.call(patch, key)) return line
    seen.add(key)
    const rest = m[3]
    const hash = rest.indexOf(' #')
    const comment = hash >= 0 ? rest.slice(hash) : ''
    return `${m[1]}${key}=${patch[key]}${comment}`
  })
  for (const [key, value] of Object.entries(patch)) {
    if (seen.has(key)) continue
    if (out.length && out[out.length - 1] === '') out[out.length - 1] = `${key}=${value}`
    else out.push(`${key}=${value}`)
  }
  return out.join('\n')
}

/** 写 .env 前先备份（备份文件含密钥，权限 600） */
function writeEnvWithBackup(next: string): string {
  let backup = ''
  if (existsSync(ENV_PATH)) {
    backup = `${ENV_PATH}.bak.${Date.now()}`
    writeFileSync(backup, readFileSync(ENV_PATH, 'utf8'), { encoding: 'utf8', mode: 0o600 })
  }
  writeFileSyncSafe(ENV_PATH, next)
  return backup
}