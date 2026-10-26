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
    maxTokens: Number(process.env.LLM_MAX_TOKENS) || 1024,
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
    maxHistory: Number(process.env.MAX_HISTORY) || 20,
    replyCooldown: Number(process.env.REPLY_COOLDOWN) || 25_000,
    respondMode: process.env.RESPOND_MODE || 'auto', // "auto" | "mention"
    // 私聊独立策略：攒批条数/时间（默认1条即回，秒回）
    privateBatchN: Number(process.env.PRIVATE_BATCH_N) || 1,
    privateBatchT: Number(process.env.PRIVATE_BATCH_T) || 30_000,
    privateReplyCooldown: Number(process.env.PRIVATE_REPLY_COOLDOWN) || 10_000,
    // 群聊回复概率 0~1（1=必回，0.5=50%概率沉默，模拟真人不想理）
    groupReplyProb: Number(process.env.GROUP_REPLY_PROB) || 1.0,
    // 私聊回复概率
    privateReplyProb: Number(process.env.PRIVATE_REPLY_PROB) || 1.0,
    // 调整后 min(max(x,0),1)
    // 主动说话：某个场景沉寂 minGapMs 后主动冒泡（0=关闭）
    proactiveGapMs: Number(process.env.PROACTIVE_GAP_MS) || 0,
    // 夜间防打扰 [hh:mm–hh:mm] 不响（空串=关闭）
    quietHours: process.env.QUIET_HOURS || '',
    // 只处理白名单（空=全部；格式逗号分隔，g:群号 / p:QQ号 或裸群号）
    allowScenes: (process.env.ALLOW_SCENES || '').split(',').map(s => s.trim()).filter(Boolean),
    // 黑名单（同格式；白名单优先）
    denyScenes: (process.env.DENY_SCENES || '').split(',').map(s => s.trim()).filter(Boolean),
    // ── 回车分割逐条发送（模拟真人一条条打字发出）──
    // 回复里每个换行(回车)拆成独立一条消息，逐条带间隔发送
    segmentOnNewline: process.env.SEGMENT_ON_NEWLINE !== 'false',
    // 每条消息之间的间隔(ms)（随机在 [min,max] 取，模拟打字节奏）
    segmentGapMinMs: Number(process.env.SEGMENT_GAP_MIN_MS) || 500,
    segmentGapMaxMs: Number(process.env.SEGMENT_GAP_MAX_MS) || 1800,
    // 空行/纯空白行是否也单独成条（默认 false=跳过）
    segmentKeepBlank: process.env.SEGMENT_KEEP_BLANK === 'true',
    // ── 上下文记忆 / 长期记忆（参考 AstrBot ContextManager）──
    // 持久化开关：把每场景对话存 sqlite，重启不丢
    memoryPersist: process.env.MEMORY_PERSIST !== 'false',
    // 上下文最大 token（超过阈值触发 LLM 摘要压缩；0=关闭压缩）
    memoryMaxTokens: Number(process.env.MEMORY_MAX_TOKENS) || 4096,
    // 压缩触发阈值比例（占用超 maxTokens*此比例 触发）
    memoryCompressThreshold: Number(process.env.MEMORY_COMPRESS_THRESHOLD) || 0.82,
    // 压缩后保留最近上下文的比例（精确保留，老的进摘要）
    memoryKeepRecentRatio: Number(process.env.MEMORY_KEEP_RECENT_RATIO) || 0.15,
    // 每次压缩的摘要合并进长期记忆（AstrBot 注入 user 历史摘要对）
    memorySummaryMerging: process.env.MEMORY_SUMMARY_MERGING !== 'false',
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