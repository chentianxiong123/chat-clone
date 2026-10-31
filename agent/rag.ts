import { config } from './config.js'
import { embed } from './llm.js'
import { DatabaseSync } from 'node:sqlite'
import { statSync } from 'node:fs'
import { Jieba } from '@node-rs/jieba'
import { dict } from '@node-rs/jieba/dict.js'

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
  // 格式/CQ 标记噪音（非虚词，是聊天记录里的标记垃圾，必须滤）
  'user', 'assistant', 'image', 'https', 'http', 'com', 'file', 'source', 'ai', 'url', 'cq', 'qq', 'png', 'jpg', 'gif',
  // 高频虚词（扫全库 Top 词频：fts/like 的 OR 匹配会因这些召回不相关，必须滤）
  '上次', '到底', '这个', '现在', '不是', '就是', '一个', '怎么', '知道', '我们', '可以', '东西', '觉得',
  '没有', '这样', '这么', '不会', '自己', '还是', '但是', '一样', '那个', '因为', '他们', '这些', '为什么',
  '应该', '不过', '是不是', '肯定', '确实', '真的', '时候', '大家', '可能', '这种', '以前', '一下', '出来',
  '其实', '然后', '发现', '很多', '已经', '那些', '还有', '一直', '感觉', '如果', '需要', '主要', '一定',
  '正常', '虽然', '不行', '只能', '所以', '一点', '不了', '只是', '只有', '看看', '好像', '那么', '而且',
  '认为', '两个', '差不多', '反正', '有点', '之前', '以为', '为了', '完全', '不要', '导致', '根本', '结果',
  '时间', '那种', '估计', '记得', '起来', '可惜', '最后', '意思', '不想', '我要', '的话', '全是', '后面',
  '不如', '今天', '特别', '地方', '事情', '里面', '容易', '一般', '而已', '怎么样', '当时', '只要',
  // 口语/脏话（高频无检索意义）
  '霍霍', '离谱', '吼吼', '几把', '嘿嘿', '司马', '恶心', '废物', '垃圾', '该死', '卧槽', '牛逼', '妈的', '傻逼', '他妈',
])

// jieba 真词分词器（@node-rs/jieba + 默认词典；new Jieba() 是空词典，必须 withDict）
const _jieba = Jieba.withDict(dict)

