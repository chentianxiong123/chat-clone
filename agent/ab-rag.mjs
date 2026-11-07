import { searchRag } from './rag.js'
const queries = ['电脑又蓝屏了 烦死', '天天加班 好累', '机械键盘 茶轴 声音大', '周末有安排没']
for (const q of queries) {
  const t = await searchRag(q)
  console.log(`\n════ query「${q}」════`)
  console.log(t || '（空，没召回/全被相关性闸门挡了→会凭印象回）')
}
