# RAG 搜索校验：没有向量时 fts/like 到底行不行

> 日期：2026-11-07
> 状态：校验完成 + 诊断完成（修复未做）
> 背景：chat-clone 切 pi 内核后，`search_past_memory` 工具靠 RAG（qwen_persona_rag.sqlite）搜本人多年前的真实聊天记录，学说话味道。用户要求校验"没有向量的情况下 RAG 搜索到底行不行"，并让我"硬着头皮搜一下"看 like 路真实缺陷。

## 一、配置现状（.env 实际值）

| 项 | 值 | 影响 |
|---|---|---|
| `RAG_DB_PATH` | workspace/07_rag_embedding/stores/qwen_persona_rag.sqlite | 230MB，17846 条 chunk，2022-10~2026-07 |
| `RAG_STRATEGY` | `vec,fts,like` | 三路都配 |
| `RAG_RECALL_MODE` | `all` | 三路加权归一化合并 |
| `RAG_EMBED_PROVIDER` | **空** | embed 走哪家的 provider 没填 |
| `EMBED_ENDPOINT` | `https://qwen3-embedding...workers.dev/v1/embeddings` | **有值** |
| `RAG_EMBED_ENABLED` | `true` | 向量路开关开 |
| `VEC0_SO` | （sqlite-vec 扩展路径） | `vecLoaded:true` 说明扩展加载成功 |

**关键**：向量路实际是**开着的**（`EMBED_ENDPOINT` 有值 + `embedEnabled:true` + `vec0` 加载成功 + 实测 `usedEmbed:true`）。所以 agent 实测"搜 2~5 次翻到相关"靠的是**向量路**，不是 fts/like。

## 二、三路实测（`ragSearch(query)`）

对 6 个真实聊天 query 跑了 `ragSearch`，打印各路命中：

| query | vec | fts | like | fts 命中内容（前几条） |
|---|---|---|---|---|
| 电脑又蓝屏了 烦死 | 3 | 3 | 3 | "这片土地以后都叫日本"、"我学会你妈呢" |
| 天天加班 好累 | 3 | 3 | 3 | "哇"、"官方认证" |
| 想去看电影 有啥推荐 | 3 | 3 | 3 | "哇"、"好了" |
| 机械键盘 茶轴 声音大 | 3 | 3 | 3 | "没有啤酒味"、"[image]" |
| 上次说买耳机 买了没 | 3 | 3 | 3 | "怎么突然研究起这个了"、"吼吼" |
| 周末有安排没 | 3 | 3 | 3 | "我连羊刀都没有"、"你吗死了" |

**结论：fts/like 两路召回的全是高频口癖词（"哇/吼吼/乐"）或完全无关 chunk，跟实际话题不沾边。** 向量路没打印内容，但 `usedEmbed:true` 说明向量召回是正常的（agent 实测能翻到相关，靠它）。

## 三、like 路硬搜诊断（自己写脚本直连库）

绕过 agent，直接连 RAG 库跑 `searchLike` 逻辑（jieba 抽词 + LIKE + score + RANDOM），看清缺陷：

### 3.1 jieba 把判别词切碎 + 单字过滤

```
「电脑又蓝屏了」→ jieba 切：电脑/又/蓝/屏/了
「机械键盘 茶轴 声音大」→ 机械/键盘/茶/轴/声音/大
「天天加班 好累」→ 天天/加班/好/累
```

rag.ts 的 `extractKeywords` 里有 `t.length < 2 continue`（滤单字），所以：
- "蓝屏"被切成"蓝""屏"单字 → **全滤掉**，判别词丢了
- "茶轴"切成"茶""轴"单字 → **全滤掉**
- "声音大"切成"声音""大" → "大"单字滤掉

**结果：最有判别力的词（蓝屏/茶轴）根本没进检索，剩下的是"电脑""天天"这种高频泛词。**

### 3.2 高频词全表命中量巨大，like 召回全是噪音

```
「电脑蓝屏」抽词：电脑(728条) + 烦死(5条)
「天天加班」抽词：天天(3343条!) + 加班(54条)
「机械键盘」抽词：机械(178) + 键盘(78) + 声音(156)
```

"天天"全表 **3343 条**命中、"电脑" 728 条——LIKE '%天天%' 扫出几千条里随机抽，召回的 chunk 跟"加班"半毛钱关系没有（实测召回"卧槽/乐/跟爸妈看剧"）。

### 3.3 真判别词库里要么极少要么没有

```
蓝屏 → 5 条
茶轴 → 0 条（库里压根没聊过）
周末安排 → 0 条
机械键盘 → 5 条
耳机 → 51 条
加班 → 54 条
```

