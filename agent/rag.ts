import { config } from './config.js'
import { embed } from './llm.js'
import { DatabaseSync } from 'node:sqlite'

export interface RagHit {
  chunkId: string
  date: string
  text: string
  score: number
  method: 'vec' | 'fts' | 'like'
}

let _db: DatabaseSync | null = null
let _vecOk = false
let _ftsOk = false

function openDb(): Promise<any> {
  if (_db) return Promise.resolve(_db)
  if (!config.rag.dbPath) return Promise.resolve(null)
  return import('node:sqlite').then(({ DatabaseSync }) => {
    try {
      const db = new DatabaseSync(config.rag.dbPath, { readOnly: true, allowExtension: true })
      _db = db
      // 尝试加载 sqlite-vec（提供 vec0 虚拟表）
      if (config.rag.vec0) {
        try {
          db.loadExtension(config.rag.vec0)
          db.prepare('select vec_version()').get()
          _vecOk = true
        } catch (e) {
          console.warn('[RAG] vec0 加载失败，退化为 FTS5/LIKE:', (e as Error).message)
        }
      }
      // 验证 FTS5 可用
      try {
        db.prepare(`SELECT count(*) n FROM chunks_fts WHERE chunks_fts MATCH 'x'`).get()
        _ftsOk = true
      } catch {
        _ftsOk = false
      }
      return db
    } catch (e) {
      console.warn('[RAG] 打开数据库失败:', (e as Error).message)
      return null
    }
  })
}

function vecToBlob(vec: number[] | Float32Array): Buffer {
  return Buffer.from(new Float32Array(vec).buffer)
}

// 常见停用词
const STOP_WORDS = new Set([
  '的', '了', '吗', '呢', '吧', '啊', '哦', '嗯', '呀', '嘛', '不', '去', '来', '你', '我', '他', '她', '它',
  '在', '是', '有', '就', '都', '还', '也', '很', '太', '真', '没', '别', '会', '能', '要', '想', '看', '说',
  '什么', '怎么', '为什么', '这个', '那个', '一个', '没有', '还是', '不是', '可以', '我们', '你们', '他们',
  '现在', '真的', '是不是', '有没有', '算了', '吧唧', '霍霍', '哇', '吼吼', '嘻嘻', '哈哈', '呵呵', '确实',
  '知道', '觉得', '感觉', '时候', '东西', '事情', '问题', '地方', '今天', '明天', '昨天', '晚上', '白天',
  '上来', '上去', '下来', '下去', '过来', '过去', '起来', '出去', '进来', '进去', '哈', '嗯嗯', '好吧',
])

function extractKeywords(text: string): string[] {
  const segs = text.match(/[\u4e00-\u9fa5a-zA-Z0-9]{2,}/g) || []
  const out: string[] = []
  for (const s of segs) {
    const max = s.length > 1 ? s.length - 1 : 1
    for (let i = 0; i < Math.max(1, max); i++) {
      const w = s.slice(i, i + 2)
      if (w.length >= 2 && !STOP_WORDS.has(w) && !out.includes(w)) out.push(w)
    }
  }
  return out.slice(0, 6)
}

// ── 向量检索（sqlite-vec vec0 KNN）────────────────────────────────────

async function searchVec(queryVec: Float32Array, topK: number): Promise<RagHit[]> {
  if (!config.rag.strategy.includes('vec') || !_vecOk) return []
  const db = await openDb()
  if (!db) return []
  try {
    const rows = db.prepare(`
      SELECT c.chunk_id AS chunkId, c.date AS date, c.text AS text, v.distance AS dist
      FROM vec_qwen3_0_6b v
      JOIN chunks c ON c.chunk_rowid = v.rowid
      WHERE v.embedding MATCH ? AND k = ?
    `).all(vecToBlob(queryVec), topK) as Array<{ chunkId: string; date: string; text: string; dist: number }>
    return rows.map(r => ({
      chunkId: r.chunkId,
      date: r.date,
      text: r.text,
      score: Math.max(0, 1 - r.dist),
      method: 'vec',
    }))
  } catch (e) {
    console.warn('[RAG] vec0 检索失败:', (e as Error).message)
    return []
  }
}

// ── FTS5 BM25 检索───────────────────────────────────────────────────────

function searchFts(keywords: string[], topK: number): RagHit[] {
  if (!config.rag.strategy.includes('fts') || !_ftsOk || !keywords.length) return []
  const db = _db
  if (!db) return []
  try {
    const query = keywords.map(k => `"${k.replace(/"/g, '""')}"`).join(' OR ')
    const rows = db.prepare(`
      SELECT c.chunk_id AS chunkId, c.date AS date, c.text AS text, bm25(chunks_fts) AS score
      FROM chunks_fts f
      JOIN chunks c ON c.chunk_rowid = f.rowid
      WHERE chunks_fts MATCH ?
      ORDER BY score
      LIMIT ?
    `).all(query, topK) as Array<{ chunkId: string; date: string; text: string; score: number }>
    return rows.map(r => ({
      chunkId: r.chunkId,
      date: r.date,
      text: r.text,
      score: -r.score, // bm25 负值，取负后越大越相关
      method: 'fts',
    }))
  } catch (e) {
    console.warn('[RAG] FTS5 检索失败:', (e as Error).message)
    return []
  }
}

