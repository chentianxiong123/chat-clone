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

// ── ②③ 相关性：bigram 提取（中文二元组 + 英文/数字词），用于"chunk 跟 query 相不相关"判断 ──
const STOP_BIGRAMS = new Set([
  '什么', '怎么', '为什', '这个', '那个', '一个', '没有', '还是', '不是', '可以',
  '我们', '你们', '他们', '现在', '真的', '是不', '有没', '东西', '事情', '问题',
  '时候', '今天', '明天', '昨天', '晚上', '白天',
])
/** 提取关键词 bigram（去停用词）：相关性判断用 */
function bigrams(s: string): Set<string> {
  const q = s.replace(/\s+/g, '')
  const grams = new Set<string>()
  for (let i = 0; i < q.length - 1; i++) {
    const g = q.slice(i, i + 2)
    if (/^[\u4e00-\u9fff]{2}$/.test(g) && !STOP_BIGRAMS.has(g)) grams.add(g)
  }
  for (const w of q.match(/[a-zA-Z0-9_]{2,}/g) || []) grams.add(w.toLowerCase())
  return grams
}

function extractKeywords(text: string): string[] {
  // 真词：jieba 分词，滤格式噪音/单字/纯数字标点/停用词。
  // ④ 保复合词：用 cutForSearch（混合模式）——比 cut(false) 多切出"蓝屏/茶轴/机械键盘"这种复合词，
  //   避免判别词被拆成单字后滤掉（cut 把"蓝屏"切"蓝/屏"，单字滤光，判别词就丢了）。
  const words = _jieba.cutForSearch(text, false)
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
    // ④ 低频词加权：全表命中量 < likeLowFreqMax 的词是"低频判别词"（命中几条的专有名/罕见词，如蓝屏=5、茶轴=0），
    //   权重 3.0；高频泛词（命中>200 条，如天天=3343、电脑=728）权重 0.5——让判别词主导 LIKE 召回，不被高频词淹没。
    let weights: number[]
    if (config.rag.likeLowFreqWeight) {
      weights = kws.map(k => {
        let cnt = 0
        try { cnt = (db.prepare(`SELECT count(*) n FROM chunks WHERE text LIKE ?`).get(`%${k.replace(/'/g, "''")}%`) as { n: number }).n } catch { cnt = 0 }
        return cnt < config.rag.likeLowFreqMax ? 3.0 : 0.5
      })
    } else {
      weights = kws.map(() => 1)
    }
    const likes = kws.map(k => `text LIKE '%${k.replace(/'/g, "''")}%'`)
    const scores = kws.map((k, i) => `(text LIKE '%${k.replace(/'/g, "''")}%') * ${weights[i]}`)
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
  // ── 召回质量提升：把"整段 chunk（user+assistant 混）"提炼成"贴题的本人短句" ──
  // ① 只取本人（assistant）短句（assistantOnly），或 ①B 保留 ≤2 句最相关 user 作语境（keepUserContext）
  // ② 相关性闸门（relevanceGate）：chunk 跟 query bigram 重合 < 阈值的不要（宁缺毋滥，防"蓝屏→日本"错召回）
  // ③ 本人短句按相关度排序（rerankByRelevance）：最贴 query 的短句优先喂
  const qGrams = bigrams(query)
  const qBigrams = (s: string): Set<string> => bigrams(s)
  const relevanceOf = (line: string): number => {
    const g = qBigrams(line)
    let hits = 0
    for (const b of g) if (qGrams.has(b)) hits++
    return hits
  }
  const MAX_CHUNKS = 4
  const MAX_TOTAL_CHARS = 600
  // ② 相关性闸门：按"跟 query 的 bigram 重合"给 chunk 打分，< relevanceGate 的丢
  const gate = config.rag.relevanceGate
  const eligible = gate > 0
    ? picked.filter(r => {
        const hits = relevanceOf(r.text)
        return hits >= gate
      })
    : picked
  const pool = eligible.length ? eligible : picked // 闸门太严导致全丢时，退而不空手
  // ③ 按 chunk 相关度降序（原 picked 已按 score 排，闸门后保持）；随机化从 top 池抽
  const topPool = pool.slice(0, Math.max(pool.length, MAX_CHUNKS * 3, 12))
  const sampled = config.rag.rerankByRelevance
    ? topPool.slice(0, MAX_CHUNKS) // 相关度高的优先（不随机，保证最贴题的喂）
    : [...topPool].sort(() => Math.random() - 0.5).slice(0, MAX_CHUNKS)
  let total = 0
  const lines: string[] = []
  for (const r of sampled) {
    const allLines = r.text.split('\n').filter(l => /^(user|assistant):/.test(l)).map(l => l.trim()).filter(Boolean)
    // ① 本人短句化：只保留 assistant 行（本人真实反应，味道最纯）
    let asstLines: string[]
    let userCtx: string[] = []
    if (config.rag.assistantOnly) {
      asstLines = allLines.filter(l => l.startsWith('assistant:')).map(l => l.replace(/^assistant:\s*/, '').trim())
      // ①B 可选：保留 ≤2 句最相关 user 作语境（模型知道"遇到啥情况→这么回"）
      if (config.rag.keepUserContext) {
        const userLines = allLines.filter(l => l.startsWith('user:')).map(l => l.replace(/^user:\s*/, '').trim())
        userCtx = userLines.sort((a, b) => relevanceOf(b) - relevanceOf(a)).slice(0, 2).map(t => `对方：${t}`)
      }
    } else {
      // 未开 assistantOnly：保持原"完整对话对"（user+assistant）
      asstLines = allLines.map(l => l).slice(0, 6)
    }
    if (config.rag.assistantOnly) {
      // ③ 本人短句按相关度排序（最贴 query 的优先）
      asstLines = asstLines.filter(t => t).sort((a, b) => relevanceOf(b) - relevanceOf(a))
    }
    const chosen = config.rag.assistantOnly
      ? [...userCtx, ...asstLines.slice(0, 4)] // 语境（若开）+ 本人短句 top4
      : asstLines
    if (!chosen.length) continue
    if (r.date) lines.push(`（记录于 ${r.date}）`)
    for (const line of chosen) {
      if (total + line.length > MAX_TOTAL_CHARS) break
      lines.push(line)
      total += line.length
    }
    if (total >= MAX_TOTAL_CHARS) break
  }
  if (!lines.length) return ''
  return lines.join('\n')
}

/**
 * 批量召回：LLM 一次给多个关键词（queries[]），每个词各调 searchRag，结果 union 拼接。
 * 减少 ReAct 往返——不用反复"搜一个词→没翻到→换词再搜"，一次给够上下文。
 * 去重：同一段召回文本（同 chunk 被多词命中）只出现一次。总长仍限 MAX_TOTAL_CHARS 量级。
 */
export async function searchRagBatch(queries: string[], modeOverride?: string): Promise<string> {
  const qs = [...new Set(queries.map(q => q.trim()).filter(Boolean))]
  if (!qs.length) return ''
  // 并行召回（每词独立），各词最多取 400 字符，拼一起 LLM 一次看够
  const results = await Promise.all(qs.map(q => searchRag(q, modeOverride)))
  // 按行去重（同 chunk 被多词命中只留一次），保序
  const seen = new Set<string>()
  const lines: string[] = []
  for (const r of results) {
    for (const line of r.split('\n')) {
      const t = line.trim()
      if (!t || seen.has(t)) continue
      seen.add(t)
      lines.push(line)
    }
  }
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