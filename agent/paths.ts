import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const AGENT_DIR = dirname(fileURLToPath(import.meta.url))
const PROJECT_DIR = resolve(AGENT_DIR, '..')
const DATA_DIR = process.env.CHAT_DATA_DIR || join(PROJECT_DIR, 'data')

export const paths = {
  agent: AGENT_DIR,
  project: PROJECT_DIR,
  data: DATA_DIR,
  env: join(AGENT_DIR, '.env'),
  web: join(AGENT_DIR, 'web'),
  providers: join(DATA_DIR, 'providers.json'),
} as const
