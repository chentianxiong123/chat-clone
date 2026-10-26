import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadMinedProfile } from './stats.js'

function clamp01(x: number): number { return Math.min(1, Math.max(0, x)) }

/** 读数字环境变量（0 是合法值，不用 || 兜底） */
function envNum(name: string, def: number): number {
  const v = process.env[name]
  if (v === undefined || v === '') return def
  const n = Number(v)
  return Number.isFinite(n) ? n : def
}

/** "0.5,0.7,..." → number[] */
function parseNumList(raw?: string): number[] {
  return (raw || '').split(',').map(s => Number(s.trim())).filter(n => Number.isFinite(n))
}

/** "2000:28,3000:16,..." → [{upToMs,weight}]，按上限升序 */
function parseReactDist(raw?: string): { upToMs: number; weight: number }[] {
  return (raw || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => {
      const [a, b] = s.split(':')
      const upToMs = Number(a)
      const weight = Number(b)
      return Number.isFinite(upToMs) && Number.isFinite(weight) && weight > 0 ? { upToMs, weight } : null
    })
    .filter((x): x is { upToMs: number; weight: number } => !!x)
    .sort((a, b) => a.upToMs - b.upToMs)
}

/** 解析半醒时段："23:00-00:30@0.5,02:00-06:00@0.8" → [{start,end,dormantProb}] */
function parseDrowsy(raw: string): { start: string; end: string; prob: number }[] {
  return raw.split(',').map(s => s.trim()).filter(Boolean).map(s => {
    const m = s.match(/^(\d{1,2}:\d{2})-(\d{1,2}:\d{2})(?:@([\d.]+))?$/)
    if (!m) return null
    return { start: m[1], end: m[2], prob: m[3] ? Math.min(1, Math.max(0, Number(m[3]))) : 0.5 }
  }).filter((x): x is { start: string; end: string; prob: number } => !!x)
}

