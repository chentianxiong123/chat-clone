import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from '../config.js'
import { loadDialog, listSceneSummaries } from '../memory.js'
import {
  parseThreadKey, threadKey, threadTitle,
  type InboundMessage, type RunRecord, type ThreadMeta, type ThreadRef, type ToolTrace, type V2Event,
} from './types.js'

const DATA_DIR = join(dirname(fileURLToPath(new URL('.', import.meta.url))), '..', 'data')
const DB_PATH = join(DATA_DIR, 'agent.db')

let _db: DatabaseSync | null = null
let seeded = false

function openDb(): DatabaseSync {
  if (_db) return _db
  mkdirSync(DATA_DIR, { recursive: true })
  const db = new DatabaseSync(DB_PATH)
  db.exec(`
    CREATE TABLE IF NOT EXISTS thread_meta (
      id TEXT PRIMARY KEY,
      channel TEXT NOT NULL,
      kind TEXT NOT NULL,
      external_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_message_at INTEGER NOT NULL,
      last_preview TEXT NOT NULL DEFAULT '',
      unread INTEGER NOT NULL DEFAULT 0,
      paused INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      type TEXT NOT NULL,
      thread_id TEXT,
      payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      trigger TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      model TEXT,
      tokens_in INTEGER,
      tokens_out INTEGER,
      cost REAL,
      error TEXT,
      reply TEXT,
      tool_calls INTEGER
    );
    CREATE TABLE IF NOT EXISTS tool_calls (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      name TEXT NOT NULL,
      args TEXT NOT NULL,
      result TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_thread ON events(thread_id, id);
    CREATE INDEX IF NOT EXISTS idx_runs_thread ON runs(thread_id, started_at);
    CREATE INDEX IF NOT EXISTS idx_tool_calls_run ON tool_calls(run_id, started_at);
  `)
  try { db.exec(`ALTER TABLE thread_meta ADD COLUMN archived INTEGER NOT NULL DEFAULT 0`) } catch { /* already exists */ }
  // 迁移：唯一真群(SIM_REAL_GROUPS)→qq 通道(真群)，其余全部→sim 通道(模拟群)
  // 仅在无子记录时改 id，保证 events/runs/tool_calls 引用不丢；幂等可重复执行
  try {
    const childCount = (id: string) => (db.prepare(
      `SELECT (SELECT count(*) FROM events WHERE thread_id = ?) + (SELECT count(*) FROM runs WHERE thread_id = ?) n`,
    ).get(id, id) as { n: number }).n
    const exists = (id: string) => !!db.prepare(`SELECT 1 FROM thread_meta WHERE id = ?`).get(id)
    const rows = db.prepare(`SELECT id, channel, kind, external_id FROM thread_meta`).all() as Array<{ id: string; channel: string; kind: string; external_id: number }>
    for (const r of rows) {
      const isReal = r.kind === 'group' && config.sim.realGroups.includes(r.external_id)
      if (isReal) {
        const newId = `g:${r.external_id}`
        const title = `真群 ${r.external_id}`
        if (r.id === newId) {
          if (r.channel !== 'qq') db.prepare(`UPDATE thread_meta SET channel = 'qq', title = ? WHERE id = ?`).run(title, newId)
        } else if (childCount(r.id) === 0) {
          if (exists(newId)) db.prepare(`DELETE FROM thread_meta WHERE id = ?`).run(r.id)
          else db.prepare(`UPDATE thread_meta SET id = ?, channel = 'qq', title = ? WHERE id = ?`).run(newId, title, r.id)
        }
      } else {
        const newId = r.kind === 'group' ? `sim:g:${r.external_id}` : `sim:p:${r.external_id}`
        const title = r.kind === 'group' ? `模拟群 ${r.external_id}` : `模拟私聊 ${r.external_id}`
        if (r.id === newId) {
          if (r.channel !== 'sim') db.prepare(`UPDATE thread_meta SET channel = 'sim', title = ? WHERE id = ?`).run(title, newId)
        } else if (childCount(r.id) === 0) {
          if (exists(newId)) db.prepare(`DELETE FROM thread_meta WHERE id = ?`).run(r.id)
          else db.prepare(`UPDATE thread_meta SET id = ?, channel = 'sim', title = ? WHERE id = ?`).run(newId, title, r.id)
        }
      }
    }
  } catch (e) {
    console.warn('[v2] 迁移真群/模拟群失败:', (e as Error).message)
  }
  _db = db
  return db
}

