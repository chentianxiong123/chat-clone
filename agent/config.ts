export const config = {
  napcat: {
    host: process.env.NAPCAT_HOST || '127.0.0.1',
    port: Number(process.env.NAPCAT_PORT) || 3001,
  },
  llm: {
    provider: 'openai',
    baseUrl: process.env.LLM_BASE_URL || 'https://apihub.agnes-ai.com/v1',
    model: process.env.LLM_MODEL || 'agnes-2.0-flash',
    apiKey: process.env.LLM_API_KEY || '',
  },
  rag: {
    dbPath: process.env.RAG_DB_PATH || '/mnt/shared/qwen-chat/workspace/07_rag_embedding/stores/qwen_persona_rag.sqlite',
    embedEndpoint: 'http://127.0.0.1:8081/v1/embeddings',
  },
  persona: {
    name: '本人',
    friendName: '朋友',
  },
}