export const config = {
  // ── NapCat 连接 ───────────────────────────────────────────────────────────
  napcat: {
    host: process.env.NAPCAT_HOST || '127.0.0.1',
    port: Number(process.env.NAPCAT_PORT) || 3001,
  },
  // ── LLM 调用 ──────────────────────────────────────────────────────────────
  llm: {
    provider: process.env.LLM_PROVIDER || 'openai',
    baseUrl: process.env.LLM_BASE_URL || '',
    model: process.env.LLM_MODEL || '',
    apiKey: process.env.LLM_API_KEY || '',
    maxTokens: Number(process.env.LLM_MAX_TOKENS) || 2048,
    temperature: Number(process.env.LLM_TEMPERATURE) || 1.0,
    retryAttempts: Number(process.env.LLM_RETRY_ATTEMPTS) || 3,
    retryDelayMs: Number(process.env.LLM_RETRY_DELAY_MS) || 1000,
    // ── 计费（元/百万token；空则不计量）──
    pricePerMIn: Number(process.env.LLM_PRICE_PER_M_IN) || 0,      // 输入价
    pricePerMOut: Number(process.env.LLM_PRICE_PER_M_OUT) || 0,     // 输出价
  },
  // ── Embedding 计费 ────────────────────────────────────────────────────────
  embed: {
    // 单次调用价格（元/次）；embed 一般按次数或按字符，先按次计
    pricePerCall: Number(process.env.EMBED_PRICE_PER_CALL) || 0,
  },
  // ── RAG 检索 ──────────────────────────────────────────────────────────────
  rag: {
    dbPath: process.env.RAG_DB_PATH || '',
    embedEndpoint: process.env.EMBED_ENDPOINT || '',
    embedApiKey: process.env.EMBED_API_KEY || '',
    embedModel: process.env.EMBED_MODEL || 'qwen3-embedding-0.6b',
    embedProxy: process.env.EMBED_PROXY || '',
    vec0: process.env.VEC0_SO || '',
    topK: Number(process.env.RAG_TOP_K) || 3,
    // 检索策略优先级: "vec" > "fts" > "like" (逗号分隔)
    strategy: (process.env.RAG_STRATEGY || 'vec,fts,like').split(',').map(s => s.trim()),
    // 是否启用 embedding(即使有 endpoint 也可单独关闭)
    embedEnabled: process.env.RAG_EMBED_ENABLED !== 'false',
    // 是否启用 FTS5 (sqlite-vec 不可用时退化为 FTS5+LIKE)
    ftsEnabled: process.env.RAG_FTS_ENABLED !== 'false',
    // LIKE 兜底是否启用
    likeEnabled: process.env.RAG_LIKE_ENABLED !== 'false',
  },
  // ── Persona / 人格 ────────────────────────────────────────────────────────
  persona: {
    name: process.env.PERSONA_NAME || '崽种',
    friendName: process.env.PERSONA_FRIEND || '朋友',
    // 群里被这样的词叫时会被唤醒（逗号分隔，命中即视为 @✓）
    wakeWords: (process.env.PERSONA_WAKE_WORDS || '崽种,qq,机器人').split(',').map(s => s.trim()).filter(Boolean),
    // 系统提示模板({name} / {friend} / {rag} 会被替换)
    systemPromptTemplate: process.env.PERSONA_SYSTEM_PROMPT || `你是{name} 你在群里跟朋友瞎聊

接话规则：
- 别人问"在吗/有人吗/吃了没"这类 → 不回答 直接说自己正在做的事
- 别人征求意见 → 一本正经分析 像专家发表见解
- 别人催你 → 岔开说自己忙的事
- 别人怼你 → 不屑式短回 不解释

回复最多3句 不加标点

{rag}`,
    // Few-shot 示例对话 (可选,每行格式 "user: xxx\nassistant: xxx")
    demoDialogs: process.env.PERSONA_DEMO_DIALOGS || '',
    // 私聊专用 system prompt 模板（不配则用上面通用模板）
    privateSystemPromptTemplate: process.env.PERSONA_PRIVATE_SYSTEM_PROMPT || '',
  },
  // ── 消息处理 / 会话场景 ───────────────────────────────────────────────────
  batch: {
    n: Number(process.env.BATCH_N) || 5,
    t: Number(process.env.BATCH_T) || 60_000,
  },
  agent: {
    maxHistory: Number(process.env.MAX_HISTORY) || 40,
    respondMode: process.env.RESPOND_MODE || 'auto', // "auto" | "mention"
    // 私聊独立策略：攒批条数/时间
    privateBatchN: Number(process.env.PRIVATE_BATCH_N) || 1,
    privateBatchT: Number(process.env.PRIVATE_BATCH_T) || 30_000,
    // 只处理白名单（空=全部；格式逗号分隔，g:群号 / p:QQ号 或裸群号）
    allowScenes: (process.env.ALLOW_SCENES || '').split(',').map(s => s.trim()).filter(Boolean),
    // 黑名单（同格式；白名单优先）
    denyScenes: (process.env.DENY_SCENES || '').split(',').map(s => s.trim()).filter(Boolean),
    // 注意：拟人相关参数（回复概率/冷却/反应/打字/风格/作息）已全部收敛到 humanlike 区块
    // ── 上下文记忆 / 长期记忆（参考 AstrBot ContextManager）──
    // 持久化开关：把每场景对话存 sqlite，重启不丢
    memoryPersist: process.env.MEMORY_PERSIST !== 'false',
    // 上下文最大 token（超过阈值触发 LLM 摘要压缩；0=关闭压缩）
    memoryMaxTokens: Number(process.env.MEMORY_MAX_TOKENS) || 16384,
    // 压缩触发阈值比例（占用超 maxTokens*此比例 触发）
    memoryCompressThreshold: Number(process.env.MEMORY_COMPRESS_THRESHOLD) || 0.82,
    // 压缩后保留最近上下文的比例（精确保留，老的进摘要）
    memoryKeepRecentRatio: Number(process.env.MEMORY_KEEP_RECENT_RATIO) || 0.15,
    // 每次压缩的摘要合并进长期记忆（AstrBot 注入 user 历史摘要对）
    memorySummaryMerging: process.env.MEMORY_SUMMARY_MERGING !== 'false',
  },
  // ── 拟人画像 HumanProfile（A~E 全维度，全部可配置）────────────────────────
  // 目标：每个参数都能从「原始聊天数据」统计得出（见 profile.ts buildProfileFromStats）
  // source: env | auto(先 stats.db 后 profile.json) | db | json
  humanlike: {
    source: process.env.HL_PROFILE_SOURCE || 'env',
    // ── A. 触发应答 —— 回不回 ──
    replyProb: {
      // 群聊被点名+正常消息；被 @/唤醒时必应（不打折扣）
      group: clamp01(Number(process.env.GROUP_REPLY_PROB) || 1.0),
      private: clamp01(Number(process.env.PRIVATE_REPLY_PROB) || 1.0),
      // 对话状态：距上次本人发言越久，越可能不回（数据：热聊99% / 半热74% / 冷47% / 很冷39%）
      state: {
        enabled: process.env.HL_STATE_ENABLED !== 'false',
        applyToPrivate: process.env.HL_STATE_PRIVATE === 'true',
        activeWithinMs: envNum('HL_STATE_ACTIVE_WITHIN_MS', 60_000),
        active: clamp01(envNum('HL_STATE_ACTIVE_PROB', 0.99)),
        semiWithinMs: envNum('HL_STATE_SEMI_WITHIN_MS', 300_000),
        semi: clamp01(envNum('HL_STATE_SEMI_PROB', 0.74)),
        coldWithinMs: envNum('HL_STATE_COLD_WITHIN_MS', 1_800_000),
        cold: clamp01(envNum('HL_STATE_COLD_PROB', 0.47)),
        veryCold: clamp01(envNum('HL_STATE_VERY_COLD_PROB', 0.39)),
      },
      // 分时段乘数（24 个，空=不启用；主要压低早晨 07-09）
      hourly: parseNumList(process.env.HL_REPLY_HOURLY),
      // 对方一次发太多条 → 回复概率打折
      batchPenalty: {
        threshold: envNum('HL_BATCH_PENALTY_FROM', 10),
        factor: clamp01(envNum('HL_BATCH_PENALTY_FACTOR', 0.85)),
      },
    },
    // 太短的敷衍消息直接忽略（如"好的""嗯"），真人常当没看见
    ignoreShort: {
      minChars: Number(process.env.HL_IGNORE_SHORT_MIN_CHARS) || 0, // 低于此长度 视为无意义
      prob: clamp01(Number(process.env.HL_IGNORE_SHORT_PROB) || 0),  // 命中后沉默概率
    },
    // ── B. 反应与节奏 —— 多久回 ──
    react: {
      minMs: Number(process.env.REPLY_REACT_MIN_MS) || 2500,
      maxMs: Number(process.env.REPLY_REACT_MAX_MS) || 8000,
      // 经验延迟分布（按权重采样，空=min~max 均匀）；数据：29% 在2s内、67% 在5s内
      distribution: parseReactDist(process.env.HL_REACT_DIST),
    },
    cooldown: {
      groupMs: Number(process.env.REPLY_COOLDOWN) || 25_000,
      privateMs: Number(process.env.PRIVATE_REPLY_COOLDOWN) || 10_000,
    },
    // 刷屏抑制：窗口内连续回复超 maxReplies 次 → 额外冷却（模拟真人被盯烦了会冷场）
    burst: {
      maxReplies: Number(process.env.HL_BURST_MAX) || 3,
      windowMs: Number(process.env.HL_BURST_WINDOW_MS) || 180_000,
      extraCooldownMs: Number(process.env.HL_BURST_EXTRA_COOLDOWN_MS) || 60_000,
    },
    // ── C. 打字节奏 —— 怎么发 ──
    typing: {
      // 每秒打字字符数（随机区间）→ 单条耗时 = 字数/速度
      charsPerSec: {
        min: Number(process.env.HL_TYPING_CPS_MIN) || 3,
        max: Number(process.env.HL_TYPING_CPS_MAX) || 9,
      },
      // 条间停顿（不含打字本身）
      segGap: {
        minMs: Number(process.env.SEGMENT_GAP_MIN_MS) || 900,
        maxMs: Number(process.env.SEGMENT_GAP_MAX_MS) || 3200,
      },
      // 一次回复最多拆成几条（超出合并），真人不会狂刷几十条
      maxSegments: Number(process.env.HL_MAX_SEGMENTS) || 6,
      // 第一条发出前的短暂迟疑
      firstDelayMs: Number(process.env.SEGMENT_FIRST_DELAY_MS) || 500,
      // 按换行拆分逐条发送
      onNewline: process.env.SEGMENT_ON_NEWLINE !== 'false',
      // 空行是否也单独成条（默认跳过）
      keepBlank: process.env.SEGMENT_KEEP_BLANK === 'true',
    },
    // ── D. 话术风格 —— 说成什么样（LLM 输出后轻量后处理）──
    style: {
      // 回复超长自动收敛（防小作文），超出的在句子边界截断+省略号
      maxChars: Number(process.env.HL_STYLE_MAX_CHARS) || 120,
      // 单条消息字数上限（0=关；超长优先在标点处再拆一条）
      maxSegmentChars: envNum('HL_MAX_SEGMENT_CHARS', 0),
      // 句尾偶发表情
      emojiProb: clamp01(Number(process.env.HL_STYLE_EMOJI_PROB) || 0.15),
      emojis: (process.env.HL_STYLE_EMOJIS || '😂,😅,🤔,😏,🤤,💦').split(',').map(s => s.trim()).filter(Boolean),
      // 语气词/口头禅（开头插入）
      fillerProb: clamp01(Number(process.env.HL_STYLE_FILLER_PROB) || 0.2),
      fillers: (process.env.HL_STYLE_FILLERS || 'emm,啊这,……,2333,离谱').split(',').map(s => s.trim()).filter(Boolean),
      // 偶尔错别字（同音/形近替换）；格式 "对词=错词" 逗号分隔
      typoProb: clamp01(Number(process.env.HL_STYLE_TYPO_PROB) || 0.03),
      typoMap: String(process.env.HL_STYLE_TYPOS || '在=再,吗=嘛,呢=呐,的=得').split(',').map(p => p.trim()).filter(Boolean)
        .map(p => { const [from, to] = p.split('='); return from && to ? { from: from.trim(), to: to.trim() } : null })
        .filter((x): x is { from: string; to: string } => !!x),
      // 偶尔"回敬"对方最后一个词（复读/接话）
      echoProb: clamp01(Number(process.env.HL_STYLE_ECHO_PROB) || 0.08),
    },
    // ── E. 日程节律 —— 什么时候活 ──
    schedule: {
      // 完全静默时段 [hh:mm-hh:mm]（空=关闭）
      quietHours: process.env.QUIET_HOURS || '',
      // 半醒时段：start-end@忽略概率, 多段逗号分隔；如 23:00-00:30@0.5 深夜低活跃
      drowsy: parseDrowsy(process.env.HL_DROWSY || ''),
      // 某场景沉寂超过此间隔则主动冒泡（0=关闭）
      proactiveGapMs: Number(process.env.PROACTIVE_GAP_MS) || 0,
    },
  },
  // ── WebUI ─────────────────────────────────────────────────────────────────
  webui: {
    host: process.env.WEBUI_HOST || '0.0.0.0',
    port: Number(process.env.WEBUI_PORT) || 8085,
  },
  // ── 日志 ──────────────────────────────────────────────────────────────────
  log: {
    level: (process.env.LOG_LEVEL || 'info') as 'debug' | 'info' | 'warn' | 'error',
    maxEntries: Number(process.env.LOG_MAX_ENTRIES) || 2000,
  },
  // ── 用量统计 ──────────────────────────────────────────────────────────────
  stats: {
    windowHours: Number(process.env.STATS_WINDOW_HOURS) || 24,
  },
}

