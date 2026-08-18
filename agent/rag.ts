import { config } from './config.js'

// 常见停用词（廖历史记录里的高频虚词/口语词，不作为搜索词）
const STOP_WORDS = new Set([
  '的', '了', '吗', '呢', '吧', '啊', '哦', '嗯', '呀', '嘛', '不', '去', '来', '你', '我', '他', '她', '它',
  '在', '是', '有', '就', '都', '还', '也', '很', '太', '真', '没', '别', '会', '能', '要', '想', '看', '说',
  '什么', '怎么', '为什么', '这个', '那个', '一个', '没有', '还是', '不是', '可以', '我们', '你们', '他们',
  '现在', '真的', '是不是', '有没有', '算了', '吧唧', '霍霍', '哇', '吼吼', '嘻嘻', '哈哈', '呵呵', '确实',
  '知道', '觉得', '感觉', '时候', '东西', '事情', '问题', '地方', '今天', '明天', '昨天', '晚上', '白天',
  '上来', '上去', '下来', '下去', '过来', '过去', '起来', '出去', '进来', '进去', '哈', '嗯嗯', '好吧',
])

function safe(sql: string): string {
  return sql.replace(/'/g, "''").replace(/[%_]/g, ' ')
}

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

export async function searchRag(query: string): Promise<string> {
  if (!config.rag.dbPath) return ''

  const kws = extractKeywords(query)
  if (!kws.length) return ''

  const likes = kws.map(k => `text LIKE '%${safe(k)}%'`)
  const scores = kws.map(k => `(text LIKE '%${safe(k)}%')`)

  let db: any
  try {
    const { DatabaseSync } = await import('node:sqlite')
    db = new DatabaseSync(config.rag.dbPath, { readOnly: true })
    const rows = db.prepare(`
      SELECT text, (${scores.join(' + ')}) AS score
      FROM chunks
      WHERE ${likes.join(' OR ')}
      ORDER BY score DESC, RANDOM()
      LIMIT 3
    `).all() as Array<{ text: string; score: number }>
    if (!rows.length) return ''
    return rows.map(r => r.text.trim()).join('\n---\n')
  } catch (e) {
    console.warn('[RAG] 搜索失败:', (e as Error).message)
    return ''
  } finally {
    db?.close()
  }
}