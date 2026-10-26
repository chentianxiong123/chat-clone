import { DatabaseSync } from 'node:sqlite'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync } from 'node:fs'

export interface UsageRecord {
  kind: string
  sub: string
  ok: number
  fail: number
  cost: number
  tokensIn: number
  tokensOut: number
  ts: number
  durationMs?: number
  ttftMs?: number
}

export interface UsageSummary {
  totals: Record<string, { ok: number; fail: number; cost: number; tokensIn: number; tokensOut: number }>
  perGroup: Record<string, { msg: number; reply: number; lastAt: number }>
  perModel: Record<string, { calls: number; tokensIn: number; tokensOut: number; ok: number; fail: number; avgDurationMs: number; avgTtftMs: number }>
  perProvider: Record<string, { calls: number; cost: number }>
  timeseries: Array<{ hour: string; llmCalls: number; embedCalls: number; msgs: number; replies: number; tokensIn: number; tokensOut: number }>
  sinceStart: number
  agg: {
    llm: { calls: number; ok: number; fail: number; successRate: number; avgDurationMs: number; avgTtftMs: number; tokensIn: number; tokensOut: number }
    embed: { calls: number; ok: number; fail: number; successRate: number }
  }
}

const DATA_DIR = join(dirname(fileURLToPath(new URL('.', import.meta.url))), 'data')
const DB_PATH = join(DATA_DIR, 'stats.db')

let _db: DatabaseSync | null = null

function openDb(): DatabaseSync {
  if (_db) return _db
  try {
    mkdirSync(DATA_DIR, { recursive: true })
    const db = new DatabaseSync(DB_PATH)
    db.exec(`
      CREATE TABLE IF NOT EXISTS usage_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        kind TEXT NOT NULL,
        sub TEXT,
        ok INTEGER NOT NULL DEFAULT 0,
        fail INTEGER NOT NULL DEFAULT 0,
        cost REAL NOT NULL DEFAULT 0,
        tokens_in INTEGER NOT NULL DEFAULT 0,
        tokens_out INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage_log(ts);
      CREATE INDEX IF NOT EXISTS idx_usage_kind ON usage_log(kind);
      CREATE TABLE IF NOT EXISTS group_stats (
        group_id INTEGER PRIMARY KEY,
        msg INTEGER NOT NULL DEFAULT 0,
        reply INTEGER NOT NULL DEFAULT 0,
        last_at INTEGER
      );
    `)
    // 兼容旧库：补齐新列（仅当缺失时）
    const cols = (db.prepare(`PRAGMA table_info(usage_log)`).all() as Array<{ name: string }>).map(c => c.name)
    if (!cols.includes('duration_ms')) db.exec(`ALTER TABLE usage_log ADD COLUMN duration_ms INTEGER NOT NULL DEFAULT 0`)
    if (!cols.includes('ttft_ms')) db.exec(`ALTER TABLE usage_log ADD COLUMN ttft_ms INTEGER NOT NULL DEFAULT 0`)
    _db = db
    return db
  } catch (e) {
    console.warn('[Stats] 打开 stats.db 失败（统计禁用）:', (e as Error).message)
    return null as unknown as DatabaseSync
  }
}

const startedAt = Date.now()