export type Config = typeof config

// ── 数据挖掘画像（data/profile.json）──────────────────────────────────────
// HL_PROFILE_SOURCE=json 强制读取；auto 有则读、无则用 env；env 忽略文件。
const PROFILE_PATH = join(dirname(fileURLToPath(new URL('.', import.meta.url))), 'data', 'profile.json')

export type MinedProfileMeta = {
  /** 实际来源：db=stats.db / json=data/profile.json / 空=未加载 */
  source?: 'db' | 'json'
  generatedAt?: string
  self?: string
  files?: string[]
  sample?: Record<string, number>
  stats?: Record<string, unknown>
}
export let minedProfileMeta: MinedProfileMeta | null = null

function deepMerge(target: Record<string, unknown>, src: unknown): void {
  if (!src || typeof src !== 'object' || Array.isArray(src)) return
  for (const [k, v] of Object.entries(src as Record<string, unknown>)) {
    if (v === undefined) continue
    const cur = target[k]
    if (v && typeof v === 'object' && !Array.isArray(v) && cur && typeof cur === 'object' && !Array.isArray(cur)) {
      deepMerge(cur as Record<string, unknown>, v)
    } else {
      target[k] = v
    }
  }
}

type RawProfile = MinedProfileMeta & { override?: unknown }