function extractKeywords(text: string): string[] {
  // 真词：jieba 分词（整词，非 2-gram），滤格式噪音/单字/纯数字标点/停用词
  const words = _jieba.cut(text, false)
  const out: string[] = []
  for (const w of words) {
    const t = w.trim().toLowerCase()
    if (t.length < 2) continue
    if (/^[\d\s.,!?/\\|_:\-"'()\[\]{}]+$/.test(t)) continue
    if (STOP_WORDS.has(t)) continue
    if (!out.includes(t)) out.push(t)
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
    // like 归一化：命中关键词占比（0~1），全词命中=1，部分=分数——比裸命中数更能反映相关度
    const total = Math.max(kws.length, 1)
    return rows.map(r => ({ ...r, score: r.score / total, method: 'like' as const }))
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

export async function searchRag(query: string, modeOverride?: string): Promise<string> {
  const res = await ragSearch(query)
  // ── 召回方式（mode）：modeOverride（工具传）> config.rag.recallMode > 默认 auto ──
  //   all    = 三路一起召回（合并去重按分排序）
  //   random = 随机挑一路非空（偶尔换召回方式，增加多样性；非严肃场景够用）
  //   vec/fts/like = 指定走某一路
  //   auto   = 规范化：主路=向量，最高分 < vecMinScore（召回不对）→ 回退 fts/like；
  //            全部不对/空 → 兜底取所有命中里最高分的路由（不空手而归）
  const mode = modeOverride || config.rag.recallMode
  const byMethod = (m: string): RagHit[] =>
    m === 'vec' ? res.vec : m === 'fts' ? res.fts : res.like
  const topScore = (arr: RagHit[]): number =>
    arr.length ? Math.max(...arr.map(h => h.score)) : 0

  let picked: RagHit[] = []
  if (mode === 'all') {
    // 三路加权归一化合并：各路线内 min-max 归一到 0~1，再乘权重——解决量纲不同（vec 0~1 / fts 0~几十 / like 0~1）
    // 权重：vec 语义最准 > fts 词匹配 > like 兜底；vec 不可用时 fts 主导、like 补
    const weights: Record<'vec' | 'fts' | 'like', number> = { vec: 0.5, fts: 0.35, like: 0.15 }
    const norm = (arr: RagHit[]): RagHit[] => {
      if (!arr.length) return []
      const mx = Math.max(...arr.map(h => h.score))
      const mn = Math.min(...arr.map(h => h.score))
      const span = mx - mn || 1
      return arr.map(h => ({ ...h, score: (h.score - mn) / span }))
    }
    const best = new Map<string, RagHit>()
    for (const m of ['vec', 'fts', 'like'] as const) {
      for (const h of norm(byMethod(m))) {
        const s = h.score * weights[m]
        const cur = best.get(h.chunkId)
        if (!cur || s > cur.score) best.set(h.chunkId, { ...h, score: s })
      }
    }
    picked = [...best.values()].sort((a, b) => b.score - a.score)
  } else if (mode === 'random') {
    const roads = ['vec', 'fts', 'like'].filter(m => byMethod(m).length)
    if (roads.length) picked = byMethod(roads[Math.floor(Math.random() * roads.length)])
  } else if (mode === 'vec' || mode === 'fts' || mode === 'like') {
    picked = byMethod(mode)
  } else {
    // auto：规范化多路召回规则（见上方注释）
    for (const m of config.rag.strategy) {
      const arr = byMethod(m)
      if (!arr.length) continue
      if (m === 'vec' && config.rag.vecMinScore > 0 && topScore(arr) < config.rag.vecMinScore) continue
      picked = arr
      break
    }
    if (!picked.length) {
      const all = [...res.vec, ...res.fts, ...res.like]
      if (all.length) {
        const mx = Math.max(...all.map(h => h.score))
        picked = all.filter(h => h.score === mx)
      }
    }
  }
  if (!picked.length) return ''
  // 返回完整对话对（user=对方 + assistant=本人）：AI 看到"对方说→本人怎么接"的语境，
  // 才能模仿接话节奏/语气/长度，而不是只拿一句干巴巴本人原话。
  // 限 2~3 对（6 行）、总长 ≤ 600 字，防止 RAG 淹没主上下文。
  const MAX_CHUNKS = 4
  const MAX_PER_CHUNK = 6
  const MAX_TOTAL_CHARS = 600
  const pairs = (text: string): string[] => text
    .split('\n')
    .filter(l => /^(user|assistant):/.test(l))
    .map(l => l.trim())
    .filter(Boolean)
    .slice(0, MAX_PER_CHUNK)
  let total = 0
  const lines: string[] = []
  for (const r of picked.slice(0, MAX_CHUNKS)) {
    const pairLines = pairs(r.text)
    if (!pairLines.length) continue
    for (const line of pairLines) {
      if (total + line.length > MAX_TOTAL_CHARS) break
      lines.push(line)
      total += line.length
    }
    if (total >= MAX_TOTAL_CHARS) break
  }
  if (!lines.length) return ''
  return lines.join('\n')
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

export interface RagSourceStat {
  name: string; count: number; minDate: string; maxDate: string; avgChars: number
}
export interface RagImportInfo {
  dbSize: number
  total: number
  minDate: string
  maxDate: string
  totalChars: number
  totalMessages: number
  embeddedDone: number
  embeddedTotal: number
  sources: RagSourceStat[]
  monthly: { m: string; n: number }[]
  meta: Record<string, string>
}

// ── 导入情况：chunk 库的总量 / 时间跨度 / 来源分布 / embed 覆盖 / 月度分布 ──
export async function ragImportInfo(): Promise<RagImportInfo | null> {
  const db = await openDb()
  if (!db) return null
  try {
    let dbSize = 0
    try { dbSize = statSync(config.rag.dbPath).size } catch { /* ignore */ }
    const base = db.prepare(
      'select count(*) n, min(date) mn, max(date) mx, sum(char_count) chars, sum(message_count) msgs from chunks',
    ).get() as { n: number; mn: string; mx: string; chars: number | null; msgs: number | null }
    const sourceRows = db.prepare(`
      select case when chunk_id like 'wechat_%' then 'wechat'
                  when chunk_id like 'qq_%' then 'qq'
                  else 'other' end as name,
             count(*) n, min(date) mn, max(date) mx, round(avg(char_count)) ac
      from chunks group by 1 order by 2 desc
    `).all() as Array<{ name: string; n: number; mn: string; mx: string; ac: number }>
    const emb = db.prepare(
      'select count(*) t, sum(case when embedded_at is not null then 1 else 0 end) d from chunks',
    ).get() as { t: number; d: number | null }
    const monthly = db.prepare(
      'select substr(date,1,7) m, count(*) n from chunks group by 1 order by 1',
    ).all() as Array<{ m: string; n: number }>
    const metaRows = db.prepare('select key, value from meta').all() as Array<{ key: string; value: string }>
    const meta: Record<string, string> = {}
    for (const r of metaRows) meta[r.key] = r.value
    return {
      dbSize,
      total: base.n,
      minDate: base.mn,
      maxDate: base.mx,
      totalChars: base.chars ?? 0,
      totalMessages: base.msgs ?? 0,
      embeddedDone: emb.d ?? 0,
      embeddedTotal: emb.t,
      sources: sourceRows.map(r => ({ name: r.name, count: r.n, minDate: r.mn, maxDate: r.mx, avgChars: r.ac })),
      monthly,
      meta,
    }
  } catch (e) {
    console.warn('[RAG] 读取导入信息失败:', (e as Error).message)
    return null
  }
}