判别词要么库里没有（茶轴/周末安排），要么就几条（蓝屏 5/机械键盘 5）。**语料本身覆盖不到这些话题**，再好的检索也召不回不存在的旧记录。

### 3.4 `ORDER BY score DESC, RANDOM()` 排序不稳定

like 的 score = 命中几个关键词（大多 =1 或 =2）。同分时 `RANDOM()` 在**同分的不相关 chunk 里随机抽**，相关的不一定浮上来。例「机械键盘」score=2 三条里"为什么机械键盘这么多人用了"（相关）被"鬼/洋文作业"（不相关）挤在一起。

## 四、最终判断

| 场景 | RAG 表现 | 原因 |
|---|---|---|
| **有向量**（现状） | 基本可用 | vec 语义 KNN 能召回到"话题相近"的旧记录（agent 实测搜 2~5 次翻到相关） |
| **没向量**（关掉 vec） | **基本失效** | fts/like 只能召回高频口癖词（哇/吼吼）+ 关键词字面匹配 chunk，跟实际话题相关性极低 |

**没向量时 like 路的 4 个根因**：
1. jieba 把"蓝屏/茶轴"复合词切碎 + 单字过滤，判别词丢了
2. 剩下的高频泛词（电脑/天天）全表命中几千条，LIKE 召回全是噪音
3. 真判别词（蓝屏 5/茶轴 0）库里极少或没有，语料本身覆盖不到
4. 同分 RANDOM 排序让召回不稳定，相关 chunk 不一定浮上来

## 五、当前设计取舍（已做的兜底）

pi-tools.ts 的 search 硬闸门 + `MAX_SEARCHES=8` 防死循环：**搜到相近旧记录→照味道回；搜不到→search 短路 + reply 放行，凭印象回一句（不死搜）**。所以"没向量时 RAG 失效"被兜底了——模型搜不到就凭印象回，不会死循环。

这符合用户决策："搜不到就凭印象回，不一定完全一致，别死搜"。

## 六、修复方案（已落地，A/B 验证过）

用户要求"提升召回质量"，逐个实现并 A/B 验证了 4 个改进（`agent/rag.ts` + `agent/config.ts`，env 可切）：

| # | 改进 | 改法 | 效果（A/B 实测） |
|---|---|---|---|
| ① | **本人短句化** | `assistantOnly`（默认开）：裁剪只取 assistant 行，丢 user 噪音 | "天天加班"改前 user 噪音一大坨（孔乙己包裹/送外卖）→ 改后"我不想加班/加班毫无意义/累死了"纯本人反应 |
| ② | **相关性闸门** | `relevanceGate`（默认 2）：chunk 跟 query bigram 重合 <2 的不要（宁缺毋滥） | "电脑蓝屏"改前错召回"光速学会springboot/日本"→ 改后挡掉，留"我电脑怎么蓝屏了/电脑现在黑屏了"相关片段 |
| ③ | **按相关度排序** | `rerankByRelevance`（默认开）：本人短句按"跟 query bigram 重合"排序，最贴题的优先喂 | 最相关的短句浮到最前，不被随机淹没 |
| ④ | **like 低频词加权** | `likeLowFreqWeight`（默认开）+ `likeLowFreqMax=200`：全表命中<200 条的词权重 3.0，高频词 0.5；jieba 改 `cutForSearch` 保"蓝屏/茶轴"复合词 | 没向量时 like 召回略好（"机械键盘"→"还在用机械/键盘按起来不对劲"），但库里没语料的话题（茶轴 0 条）仍召不回 |

**关键洞察**：召回质量最大的杠杆是 ①"只取本人短句"——chunk 里 user 行是噪音，assistant 行才是"本人的味道"。数据证明"天天加班"top1 chunk 里"我不想加班/加班毫无意义"是金矿，但被 user 杂聊稀释了，① 直接解决。

**残留限制**：库里没语料的话题（茶轴 0 条/周末安排 0 条）再好的排序也召不回，靠 `MAX_SEARCHES` 凭印象回兜底。

## 七、验证脚本（可复现）

`agent/ab-rag.mjs` + `agent/check-rag.mjs`（A/B 校验脚本，留在 agent/ 目录）：

```bash
cd agent
node --env-file=.env --import tsx check-rag.mjs   # ragStatus + 6 query 三路命中
node --env-file=.env --import tsx ab-rag.mjs      # 改后 searchRag 实际喂模型的片段（默认全开）
# 切开关 A/B：RAG_ASSISTANT_ONLY=false / RAG_KEEP_USER_CONTEXT=true / RAG_RELEVANCE_GATE=0 / RAG_LIKE_LOW_FREQ_WEIGHT=false
```