function parseProfile(text: string): RawProfile | null {
  try {
    return JSON.parse(text) as RawProfile
  } catch (e) {
    console.warn(`[config] 画像 JSON 解析失败: ${(e as Error).message}`)
    return null
  }
}

const profileSource = config.humanlike.source
let rawProfile: RawProfile | null = null
let loadedFrom: 'db' | 'json' | null = null

// auto: 先库后文件；db: 只读 stats.db；json: 只读文件；env: 全忽略
if (profileSource === 'db' || profileSource === 'auto') {
  const row = loadMinedProfile()
  if (row) {
    rawProfile = parseProfile(row.json)
    if (rawProfile) loadedFrom = 'db'
  }
}
if (!rawProfile && (profileSource === 'json' || profileSource === 'auto')) {
  if (existsSync(PROFILE_PATH)) {
    rawProfile = parseProfile(readFileSync(PROFILE_PATH, 'utf8'))
    if (rawProfile) loadedFrom = 'json'
  } else if (profileSource === 'json') {
    console.warn(`[config] HL_PROFILE_SOURCE=json 但未找到 ${PROFILE_PATH}，回退 env`)
  }
}

if (rawProfile) {
  deepMerge(config.humanlike as unknown as Record<string, unknown>, rawProfile.override ?? rawProfile)
  minedProfileMeta = {
    source: loadedFrom ?? undefined,
    generatedAt: rawProfile.generatedAt,
    self: rawProfile.self,
    files: rawProfile.files,
    sample: rawProfile.sample,
    stats: rawProfile.stats,
  }
}