// ── 关键词 LIKE 检索（最后兜底）─────────────────────────────────────────

function searchLike(query: string, topK: number): RagHit[] {
  if (!config.rag.strategy.includes('like')) return []
  const db = _db
  if (!db) return []
  const kws = extractKeywords(query)
  if (!kws.length) return []
  try {
    const likes = kws.map(k => `text LIKE '%${k.replace(/'/g, "''")}%'`)
    const scores = kws.map(k => `(text LIKE '%${k.replace(/'/g, "''")}%')`)
    const rows = db.prepare(`
      SELECT chunk_id AS chunkId, date AS date, text AS text, (${scores.join(' + ')}) AS score
      FROM chunks
      WHERE ${likes.join(' OR ')}
      ORDER BY score DESC, RANDOM()
      LIMIT ?
    `).all(topK) as Array<{ chunkId: string; date: string; text: string; score: number }>
    return rows.map(r => ({ ...r, method: 'like' as const }))
  } catch (e) {
    console.warn('[RAG] LIKE 检索失败:', (e as Error).message)
    return []
  }
}

// ── 对外主入口：按策略顺序检索，返回三路由命中 ─────────────────────────

export interface RagResult {
  vec: RagHit[]
  fts: RagHit[]
  like: RagHit[]
  usedEmbed: boolean
  dbPath: string
  vecLoaded: boolean
}

export async function searchRag(query: string): Promise<string> {
  const res = await ragSearch(query)
  // 按策略优先级拼合：先用命中的那个路由
  let picked: RagHit[] = []
  for (const m of config.rag.strategy) {
    if (m === 'vec' && res.vec.length) picked = res.vec
    else if (m === 'fts' && res.fts.length) picked = res.fts
    else if (m === 'like' && res.like.length) picked = res.like
    if (picked.length) break
  }
  if (!picked.length) return ''
  // 关键：只取"本人"发言（assistant 行），剔除对方(user)的发言，
  // 避免把大肥鱼/朋友的话当"本人原话"注入，导致人格混淆与复读。
  // 每 chunk 限本人 2 条、全库最多 6 条、总长 ≤ 500 字，防止 RAG 淹没主上下文。
  const MAX_CHUNKS = 4
  const MAX_PER_CHUNK = 2
  const MAX_TOTAL_CHARS = 500
  const own = (text: string): string[] => text
    .split('\n')
    .filter(l => l.startsWith('assistant:'))
    .map(l => l.replace(/^assistant:\s*/, '').trim())
    .filter(Boolean)
    .slice(0, MAX_PER_CHUNK)
  let total = 0
  const lines: string[] = []
  for (const r of picked.slice(0, MAX_CHUNKS)) {
    const ownLines = own(r.text)
    if (!ownLines.length) continue
    for (const line of ownLines) {
      if (total + line.length > MAX_TOTAL_CHARS) break
      lines.push(line)
      total += line.length
    }
    if (total >= MAX_TOTAL_CHARS) break
  }
  if (!lines.length) return ''
  return lines.join('\n--\n')
}

export async function ragSearch(query: string): Promise<RagResult> {
  await openDb()
  const topK = config.rag.topK
  // 本地检索先行（fts/like 零成本），顺便决定要不要升级向量
  const kws = extractKeywords(query)
  const fts = searchFts(kws, topK)
  const like = searchLike(query, topK)
  const localEmpty = fts.length === 0 && like.length === 0

  let vec: RagHit[] = []
  let usedEmbed = false

  // 向量检索（仅当策略包含 vec 且可用）
  if (config.rag.strategy.includes('vec') && config.rag.embedEnabled && config.rag.embedEndpoint) {
    // 混合策略：一般只走本地（fts/like 零成本）省远程 embed API 调用；
    // 命中 vecProb 概率才升级向量；本地全空时按配置强制兜底
    const shouldVec = localEmpty && config.rag.vecFallbackOnEmpty
      ? true
      : Math.random() < config.rag.vecProb
    if (shouldVec) {
      try {
        const qVec = await embed(query)
        if (qVec) {
          vec = await searchVec(qVec, topK)
          usedEmbed = true
        }
      } catch (e) {
        console.warn('[RAG] embed 失败，跳过向量检索:', (e as Error).message)
      }
    }
  }

  return {
    vec,
    fts,
    like,
    usedEmbed,
    dbPath: config.rag.dbPath,
    vecLoaded: _vecOk,
  }
}

export async function ragStatus(): Promise<{
  dbPath: string; vecLoaded: boolean; ftsOk: boolean; count?: number;
  embedOk: boolean; strategy: string[]; enabledModes: string[]
}> {
  await openDb()
  const db = _db
  let count: number | undefined
  if (db) {
    try {
      count = (db.prepare('select count(*) n from chunks').get() as { n: number }).n
    } catch { /* ignore */ }
  }
  const enabledModes = config.rag.strategy.filter(m => {
    if (m === 'vec') return _vecOk && config.rag.embedEnabled && !!config.rag.embedEndpoint
    if (m === 'fts') return _ftsOk
    return true
  })
  return {
    dbPath: config.rag.dbPath,
    vecLoaded: _vecOk,
    ftsOk: _ftsOk,
    count,
    embedOk: !!config.rag.embedEndpoint && config.rag.embedEnabled,
    strategy: config.rag.strategy,
    enabledModes,
  }
}