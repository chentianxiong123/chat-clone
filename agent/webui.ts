import { createServer } from 'node:http'
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join, extname, normalize } from 'node:path'
import { AgentCore } from './core.js'
import type { AgentKernel } from './v2/kernel.js'
import { config, minedProfileMeta } from './config.js'
import { ragImportInfo, ragSearch, ragStatus, searchRag } from './rag.js'
import { buildSystemPrompt } from './prompt.js'
import { callLlmRaw } from './llm.js'
import { getUsageSummary } from './stats.js'
import { getActiveProvider, listProviders, listEmbedProviders } from './domain/models/index.js'
import { listSceneSummaries } from './memory.js'
import { paths } from './paths.js'
import { json, readBody } from './transport/http/http.js'
import { Router } from './transport/http/router.js'
import { registerModelsRoutes } from './transport/http/routes/models.js'

const WEB_DIR = paths.web
const ENV_PATH = paths.env

// ── 配置预设模板（只改行为/节律相关键，保留密钥与基础设施配置）──
const PRESET_DEFAULTS: Record<string, string> = {
  RESPOND_MODE: 'auto',
  PROACTIVE_GAP_MS: '0',
  QUIET_HOURS: '',
  BATCH_N_MIN: '3',
  BATCH_N_MAX: '6',
  BATCH_T: '60000',
  HL_IGNORE_SHORT_MIN_CHARS: '0',
  HL_IGNORE_SHORT_PROB: '0',
  HL_STATE_MODEL: 'false',
  HL_STATE_INJECT: 'false',
}

