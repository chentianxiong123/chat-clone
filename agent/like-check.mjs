// 直接连 RAG 库，手动跑 like 路，看命中了什么关键词、召回了哪些 chunk
import { DatabaseSync } from 'node:sqlite'
import { Jieba } from '@node-rs/jieba'
import { dict } from '@node-rs/jieba/dict.js'

const db = new DatabaseSync(process.env.RAG_DB_PATH, { readOnly: true })
const jieba = Jieba.withDict(dict)

// 复制 rag.ts 的 STOP_WORDS（关键停用词）
const STOP_WORDS = new Set(['的','了','吗','呢','吧','啊','哦','嗯','呀','嘛','不','去','来','你','我','他','她','它','在','是','有','就','都','还','也','很','太','真','没','别','会','能','要','想','看','说','什么','怎么','为什么','这个','那个','一个','没有','还是','不是','可以','我们','你们','他们','现在','真的','是不是','有没有','算了','吧唧','霍霍','哇','吼吼','嘻嘻','哈哈','呵呵','确实','知道','觉得','感觉','时候','东西','事情','问题','地方','今天','明天','昨天','晚上','白天','上次','到底','现在','不是','就是','一个','怎么','知道','我们','可以','东西','觉得','没有','这样','这么','不会','自己','还是','但是','一样','那个','因为','他们','这些','为什么','应该','不过','是不是','肯定','确实','真的','时候','大家','可能','这种','以前','一下','出来','其实','然后','发现','很多','已经','那些','还有','一直','感觉','如果','需要','主要','一定','正常','虽然','不行','只能','所以','一点','不了','只是','只有','看看','好像','那么','而且','认为','两个','差不多','反正','有点','之前','以为','为了','完全','不要','导致','根本','结果','时间','那种','估计','记得','起来','可惜','最后','意思','不想','我要','的话','全是','后面','不如','今天','特别','地方','事情','里面','容易','一般','而已','怎么样','当时','只要'])

function extractKeywords(text){
  const words = jieba.cut(text, false)
  const out=[]
  for(const w of words){
    const t=w.trim().toLowerCase()
    if(t.length<2)continue
    if(/^[\d\s.,!?/\\|_:\-"'()\[\]{}]+$/.test(t))continue
    if(STOP_WORDS.has(t))continue
    if(!out.includes(t))out.push(t)
  }
  return out.slice(0,6)
}

function testLike(query){
  const kws = extractKeywords(query)
  if(!kws.length){console.log(`「${query}」→ 关键词为 0（全被停用词滤掉）`);return}
  const likes = kws.map(k=>`text LIKE '%${k}%'`)
  const scores = kws.map(k=>`(text LIKE '%${k}%')`)
  const rows = db.prepare(`SELECT chunk_id,date,text,(${scores.join(' + ')}) AS score FROM chunks WHERE ${likes.join(' OR ')} ORDER BY score DESC, RANDOM() LIMIT 3`).all()
  console.log(`\n── query「${query}」→ jieba 抽词: [${kws.join(', ')}]`)
  console.log(`   like 命中 ${rows.length} 条：`)
  for(const r of rows){
    const lines=r.text.split('\n').filter(l=>l.trim()).slice(0,4)
    console.log(`   [score=${r.score}] (${r.date}) ${lines.join(' / ').slice(0,80)}`)
  }
  // 额外：看每个关键词全表命中多少条
  console.log(`   关键词全表命中量：`)
  for(const k of kws){
    const c=db.prepare(`SELECT count(*) n FROM chunks WHERE text LIKE ?`).get('%'+k+'%')
    console.log(`     '${k}' → ${c.n} 条`)
  }
}

for(const q of ['电脑又蓝屏了 烦死','天天加班 好累','机械键盘 茶轴 声音大','上次说买耳机 买了没','周末有安排没']) testLike(q)
