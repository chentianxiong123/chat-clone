import { DatabaseSync } from 'node:sqlite'
import { copyFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const AGENT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DATA_DIR = process.env.CHAT_DATA_DIR || resolve(AGENT_DIR, '..', 'data')
const AGENT_DB = join(DATA_DIR, 'agent.db')
const MEMORY_DB = join(DATA_DIR, 'memory.db')
const REAL_ID = 'g:719972557'

function backup(db: string): string {
  if (!existsSync(db)) return ''
  const bak = `${db}.bak.${Date.now()}`
  copyFileSync(db, bak)
  console.log('备份 →', bak)
  return bak
}

function clearAgent(): void {
  if (!existsSync(AGENT_DB)) return
  const db = new DatabaseSync(AGENT_DB)
  db.exec('BEGIN')
  db.prepare(`DELETE FROM tool_calls WHERE run_id IN (SELECT id FROM runs WHERE thread_id != ?)`).run(REAL_ID)
  db.prepare(`DELETE FROM runs WHERE thread_id != ?`).run(REAL_ID)
  db.prepare(`DELETE FROM events WHERE thread_id IS NOT NULL AND thread_id != ?`).run(REAL_ID)
  db.prepare(`DELETE FROM thread_meta WHERE id != ?`).run(REAL_ID)
  db.exec('COMMIT')
  console.log('agent.db: 保留真群', REAL_ID,
    '| 剩余 thread_meta=', db.prepare('select count(*) n from thread_meta').get().n,
    'events=', db.prepare('select count(*) n from events').get().n,
    'runs=', db.prepare('select count(*) n from runs').get().n,
    'tool_calls=', db.prepare('select count(*) n from tool_calls').get().n)
}

function clearMemory(): void {
  if (!existsSync(MEMORY_DB)) return
  const db = new DatabaseSync(MEMORY_DB)
  db.exec('BEGIN')
  db.prepare(`DELETE FROM scene_dialog WHERE scene_key != ?`).run(REAL_ID)
  db.prepare(`DELETE FROM facts WHERE scene_key != ?`).run(REAL_ID)
  db.exec('COMMIT')
  console.log('memory.db: 保留', REAL_ID,
    '| 剩余 scene_dialog=', db.prepare('select count(*) n from scene_dialog').get().n,
    'facts=', db.prepare('select count(*) n from facts').get().n)
}

console.log('AGENT_DB =', AGENT_DB)
console.log('MEMORY_DB =', MEMORY_DB)
backup(AGENT_DB)
backup(MEMORY_DB)
clearAgent()
clearMemory()
console.log('完成。usage_log（stats.db）未触碰，token 调用记录保留。')