function rowToMeta(r: any): ThreadMeta {
  return {
    id: r.id,
    channel: r.channel,
    kind: r.kind,
    externalId: r.external_id,
    title: r.title,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lastMessageAt: r.last_message_at,
    lastPreview: r.last_preview,
    unread: r.unread,
    paused: !!r.paused,
    archived: !!r.archived,
  }
}

export function ensureThread(ref: ThreadRef, title = threadTitle(ref)): ThreadMeta {
  const db = openDb()
  const key = threadKey(ref)
  const now = Date.now()
  db.prepare(`
    INSERT INTO thread_meta(id, channel, kind, external_id, title, created_at, updated_at, last_message_at, last_preview, unread, paused)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', 0, 0)
    ON CONFLICT(id) DO NOTHING
  `).run(key, ref.channel, ref.kind, ref.externalId, title, now, now, now)
  return getThreadMeta(key)!
}

export function touchThread(msg: InboundMessage, opts: { unread?: boolean } = {}): ThreadMeta {
  const ref = msg.thread
  const key = threadKey(ref)
  ensureThread(ref)
  const db = openDb()
  const now = msg.at ?? Date.now()
  const preview = `${msg.senderNick}: ${msg.text}`.replace(/\s+/g, ' ').slice(0, 160)
  db.prepare(`
    UPDATE thread_meta
       SET updated_at = ?, last_message_at = ?, last_preview = ?,
           unread = unread + ?
     WHERE id = ?
  `).run(now, now, preview, opts.unread === false ? 0 : 1, key)
  return getThreadMeta(key)!
}

export function getThreadMeta(id: string): ThreadMeta | null {
  const db = openDb()
  const row = db.prepare(`SELECT * FROM thread_meta WHERE id = ?`).get(id)
  return row ? rowToMeta(row) : null
}

export function markRead(id: string): void {
  openDb().prepare(`UPDATE thread_meta SET unread = 0 WHERE id = ?`).run(id)
}

export function setPaused(id: string, paused: boolean): void {
  openDb().prepare(`UPDATE thread_meta SET paused = ?, updated_at = ? WHERE id = ?`).run(paused ? 1 : 0, Date.now(), id)
}

export function setArchived(id: string, archived: boolean): ThreadMeta | null {
  openDb().prepare(`UPDATE thread_meta SET archived = ?, updated_at = ? WHERE id = ?`).run(archived ? 1 : 0, Date.now(), id)
  return getThreadMeta(id)
}

export function listThreads(): ThreadMeta[] {
  seedFromMemory()
  const rows = openDb().prepare(`SELECT * FROM thread_meta ORDER BY archived ASC, last_message_at DESC, updated_at DESC`).all()
  return rows.map(rowToMeta)
}

// 每个线程的消息数（events 里 message.received + assistant.message 计数）
export function threadMessageCounts(): Record<string, number> {
  const db = openDb()
  const rows = db.prepare(`
    SELECT thread_id, count(*) n FROM events
    WHERE type IN ('message.received', 'assistant.message')
    GROUP BY thread_id
  `).all() as Array<{ thread_id: string; n: number }>
  const out: Record<string, number> = {}
  for (const r of rows) out[r.thread_id] = r.n
  return out
}

function seedFromMemory(): void {
  if (seeded) return
  seeded = true
  for (const s of listSceneSummaries()) {
    let ref = parseThreadKey(s.key)
    if (!ref) continue
    // 唯一真群 → qq 通道；其余 → sim 通道（模拟群）
    const isReal = ref.kind === 'group' && config.sim.realGroups.includes(ref.externalId)
    if (isReal && ref.channel !== 'qq') ref = { channel: 'qq', kind: ref.kind, externalId: ref.externalId }
    else if (!isReal && ref.channel !== 'sim') ref = { channel: 'sim', kind: ref.kind, externalId: ref.externalId }
    ensureThread(ref)
    const db = openDb()
    const key = threadKey(ref)
    const preview = s.summary ? s.summary.replace(/\s+/g, ' ').slice(0, 160) : ''
    db.prepare(`UPDATE thread_meta SET updated_at = ?, last_message_at = ?, last_preview = ? WHERE id = ? AND last_preview = ''`)
      .run(s.updatedAt, s.updatedAt, preview, key)
  }
}

