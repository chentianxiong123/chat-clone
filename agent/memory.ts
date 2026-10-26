import { DatabaseSync } from 'node:sqlite'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync } from 'node:fs'
import { config } from './config.js'
import { callLlm } from './llm.js'
import type { ChatMessage } from './llm.js'
import type { SceneKey } from './core.js'

const DATA_DIR = join(dirname(fileURLToPath(new URL('.', import.meta.url))), 'data')
const DB_PATH = join(DATA_DIR, 'memory.db')

let _db: DatabaseSync | null = null

function openDb(): DatabaseSync {
  if (_db) return _db
  try {
    mkdirSync(DATA_DIR, { recursive: true })
    const db = new DatabaseSync(DB_PATH)
    db.exec(`
      CREATE TABLE IF NOT EXISTS scene_dialog (
        scene_key TEXT PRIMARY KEY,
        dialog_json TEXT NOT NULL,
        summary TEXT DEFAULT '',
        updated_at INTEGER NOT NULL
      );
    `)
    _db = db
    return db
  } catch (e) {
    console.warn('[Memory] 打开 memory.db 失败（记忆持久化禁用）:', (e as Error).message)
    return null as unknown as DatabaseSync
  }
}

// ── Token 估算（参考 AstrBot EstimateTokenCounter：中文0.6 / emoji2 / 英文0.3）──
const EMOJI_PATTERN = /[\u200d\u2600-\u27bf\ufe00-\ufe0f\U0001f000-\U0001faff]/g

export function estimateTokens(text: string): number {
  const chinese = (text.match(/[\u4e00-\u9fff]/g) || []).length
  const emoji = (text.match(EMOJI_PATTERN) || []).length
  const other = text.length - chinese - emoji
  return Math.round(chinese * 0.6 + emoji * 2.0 + other * 0.3)
}

export function countMessagesTokens(msgs: ChatMessage[]): number {
  return msgs.reduce((sum, m) => sum + estimateTokens(m.content), 0)
}

// ── 按轮切分（参考 AstrBot round_utils：user→assistant 一组轮）──
export function splitIntoRounds(msgs: ChatMessage[]): ChatMessage[][] {
  const rounds: ChatMessage[][] = []
  let cur: ChatMessage[] = []
  for (const m of msgs) {
    cur.push(m)
    if (m.role === 'assistant') {
      rounds.push(cur)
      cur = []
    }
  }
  if (cur.length) rounds.push(cur)
  return rounds
}

// ── 持久化读写 ──
export function loadDialog(key: SceneKey): { dialog: ChatMessage[]; summary: string } {
  const db = openDb()
  if (!db) return { dialog: [], summary: '' }
  try {
    const row = db.prepare(`SELECT dialog_json, summary FROM scene_dialog WHERE scene_key = ?`).get(key) as
      | { dialog_json: string; summary: string }
      | undefined
    if (!row) return { dialog: [], summary: '' }
    const dialog = JSON.parse(row.dialog_json) as ChatMessage[]
    return { dialog, summary: row.summary || '' }
  } catch {
    return { dialog: [], summary: '' }
  }
}

export function saveDialog(key: SceneKey, dialog: ChatMessage[], summary: string): void {
  const db = openDb()
  if (!db) return
  try {
    db.prepare(
      `INSERT INTO scene_dialog(scene_key, dialog_json, summary, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(scene_key) DO UPDATE SET
         dialog_json = excluded.dialog_json,
         summary = excluded.summary,
         updated_at = excluded.updated_at`,
    ).run(key, JSON.stringify(dialog), summary, Date.now())
  } catch (e) {
    console.warn('[Memory] 持久化失败:', (e as Error).message)
  }
}

export function clearDialogDb(key: SceneKey): void {
  const db = openDb()
  if (!db) return
  try {
    db.prepare(`DELETE FROM scene_dialog WHERE scene_key = ?`).run(key)
  } catch { /* ignore */ }
}

