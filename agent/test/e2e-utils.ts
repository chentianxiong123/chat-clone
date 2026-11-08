/**
 * test/e2e-utils.ts —— e2e 测试基础设施
 *
 * 全盘 mock 边界：
 *  - LLM 供应商：假 streamFn（按脚本返回 tool call / 文本），不真调 LLM
 *  - RAG 库：临时小 SQLite（测试语料：加班/蓝屏/键盘），不查生产 230MB 库
 *  - stats.db：临时路径，不碰生产 data/stats.db
 *  - 不 mock 的（真跑）：runtime / pi-agent(pi 内核) / pi-tools(门禁+批量) / rag(真查临时库) / stats(真写临时库)
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/** 建临时 RAG SQLite（测试语料），返回 dbPath */
export function makeTempRagDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'chat-clone-rag-'))
  const dbPath = join(dir, 'rag-test.sqlite')
  const db = new DatabaseSync(dbPath)
  db.exec(`
    CREATE TABLE chunks (
      chunk_id TEXT PRIMARY KEY, date TEXT, text TEXT, char_count INTEGER, message_count INTEGER,
      embed_text TEXT, embedded_at TEXT
    );
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
  `)
  // 测试语料：本人（assistant）短句 + 场景 user，覆盖 加班/蓝屏/键盘/周末
  const seed = [
    { id: 'c1', date: '2024-05-01', user: '加班太累了', asst: '确实麻了 天天加班 身体要垮了' },
    { id: 'c2', date: '2024-05-02', user: '不想干了', asst: '辞职呗 这种公司呆着有啥意思' },
    { id: 'c3', date: '2023-08-10', user: '电脑蓝屏了', asst: '草 这破电脑又蓝屏 重装系统吧' },
    { id: 'c4', date: '2023-08-11', user: '电脑黑屏了', asst: '黑屏 拔电源按电源键 8秒 试试' },
    { id: 'c5', date: '2024-01-15', user: '机械键盘太吵', asst: '茶轴吧 声音小 手感还行' },
    { id: 'c6', date: '2024-01-16', user: '键盘卡了', asst: '清灰吧 拔了拍一拍' },
    { id: 'c7', date: '2024-06-01', user: '周末干嘛', asst: '没啥安排 你要去的话我陪你' },
  ]
  const ins = db.prepare('INSERT INTO chunks(chunk_id,date,text,char_count,message_count,embed_text,embedded_at) VALUES (?,?,?,?,?,?,?)')
  for (const s of seed) {
    const text = `user: ${s.user}\nassistant: ${s.asst}`
    ins.run(s.id, s.date, text, text.length, 2, '', null)
  }
  db.close()
  return dbPath
}

/** 建临时 stats SQLite（usage_log 表），返回 dbPath */
export function makeTempStatsDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'chat-clone-stats-'))
  const dbPath = join(dir, 'stats-test.sqlite')
  const db = new DatabaseSync(dbPath)
  db.exec(`
    CREATE TABLE IF NOT EXISTS usage_log (
      id INTEGER PRIMARY KEY, ts INTEGER, kind TEXT, sub TEXT,
      ok INTEGER, fail INTEGER, cost REAL,
      tokens_in INTEGER, tokens_out INTEGER, cached_tokens INTEGER,
      duration_ms REAL, ttft_ms REAL
    );
  `)
  db.close()
  return dbPath
}

export interface TempDirs {
  ragDb: string
  statsDb: string
  cleanup: () => void
}

export function makeTempDbs(): TempDirs {
  const ragDb = makeTempRagDb()
  const statsDb = makeTempStatsDb()
  const dirs = new Set<string>()
  dirs.add(ragDb.slice(0, ragDb.lastIndexOf('/')))
  dirs.add(statsDb.slice(0, statsDb.lastIndexOf('/')))
  return {
    ragDb,
    statsDb,
    cleanup: () => { for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ } } },
  }
}