export function appendEvent(ev: V2Event): void {
  const db = openDb()
  const thread = 'thread' in ev ? ev.thread : null
  db.prepare(`INSERT INTO events(ts, type, thread_id, payload) VALUES (?, ?, ?, ?)`)
    .run(ev.at ?? Date.now(), ev.type, thread, JSON.stringify(ev))
}

export function listEvents(thread?: string, limit = 200): V2Event[] {
  const db = openDb()
  const lim = Math.max(1, Math.min(1000, limit))
  const rows = thread
    ? db.prepare(`SELECT payload FROM events WHERE thread_id = ? ORDER BY id DESC LIMIT ?`).all(thread, lim)
    : db.prepare(`SELECT payload FROM events ORDER BY id DESC LIMIT ?`).all(lim)
  return rows.map((r: any) => JSON.parse(r.payload) as V2Event).reverse()
}

export function createRun(rec: RunRecord): void {
  openDb().prepare(`
    INSERT INTO runs(id, thread_id, trigger, status, started_at, model)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(rec.id, rec.threadId, rec.trigger, rec.status, rec.startedAt, rec.model ?? null)
}

export function finishRun(rec: RunRecord): void {
  openDb().prepare(`
    UPDATE runs
       SET status = ?, ended_at = ?, model = ?, tokens_in = ?, tokens_out = ?, cost = ?,
           error = ?, reply = ?, tool_calls = ?
     WHERE id = ?
  `).run(
    rec.status, rec.endedAt ?? Date.now(), rec.model ?? null,
    rec.tokensIn ?? 0, rec.tokensOut ?? 0, rec.cost ?? 0,
    rec.error ?? null, rec.reply ?? null, rec.toolCalls ?? 0, rec.id,
  )
}

export function listRuns(thread?: string, limit = 50): RunRecord[] {
  const db = openDb()
  const lim = Math.max(1, Math.min(500, limit))
  const rows = thread
    ? db.prepare(`SELECT * FROM runs WHERE thread_id = ? ORDER BY started_at DESC LIMIT ?`).all(thread, lim)
    : db.prepare(`SELECT * FROM runs ORDER BY started_at DESC LIMIT ?`).all(lim)
  return rows.map((r: any) => ({
    id: r.id,
    threadId: r.thread_id,
    trigger: r.trigger,
    status: r.status,
    startedAt: r.started_at,
    endedAt: r.ended_at ?? undefined,
    model: r.model ?? undefined,
    tokensIn: r.tokens_in ?? 0,
    tokensOut: r.tokens_out ?? 0,
    cost: r.cost ?? 0,
    error: r.error ?? undefined,
    reply: r.reply ?? undefined,
    toolCalls: r.tool_calls ?? 0,
  }))
}

export function addToolTrace(t: ToolTrace): void {
  openDb().prepare(`
    INSERT INTO tool_calls(id, run_id, name, args, result, status, started_at, duration_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(t.id, t.runId, t.name, JSON.stringify(t.args), t.result, t.status, t.startedAt, t.durationMs)
}

export function listToolCalls(runId: string): ToolTrace[] {
  const rows = openDb().prepare(`SELECT * FROM tool_calls WHERE run_id = ? ORDER BY started_at`).all(runId)
  return rows.map((r: any) => ({
    id: r.id,
    runId: r.run_id,
    name: r.name,
    args: JSON.parse(r.args),
    result: r.result,
    status: r.status,
    startedAt: r.started_at,
    durationMs: r.duration_ms,
  }))
}

export function getThreadDetail(id: string): {
  meta: ThreadMeta | null
  dialog: ReturnType<typeof loadDialog>['dialog']
  summary: string
  runs: RunRecord[]
  events: V2Event[]
} {
  const meta = getThreadMeta(id)
  const mem = loadDialog(id)
  return {
    meta,
    dialog: mem.dialog,
    summary: mem.summary,
    runs: listRuns(id, 30),
    events: listEvents(id, 100),
  }
}