export function listSceneSummaries(): Array<{ key: string; summary: string; updatedAt: number; dialogLen: number }> {
  const db = openDb()
  if (!db) return []
  try {
    return (db.prepare(`SELECT scene_key, dialog_json, summary, updated_at FROM scene_dialog`).all() as Array<{
      scene_key: string
      dialog_json: string
      summary: string
      updated_at: number
    }>).map(r => ({
      key: r.scene_key,
      summary: r.summary || '',
      updatedAt: r.updated_at,
      dialogLen: (JSON.parse(r.dialog_json) as unknown[]).length,
    }))
  } catch {
    return []
  }
}

export function listSceneKeys(): string[] {
  const db = openDb()
  if (!db) return []
  try {
    return (db.prepare(`SELECT scene_key FROM scene_dialog`).all() as Array<{ scene_key: string }>).map(r => r.scene_key)
  } catch {
    return []
  }
}

// ── LLM 摘要压缩（参考 AstrBot LLMSummaryCompressor）──
// 超阈值 → 老轮次 LLM 摘要 + 保留最近 ratio 轮次做精确上下文
export async function compressDialog(
  dialog: ChatMessage[],
  summary: string,
  maxTokens: number,
  keepRecentRatio: number,
): Promise<{ dialog: ChatMessage[]; summary: string }> {
  const totalTokens = countMessagesTokens(dialog)
  if (totalTokens <= maxTokens) return { dialog, summary }

  // 按 token 保留最近的轮次
  const rounds = splitIntoRounds(dialog)
  const budget = Math.max(1, Math.round(totalTokens * keepRecentRatio))
  let used = 0
  let recentStart = rounds.length
  for (let idx = rounds.length - 1; idx >= 0; idx--) {
    const rTokens = countMessagesTokens(rounds[idx])
    if (used > 0 && used + rTokens > budget) break
    used += rTokens
    recentStart = idx
  }
  const oldRounds = rounds.slice(0, recentStart)
  const recentRounds = rounds.slice(recentStart)

  // 最新用户消息整轮保留
  if (dialog.length && dialog[dialog.length - 1].role === 'user' && oldRounds.length) {
    const lastOld = oldRounds[oldRounds.length - 1]
    if (lastOld.length && lastOld[lastOld.length - 1] === dialog[dialog.length - 1]) {
      oldRounds.pop()
      recentRounds.unshift(lastOld)
    }
  }

  if (!oldRounds.length) return { dialog: recentRounds, summary }

  // 拼旧轮次给 LLM 生成摘要
  const oldText = oldRounds.map(r => r.map(m => `${m.role === 'user' ? '用户' : '我'}: ${m.content}`).join('\n')).join('\n---\n')
  const summaryPrompt = [
    { role: 'system' as const, content: `你是对话摘要助手。把以下群聊记录压缩成简短中文摘要（2-4句话），保留关键信息和最新进展。只输出摘要内容。` },
    { role: 'user' as const, content: oldText },
  ]
  const newSummary = await callLlm(summaryPrompt)

  const merged = summary && newSummary
    ? `${summary}\n${newSummary}`
    : (newSummary || summary)

  // 注入历史摘要对（AstrBot 方式）：user 摘要 + assistant Acknowledged
  const summaryPair: ChatMessage[] = merged
    ? [
        { role: 'user', content: `我们之前的对话摘要：${merged}`, time: Date.now() },
        { role: 'assistant', content: '（收到，继续聊）', time: Date.now() },
      ]
    : []

  return { dialog: [...summaryPair, ...recentRounds], summary: merged }
}

/** 判断是否应压缩 */
export function shouldCompress(dialog: ChatMessage[], maxTokens: number, threshold: number): boolean {
  if (maxTokens <= 0 || !dialog.length) return false
  const tokens = countMessagesTokens(dialog)
  return tokens / maxTokens > threshold
}