const ENV_PRESETS: Array<{ name: string; label: string; description: string; patch: Record<string, string> }> = [
  {
    name: 'default',
    label: '默认（推荐）',
    description: '自动接话、不主动冒泡（近期状态系统已默认关闭）',
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
      BATCH_N_MIN: '3',
      BATCH_N_MAX: '4',
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

export function startWebUI(core: AgentCore, v2?: AgentKernel): ReturnType<typeof createServer> {
  const clients = new Set<{ write: (s: string) => void }>()
  const v2Clients = new Set<{ write: (s: string) => void }>()
  if (v2) {
    v2.subscribe(ev => {
      const payload = `data: ${JSON.stringify(ev)}\n\n`
      for (const c of v2Clients) c.write(payload)
    })
  }

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

  const router = new Router()
  registerModelsRoutes(router)

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
    const path = decodeURIComponent(url.pathname)

    try {
      // ── 模型管理（独立路由表）──
      if (await router.dispatch({ req, res, url, path })) return

      // ── v2 控制台：事件流 ──
      if (path === '/api/v2/stream') {
        if (!v2) return json(res, 503, { error: 'v2 kernel not enabled' })
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        })
        res.write(`data: ${JSON.stringify({ type: 'hello', snapshot: v2.getSnapshot() })}\n\n`)
        const client = { write: (s: string) => res.write(s) }
        v2Clients.add(client)
        req.on('close', () => { v2Clients.delete(client) })
        return
      }

      // ── v2 控制台：线程列表 ──
      if (path === '/api/v2/threads') {
        if (!v2) return json(res, 503, { error: 'v2 kernel not enabled' })
        const { threads, counts } = v2.getThreadsWithCounts()
        const withCounts = threads.map(t => ({ ...t, messageCount: counts[t.id] || 0 }))
        const active = threads.filter(t => !t.archived)
        const totalMessages = withCounts.reduce((a, t) => a + t.messageCount, 0)
        return json(res, 200, {
          threads: withCounts,
          snapshot: v2.getSnapshot(),
          totals: { threads: active.length, messages: totalMessages, archived: threads.length - active.length },
        })
      }

      // ── v2 控制台：新建/确保模拟会话（真群号一律拒绝）──
      if (path === '/api/v2/threads/sim/archive-all' && req.method === 'POST') {
        const n = v2.archiveAllSim()
        return json(res, 200, { ok: true, archived: n })
      }

      if (path === '/api/v2/threads/sim' && req.method === 'POST') {
        if (!v2) return json(res, 503, { error: 'v2 kernel not enabled' })
        const body = await readBody(req)
        const kind = body.kind === 'private' ? 'private' : 'group'
        const rawId = body.id ?? body.groupId ?? body.senderId
        const id = rawId === undefined || rawId === '' ? undefined : Number(rawId)
        if (id !== undefined && !Number.isFinite(id)) return json(res, 400, { error: 'invalid id' })
        try {
          const meta = v2.createSimThread(kind, id)
          return json(res, 200, { ok: true, thread: meta })
        } catch (e) {
          return json(res, 400, { error: (e as Error).message })
        }
      }

      // ── v2 控制台：线程详情 ──
      if (path.startsWith('/api/v2/thread/') && !path.endsWith('/message') && !path.endsWith('/pause') && !path.endsWith('/archive') && !path.endsWith('/trigger')) {
        if (!v2) return json(res, 503, { error: 'v2 kernel not enabled' })
        const id = path.slice('/api/v2/thread/'.length)
        if (!v2.parseThread(id)) return json(res, 400, { error: 'bad thread id' })
        const detail = v2.getThread(id)
        if (!detail.meta) return json(res, 404, { error: 'thread not found' })
        v2.markRead(id)
        return json(res, 200, { ...detail, snapshot: v2.getSnapshot() })
      }

      // ── v2 控制台：发消息（只允许 sim 通道；真群/真私聊拒绝）──
      if (path.startsWith('/api/v2/thread/') && path.endsWith('/message') && req.method === 'POST') {
        if (!v2) return json(res, 503, { error: 'v2 kernel not enabled' })
        const id = path.slice('/api/v2/thread/'.length, -'/message'.length)
        const ref = v2.parseThread(id)
        if (!ref) return json(res, 400, { error: 'bad thread id' })
        if (ref.channel !== 'sim') return json(res, 403, { error: '控制台只允许模拟通道，真群/真私聊请走 QQ adapter' })
        if (ref.kind === 'group' && (ref.externalId < config.sim.groupMin || ref.externalId > config.sim.groupMax)) {
          return json(res, 403, { error: `模拟群号必须在 ${config.sim.groupMin}~${config.sim.groupMax}` })
        }
        const body = await readBody(req)
        const text = String(body.text ?? '').trim()
        if (!text) return json(res, 400, { error: 'empty text' })
        const senderNick = String(body.senderNick ?? (ref.kind === 'group' ? '测试员' : '朋友'))
        const senderId = Number(body.senderId) || (ref.kind === 'group' ? 10001 : ref.externalId)
        const run = await v2.handleMessage({
          thread: ref,
          senderId,
          senderNick,
          text,
          atBot: !!body.atBot,
          simulated: true,
          policy: !!body.policy,
          at: Date.now(),
        })
        v2.markRead(id)
        return json(res, 200, { ok: true, run })
      }

      // ── v2 控制台：手动触发一轮（注入一条调试消息）──
      if (path.startsWith('/api/v2/thread/') && path.endsWith('/trigger') && req.method === 'POST') {
        if (!v2) return json(res, 503, { error: 'v2 kernel not enabled' })
        const id = path.slice('/api/v2/thread/'.length, -'/trigger'.length)
        const ref = v2.parseThread(id)
        if (!ref) return json(res, 400, { error: 'bad thread id' })
        if (ref.channel !== 'sim') return json(res, 403, { error: '控制台只允许模拟通道' })
        if (v2.flushThread(id)) return json(res, 200, { ok: true, flushed: true })
        const run = await v2.handleMessage({
          thread: ref, senderId: 0, senderNick: '系统',
          text: '（手动触发，接着刚才的话题说一句）', simulated: true, at: Date.now(),
        })
        return json(res, 200, { ok: true, flushed: false, run })
      }

      // ── v2 控制台：暂停/恢复 ──
      if (path.startsWith('/api/v2/thread/') && path.endsWith('/pause') && req.method === 'POST') {
        if (!v2) return json(res, 503, { error: 'v2 kernel not enabled' })
        const id = path.slice('/api/v2/thread/'.length, -'/pause'.length)
        if (!v2.parseThread(id)) return json(res, 400, { error: 'bad thread id' })
        const body = await readBody(req)
        const meta = v2.setPaused(id, !!body.paused)
        if (!meta) return json(res, 404, { error: 'thread not found' })
        return json(res, 200, { ok: true, thread: meta })
      }

      // ── v2 控制台：归档/恢复会话（保留全部消息、run、token 与工具记录）──
      if (path.startsWith('/api/v2/thread/') && path.endsWith('/archive') && req.method === 'POST') {
        if (!v2) return json(res, 503, { error: 'v2 kernel not enabled' })
        const id = path.slice('/api/v2/thread/'.length, -'/archive'.length)
        if (!v2.parseThread(id)) return json(res, 400, { error: 'bad thread id' })
        const body = await readBody(req)
        const meta = v2.archiveThread(id, !!body.archived)
        if (!meta) return json(res, 404, { error: 'thread not found' })
        return json(res, 200, { ok: true, thread: meta })
      }

      // ── v2 控制台：事件回放 ──
      if (path === '/api/v2/events') {
        if (!v2) return json(res, 503, { error: 'v2 kernel not enabled' })
        const thread = url.searchParams.get('thread') || undefined
        const limit = Number(url.searchParams.get('limit')) || 200
        return json(res, 200, { events: v2.getEvents(thread, limit) })
      }

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

      // ── RAG 信息（状态 + 配置 + 导入情况）──
      if (path === '/api/rag/info') {
        const [status, importInfo] = await Promise.all([ragStatus(), ragImportInfo()])
        return json(res, 200, { status, import: importInfo, config: buildRagConfig() })
      }

      // ── 保存 RAG 编排：即时生效 + 写回 .env ──
      if (path === '/api/rag/config' && req.method === 'POST') {
        const body = await readBody(req)
        const patch: Record<string, string> = {}
        const applied: string[] = []

        if (Array.isArray(body.strategy)) {
          const v = (body.strategy as string[])
            .map(s => String(s).trim()).filter(s => s === 'vec' || s === 'fts' || s === 'like')
          const seen = new Set(v); const uniq = [...seen]
          if (uniq.length) { config.rag.strategy = uniq; applied.push('strategy'); patch.RAG_STRATEGY = uniq.join(',') }
        }
        if (body.topK != null) {
          const v = Math.max(1, Math.min(50, Math.round(Number(body.topK))))
          config.rag.topK = v; applied.push('topK'); patch.RAG_TOP_K = String(v)
        }
        if (body.vecProb != null) {
          const v = Math.max(0, Math.min(1, Number(body.vecProb)))
          config.rag.vecProb = v; applied.push('vecProb'); patch.RAG_VEC_PROB = String(v)
        }
        if (typeof body.vecFallbackOnEmpty === 'boolean') {
          config.rag.vecFallbackOnEmpty = body.vecFallbackOnEmpty
          applied.push('vecFallbackOnEmpty'); patch.RAG_VEC_FALLBACK = String(body.vecFallbackOnEmpty)
        }
        if (body.vecMinScore != null) {
          const v = Math.max(0, Math.min(1, Number(body.vecMinScore)))
          config.rag.vecMinScore = v; applied.push('vecMinScore'); patch.RAG_VEC_MIN_SCORE = String(v)
        }
        if (typeof body.recallMode === 'string' && ['all', 'random', 'agent', 'auto'].includes(body.recallMode)) {
          config.rag.recallMode = body.recallMode as 'all' | 'random' | 'agent' | 'auto'
          applied.push('recallMode'); patch.RAG_RECALL_MODE = body.recallMode
        }
        if (typeof body.embedEnabled === 'boolean') {
          config.rag.embedEnabled = body.embedEnabled
          applied.push('embedEnabled'); patch.RAG_EMBED_ENABLED = String(body.embedEnabled)
        }
        if (typeof body.toolsEnabled === 'boolean') {
          config.rag.toolsEnabled = body.toolsEnabled
          applied.push('toolsEnabled'); patch.RAG_TOOLS_ENABLED = String(body.toolsEnabled)
        }
        if (body.recallProb != null) {
          const v = Math.max(0, Math.min(1, Number(body.recallProb)))
          config.rag.recallProb = v; applied.push('recallProb'); patch.RAG_RECALL_PROB = String(v)
        }
        if (body.toolMaxIter != null) {
          const v = Math.max(1, Math.round(Number(body.toolMaxIter)))
          config.rag.toolMaxIter = v; applied.push('toolMaxIter'); patch.RAG_TOOL_MAX_ITER = String(v)
        }
        if (body.toolMaxItems != null) {
          const v = Math.max(1, Math.round(Number(body.toolMaxItems)))
          config.rag.toolMaxItems = v; applied.push('toolMaxItems'); patch.RAG_TOOL_MAX_ITEMS = String(v)
        }
        if (body.factMaxChars != null) {
          const v = Math.max(10, Math.round(Number(body.factMaxChars)))
          config.rag.factMaxChars = v; applied.push('factMaxChars'); patch.MEMORY_FACT_MAX_CHARS = String(v)
        }
        if (typeof body.embedProvider === 'string') {
          // 空字符串 = 自动（第一个配 embedModel 的 provider）
          const v = body.embedProvider.trim()
          const exists = !v || listEmbedProviders().some(p => p.id === v)
          if (exists) {
            config.rag.embedProvider = v
            applied.push('embedProvider')
            patch.RAG_EMBED_PROVIDER = v
          } else {
            return json(res, 200, { ok: false, error: `未知 embed provider: ${v}`, applied, config: buildRagConfig(), rag: await ragStatus() })
          }
        }

        if (Object.keys(patch).length) {
          const raw = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf8') : ''
          writeEnvWithBackup(applyEnvPatch(raw, patch))
        }
        return json(res, 200, {
          ok: true,
          note: applied.length ? `已即时生效：${applied.join('、')}（已写回 .env）` : '无变更',
          applied,
          config: buildRagConfig(),
          rag: await ragStatus(),
        })
      }

      // ── RAG / LLM 能力状态 ──
      if (path === '/api/status') {
        const rag = await ragStatus()
        const activeP = getActiveProvider()
        return json(res, 200, {
          rag,
          llm: {
            model: activeP?.model ?? '',
            baseUrl: activeP?.baseUrl ?? '',
            provider: activeP?.name ?? 'default',
            configured: !!activeP?.apiKey,
          },
          models: {
            providers: listProviders().map(p => ({ id: p.id, name: p.name, model: p.model, active: activeP?.id === p.id })),
            activeId: activeP?.id ?? null,
          },
          batch: { n: `${config.batch.nMin}~${config.batch.nMax}`, t: config.batch.t },
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
        const ragCtx = withRag ? await searchRag(prompt) : ''
        const messages = [
          { role: 'system' as const, content: buildSystemPrompt('group') },
          { role: 'user' as const, content: ragCtx ? `${ragCtx}\n\n${prompt}` : prompt },
        ]
        const result = await callLlmRaw(messages)
        return json(res, 200, result)
      }

      // ── 模拟注入 ──
      if (path === '/api/simulate' && req.method === 'POST') {
        const body = await readBody(req)
        const scene: 'group' | 'private' = body.scene === 'private' ? 'private' : 'group'
        const id = Number(body.groupId || body.senderId) || (scene === 'group' ? config.sim.defaultGroup : 10001)
        const who = body.senderNick || '测试员'
        const text = body.text || ''
        if (!text) return json(res, 400, { error: 'empty text' })
        if (scene === 'group' && (id < config.sim.groupMin || id > config.sim.groupMax)) {
          return json(res, 403, { error: `模拟群号必须在 ${config.sim.groupMin}~${config.sim.groupMax}，真群请走 QQ 通道` })
        }
        core.handleMessage({
          scene,
          groupId: id,
          senderId: id,
          senderNick: who,
          text,
          atBot: !!body.atBot,
          simulated: true,
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

      // ── 删除会话记忆已禁用：历史、run 与 token 记录一律保留 ──
      if (path === '/api/clear' && req.method === 'POST') {
        return json(res, 403, { error: '删除已禁用。请在聊天页归档会话，记录会完整保留。' })
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

      // ── 对话机制配置（攒批/回复/冷却/RAG/记忆压缩，逐项 patch 写回 .env）──
      if (path === '/api/mechanism/config' && req.method === 'POST') {
        const body = await readBody(req)
        const keys = ['BATCH_N_MIN','BATCH_N_MAX','BATCH_T','PRIVATE_BATCH_N','PRIVATE_BATCH_T',
          'GROUP_REPLY_PROB','PRIVATE_REPLY_PROB','REPLY_COOLDOWN','PRIVATE_REPLY_COOLDOWN',
          'RAG_VEC_PROB','RAG_TOP_K','RAG_VEC_MIN_SCORE','RAG_RECALL_PROB','RAG_TOOL_MAX_ITER','RAG_TOOL_MAX_ITEMS',
          'MEMORY_MAX_TOKENS','MEMORY_COMPRESS_THRESHOLD','MEMORY_KEEP_RECENT_RATIO','RAG_RECALL_MODE']
        const patch: Record<string, string> = {}
        for (const k of keys) {
          if (body[k] == null || body[k] === '') continue
          const raw = String(body[k]).trim()
          if (/^\d+(\.\d+)?$/.test(raw)) patch[k] = String(Math.max(0, Number(raw)))
          else if (['auto','all','random','agent'].includes(raw)) patch[k] = raw
        }
        if (!Object.keys(patch).length) return json(res, 400, { ok: false, error: '无有效字段' })
        const raw = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf8') : ''
        writeEnvWithBackup(applyEnvPatch(raw, patch))
        return json(res, 200, { ok: true, note: `已写回 .env：${Object.keys(patch).join('、')}（重启 agent 生效）` })
      }

      // ── 写回 .env（需重启生效）──
      if (path === '/api/config' && req.method === 'POST') {
        const body = await readBody(req)
        if (typeof body.env !== 'string') return json(res, 400, { error: 'env must be string' })
        writeFileSyncSafe(ENV_PATH, body.env)
        return json(res, 200, { ok: true, note: '配置已保存，重启 agent 后生效' })
      }

      // ── 服务配置（NapCat / WebUI / 真群）──
      if (path === '/api/service/config' && req.method === 'GET') {
        return json(res, 200, {
          ok: true,
          napcat: { host: config.napcat.host, port: config.napcat.port },
          webui: { host: config.webui.host, port: config.webui.port },
          sim: { realGroups: config.sim.realGroups, maxThreads: config.sim.maxThreads },
        })
      }
      if (path === '/api/service/config' && req.method === 'POST') {
        const body = await readBody(req)
        const patch: Record<string, string> = {}
        if (typeof body.napcatHost === 'string' && body.napcatHost.trim()) patch.NAPCAT_HOST = body.napcatHost.trim()
        if (body.napcatPort != null) patch.NAPCAT_PORT = String(Math.max(1, Math.round(Number(body.napcatPort) || 1)))
        if (typeof body.webuiHost === 'string' && body.webuiHost.trim()) patch.WEBUI_HOST = body.webuiHost.trim()
        if (body.webuiPort != null) patch.WEBUI_PORT = String(Math.max(1, Math.round(Number(body.webuiPort) || 1)))
        if (typeof body.realGroups === 'string') patch.SIM_REAL_GROUPS = body.realGroups.split(',').map(s => s.trim()).filter(Boolean).join(',')
        if (body.simMax != null) patch.SIM_MAX_THREADS = String(Math.max(1, Math.round(Number(body.simMax) || 1)))
        if (!Object.keys(patch).length) return json(res, 400, { ok: false, error: '无有效字段' })
        const raw = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf8') : ''
        writeEnvWithBackup(applyEnvPatch(raw, patch))
        return json(res, 200, { ok: true, note: `已写回 .env：${Object.keys(patch).join('、')}（重启 agent 生效）` })
      }

      // ── 人格配置（PERSONA_*，多行字段 JSON 单行编码）──
      if (path === '/api/persona/config' && req.method === 'POST') {
        const body = await readBody(req)
        const patch: Record<string, string> = {}
        if (typeof body.name === 'string') patch.PERSONA_NAME = body.name
        if (typeof body.friendName === 'string') patch.PERSONA_FRIEND = body.friendName
        if (typeof body.wakeWords === 'string') patch.PERSONA_WAKE_WORDS = body.wakeWords
        if (typeof body.systemPrompt === 'string') patch.PERSONA_SYSTEM_PROMPT = JSON.stringify(body.systemPrompt)
        if (typeof body.privateSystemPrompt === 'string') patch.PERSONA_PRIVATE_SYSTEM_PROMPT = JSON.stringify(body.privateSystemPrompt)
        if (typeof body.demoDialogs === 'string') patch.PERSONA_DEMO_DIALOGS = JSON.stringify(body.demoDialogs)
        if (!Object.keys(patch).length) return json(res, 400, { ok: false, error: '无有效字段' })
        const raw = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf8') : ''
        writeEnvWithBackup(applyEnvPatch(raw, patch))
        return json(res, 200, { ok: true, note: `已写回 .env：${Object.keys(patch).join('、')}（重启 agent 生效）` })
      }

      // ── /console 兼容入口：统一进主控制台聊天页 ──
      if (path === '/console') {
        res.writeHead(302, { Location: '/#chat' })
        res.end()
        return
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
        const noCache = ['.html', '.js', '.css'].includes(ext)
        res.writeHead(200, {
          'Content-Type': types[ext] || 'application/octet-stream',
          ...(noCache ? { 'Cache-Control': 'no-cache' } : {}),
        })
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

function writeFileSyncSafe(path: string, content: string): void {
  writeFileSync(path, content, 'utf8')
}

/** 当前 RAG 编排配置快照（供前端表单回填） */
function buildRagConfig() {
  return {
    dbPath: config.rag.dbPath,
    vec0: config.rag.vec0,
    embedEndpoint: config.rag.embedEndpoint,
    embedModel: config.rag.embedModel,
    embedProxy: config.rag.embedProxy,
    embedProvider: config.rag.embedProvider,
    embedProviders: listEmbedProviders(),
    embedEnabled: config.rag.embedEnabled,
    ftsEnabled: config.rag.ftsEnabled,
    likeEnabled: config.rag.likeEnabled,
    topK: config.rag.topK,
    strategy: config.rag.strategy,
    vecProb: config.rag.vecProb,
    vecFallbackOnEmpty: config.rag.vecFallbackOnEmpty,
    vecMinScore: config.rag.vecMinScore,
    recallMode: config.rag.recallMode,
    toolsEnabled: config.rag.toolsEnabled,
    recallProb: config.rag.recallProb,
    toolMaxIter: config.rag.toolMaxIter,
    toolMaxItems: config.rag.toolMaxItems,
    factMaxChars: config.rag.factMaxChars,
  }
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