export function recordUsage(rec: UsageRecord): void {
  const db = openDb()
  if (!db) return
  try {
    db.prepare(
      `INSERT INTO usage_log(ts, kind, sub, ok, fail, cost, tokens_in, tokens_out, duration_ms, ttft_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      rec.ts,
      rec.kind,
      rec.sub ?? '',
      rec.ok,
      rec.fail,
      rec.cost,
      rec.tokensIn,
      rec.tokensOut,
      Math.round(rec.durationMs ?? 0),
      Math.round(rec.ttftMs ?? 0),
    )
  } catch (e) {
    console.warn('[Stats] 写入失败:', (e as Error).message)
  }
}

export function recordGroupMsg(groupId: number): void {
  const db = openDb()
  if (!db) return
  try {
    db.prepare(
      `INSERT INTO group_stats(group_id, msg, reply, last_at)
       VALUES (?, 1, 0, ?)
       ON CONFLICT(group_id) DO UPDATE SET
         msg = msg + 1,
         last_at = excluded.last_at`,
    ).run(groupId, Date.now())
  } catch { /* ignore */ }
}

export function recordGroupReply(groupId: number): void {
  const db = openDb()
  if (!db) return
  try {
    db.prepare(
      `INSERT INTO group_stats(group_id, msg, reply, last_at)
       VALUES (?, 0, 1, ?)
       ON CONFLICT(group_id) DO UPDATE SET
         reply = reply + 1,
         last_at = excluded.last_at`,
    ).run(groupId, Date.now())
  } catch { /* ignore */ }
}

export function getUsageSummary(hours = 24): UsageSummary {
  const db = openDb()
  const empty: UsageSummary = {
    totals: {},
    perGroup: {},
    perModel: {},
    perProvider: {},
    timeseries: [],
    sinceStart: 0,
    agg: {
      llm: { calls: 0, ok: 0, fail: 0, successRate: 0, avgDurationMs: 0, avgTtftMs: 0, tokensIn: 0, tokensOut: 0 },
      embed: { calls: 0, ok: 0, fail: 0, successRate: 0 },
    },
  }
  if (!db) return empty
  const since = Date.now() - hours * 3600 * 1000
  const totals: Record<string, { ok: number; fail: number; cost: number; tokensIn: number; tokensOut: number }> = {}
  const perModel: Record<string, { calls: number; tokensIn: number; tokensOut: number; ok: number; fail: number; avgDurationMs: number; avgTtftMs: number }> = {}
  const perProvider: Record<string, { calls: number; cost: number }> = {}

  const agg = {
    llm: { ok: 0, fail: 0, durationSum: 0, durationN: 0, ttftSum: 0, ttftN: 0, tokensIn: 0, tokensOut: 0 },
    embed: { ok: 0, fail: 0 },
  }

  for (const r of db.prepare(
    `SELECT kind, ok, fail, cost, tokens_in, tokens_out, duration_ms, ttft_ms FROM usage_log WHERE ts >= ?`,
  ).all(since) as Array<{
    kind: string
    ok: number
    fail: number
    cost: number
    tokens_in: number
    tokens_out: number
    duration_ms: number
    ttft_ms: number
  }>) {
    const t = totals[r.kind] ?? { ok: 0, fail: 0, cost: 0, tokensIn: 0, tokensOut: 0 }
    t.ok += r.ok
    t.fail += r.fail
    t.cost += r.cost
    t.tokensIn += r.tokens_in
    t.tokensOut += r.tokens_out
    totals[r.kind] = t

    if (r.kind === 'llm') {
      agg.llm.ok += r.ok
      agg.llm.fail += r.fail
      agg.llm.tokensIn += r.tokens_in
      agg.llm.tokensOut += r.tokens_out
      if (r.duration_ms > 0) { agg.llm.durationSum += r.duration_ms; agg.llm.durationN++ }
      if (r.ttft_ms > 0) { agg.llm.ttftSum += r.ttft_ms; agg.llm.ttftN++ }

      const m = perModel[r.sub || '当前模型'] ?? { calls: 0, tokensIn: 0, tokensOut: 0, ok: 0, fail: 0, avgDurationMs: 0, avgTtftMs: 0 }
      m.calls++
      m.ok += r.ok
      m.fail += r.fail
      m.tokensIn += r.tokens_in
      m.tokensOut += r.tokens_out
      if (r.duration_ms > 0) m.avgDurationMs += r.duration_ms
      if (r.ttft_ms > 0) m.avgTtftMs += r.ttft_ms
      perModel[r.sub || '当前模型'] = m
    }
    if (r.kind === 'embed') {
      agg.embed.ok += r.ok
      agg.embed.fail += r.fail
      const key = r.sub || 'Embed'
      const em = perModel[key] ?? { calls: 0, tokensIn: 0, tokensOut: 0, ok: 0, fail: 0, avgDurationMs: 0, avgTtftMs: 0 }
      em.calls++
      em.ok += r.ok
      em.fail += r.fail
      perModel[key] = em
    }
    if (r.kind === 'llm' || r.kind === 'embed') {
      const key = r.kind === 'llm' ? 'LLM' : 'Embed'
      const p = perProvider[key] ?? { calls: 0, cost: 0 }
      p.calls += r.ok + r.fail
      p.cost += r.cost
      perProvider[key] = p
    }
  }

  for (const m of Object.values(perModel)) {
    if (m.ok) {
      m.avgDurationMs = Math.round(m.avgDurationMs / m.ok)
      m.avgTtftMs = Math.round(m.avgTtftMs / m.ok)
    } else {
      m.avgDurationMs = 0
      m.avgTtftMs = 0
    }
  }

  const perGroup: Record<string, { msg: number; reply: number; lastAt: number }> = {}
  for (const g of db.prepare(`SELECT group_id, msg, reply, last_at FROM group_stats`).all() as Array<{
    group_id: number
    msg: number
    reply: number
    last_at: number | null
  }>) {
    perGroup[String(g.group_id)] = { msg: g.msg, reply: g.reply, lastAt: g.last_at ?? 0 }
  }

  // 小时序列（按查询起始对齐整点）
  const buckets = new Map<string, { llmCalls: number; embedCalls: number; msgs: number; replies: number; tokensIn: number; tokensOut: number }>()
  const now = new Date()
  now.setMinutes(0, 0, 0)
  const bucketStart = now.getTime()
  for (let i = hours - 1; i >= 0; i--) {
    const key = new Date(bucketStart - i * 3600 * 1000)
    buckets.set(key.toISOString().slice(0, 13) + ':00', { llmCalls: 0, embedCalls: 0, msgs: 0, replies: 0, tokensIn: 0, tokensOut: 0 })
  }
  for (const r of db.prepare(
    `SELECT ts, kind, sub, ok, tokens_in, tokens_out FROM usage_log WHERE ts >= ?`,
  ).all(since) as Array<{ ts: number; kind: string; sub: string | null; ok: number; tokens_in: number; tokens_out: number }>) {
    const key = new Date(Math.floor(r.ts / 3600 / 1000) * 3600 * 1000).toISOString().slice(0, 13) + ':00'
    const b = buckets.get(key)
    if (!b) continue
    if (r.kind === 'llm' && r.ok) { b.llmCalls++; b.tokensIn += r.tokens_in; b.tokensOut += r.tokens_out }
    if (r.kind === 'embed' && r.ok) b.embedCalls++
  }
  for (const g of db.prepare(`SELECT group_id, msg, reply, last_at FROM group_stats`).all() as Array<{
    group_id: number
    msg: number
    reply: number
    last_at: number | null
  }>) {
    const key = new Date(Math.floor((g.last_at ?? 0) / 3600 / 1000) * 3600 * 1000).toISOString().slice(0, 13) + ':00'
    const b = buckets.get(key)
    if (b && g.msg) b.msgs += g.msg
    if (b && g.reply) b.replies += g.reply
  }

  const llmCalls = agg.llm.ok + agg.llm.fail
  const embedCalls = agg.embed.ok + agg.embed.fail

  return {
    totals,
    perGroup,
    perModel,
    perProvider,
    timeseries: [...buckets.entries()].map(([hour, v]) => ({ hour, ...v })),
    sinceStart: Date.now() - startedAt,
    agg: {
      llm: {
        calls: llmCalls,
        ok: agg.llm.ok,
        fail: agg.llm.fail,
        successRate: llmCalls ? agg.llm.ok / llmCalls : 0,
        avgDurationMs: agg.llm.durationN ? agg.llm.durationSum / agg.llm.durationN : 0,
        avgTtftMs: agg.llm.ttftN ? agg.llm.ttftSum / agg.llm.ttftN : 0,
        tokensIn: agg.llm.tokensIn,
        tokensOut: agg.llm.tokensOut,
      },
      embed: {
        calls: embedCalls,
        ok: agg.embed.ok,
        fail: agg.embed.fail,
        successRate: embedCalls ? agg.embed.ok / embedCalls : 0,
      },
    },
  }
}