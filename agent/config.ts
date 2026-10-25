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
  },
  // ── 消息处理 ──────────────────────────────────────────────────────────────
  batch: {
    n: Number(process.env.BATCH_N) || 5,
    t: Number(process.env.BATCH_T) || 60_000,
  },
  agent: {
    maxHistory: Number(process.env.MAX_HISTORY) || 20,
    replyCooldown: Number(process.env.REPLY_COOLDOWN) || 25_000,
    respondMode: process.env.RESPOND_MODE || 'auto', // "auto" | "mention"
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