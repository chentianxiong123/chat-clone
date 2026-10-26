import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildProfileFromStats, type MinedStats } from './profile.js'
import { saveMinedProfile } from './stats.js'

/**
 * 从原始聊天记录（jsonl）挖掘拟人画像，输出 data/profile.json。
 *
 * 用法:
 *   npm run mine
 *   node --env-file=.env --import tsx mine.ts [file1.jsonl file2.jsonl ...]
 *
 * 数据格式（每行）:
 *   {"time":"2022-10-04 11:48:00","sender":"本人","type":"text","text":"..."}
 */

const ROOT = dirname(fileURLToPath(new URL('.', import.meta.url)))
const OUT_FILE = process.env.HL_PROFILE_OUT || join(ROOT, 'data', 'profile.json')
const SELF = process.env.HL_MINE_SELF || '本人'
const DEFAULT_FILES = [
  join(ROOT, 'chat_records/qq_final.jsonl'),
  join(ROOT, 'chat_records/wechat_clean.jsonl'),
]

const BURST_GAP_MS = 30_000
const REPLY_WINDOW_MS = 300_000
const LATENCY_CAP_MS = 600_000

type Msg = { ts: number; self: boolean; text: string }

function parseTime(s: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(s)
  if (!m) return NaN
  return new Date(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    Number(m[6] ?? 0),
  ).getTime()
}

function pct(sorted: number[], p: number): number {
  if (!sorted.length) return 0
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))))
  return sorted[idx]
}

const round2 = (v: number) => Math.round(v * 100) / 100
const median = (arr: number[]) => pct([...arr].sort((a, b) => a - b), 50)

const EMOJI_RE = /\p{Extended_Pictographic}/gu
const VULGAR = ['妈的', '你妈', '傻逼', '傻b', 'nmsl', '尼玛', '操', '草泥马', '滚']

function loadMessages(files: string[]): { msgs: Msg[]; lines: number; skipped: number } {
  const msgs: Msg[] = []
  let lines = 0
  let skipped = 0
  for (const f of files) {
    if (!existsSync(f)) {
      console.warn(`[mine] 跳过不存在的文件: ${f}`)
      continue
    }
    const raw = readFileSync(f, 'utf8')
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      lines++
      let o: { time?: string; sender?: string; type?: string; text?: string }
      try {
        o = JSON.parse(line)
      } catch {
        skipped++
        continue
      }
      if (o.type && o.type !== 'text') {
        skipped++
        continue
      }
      const text = (o.text ?? '').trim()
      const ts = parseTime(o.time ?? '')
      if (!text || !Number.isFinite(ts)) {
        skipped++
        continue
      }
      msgs.push({ ts, self: o.sender === SELF, text })
    }
  }
  msgs.sort((a, b) => a.ts - b.ts)
  return { msgs, lines, skipped }
}

function computeStats(msgs: Msg[]): MinedStats & { sample: Record<string, number> } {
  const selfMsgs = msgs.filter((m) => m.self)
  const selfChars = selfMsgs.map((m) => m.text.length).sort((a, b) => a - b)

  // 连发（burst）：相邻本人消息间隔 <= 60s
  const bursts: Msg[][] = []
  for (const m of msgs) {
    if (!m.self) continue
    const last = bursts[bursts.length - 1]
    if (last && m.ts - last[last.length - 1].ts <= BURST_GAP_MS) last.push(m)
    else bursts.push([m])
  }
  const burstLen = bursts.map((b) => b.length).sort((a, b) => a - b)
  const turnChars = bursts.map((b) => b.reduce((s, m) => s + m.text.length, 0)).sort((a, b) => a - b)

  // 连发内部间隔 & 打字速度
  const gapsSec: number[] = []
  const cps: number[] = []
  for (const b of bursts) {
    for (let i = 1; i < b.length; i++) {
      const gap = (b[i].ts - b[i - 1].ts) / 1000
      if (gap < 0.5 || gap > 60) continue
      gapsSec.push(gap)
      if (gap >= 2 && gap <= 30) cps.push(b[i].text.length / gap)
    }
  }
  gapsSec.sort((a, b) => a - b)

  // 回复延迟：对方消息 → 本人第一条回复
  const latencySec: number[] = []
  let pendingOtherTs: number | null = null
  for (const m of msgs) {
    if (!m.self) {
      pendingOtherTs = m.ts
      continue
    }
    if (pendingOtherTs !== null) {
      const d = m.ts - pendingOtherTs
      if (d >= 0 && d <= LATENCY_CAP_MS) latencySec.push(d / 1000)
      pendingOtherTs = null
    }
  }
  latencySec.sort((a, b) => a - b)

  // 对方一轮（连发合并）是否在 5 分钟内被回复
  let otherBursts = 0
  let repliedBursts = 0
  for (let i = 0; i < msgs.length; i++) {
    if (msgs[i].self) continue
    let j = i
    while (j + 1 < msgs.length && !msgs[j + 1].self && msgs[j + 1].ts - msgs[j].ts <= BURST_GAP_MS) j++
    otherBursts++
    const endTs = msgs[j].ts
    let k = j + 1
    while (k < msgs.length && msgs[k].ts - endTs <= REPLY_WINDOW_MS) {
      if (msgs[k].self) {
        repliedBursts++
        break
      }
      k++
    }
    i = j
  }

  // emoji / 短句 / 口头语
  const emojiCount = new Map<string, number>()
  let emojiMsgs = 0
  for (const m of selfMsgs) {
    const found = m.text.match(EMOJI_RE)
    if (!found?.length) continue
    emojiMsgs++
    for (const e of found) emojiCount.set(e, (emojiCount.get(e) ?? 0) + 1)
  }
  const emojis = [...emojiCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([e]) => e)

  const fillerCount = new Map<string, number>()
  let shortMsgs = 0
  for (const m of selfMsgs) {
    const t = m.text.trim()
    if (t.length <= 3) shortMsgs++
    if (t.length < 1 || t.length > 3) continue
    if (/[A-Za-z0-9]/.test(t)) continue
    if (/^[\p{P}\p{S}\s]+$/u.test(t)) continue
    if (VULGAR.some((w) => t.includes(w))) continue
    fillerCount.set(t, (fillerCount.get(t) ?? 0) + 1)
  }
  const fillers = [...fillerCount.entries()]
    .filter(([, n]) => n >= 3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([t]) => t)

  // 24 小时活跃度（按峰值归一化）
  const hourCount = new Array(24).fill(0) as number[]
  for (const m of selfMsgs) hourCount[new Date(m.ts).getHours()]++
  const peak = Math.max(...hourCount, 1)
  const hourRatio = hourCount.map((n) => round2(n / peak))

  const stats: MinedStats = {
    replyLatencySec: {
      p10: round2(pct(latencySec, 10)),
      p50: round2(pct(latencySec, 50)),
      p90: round2(pct(latencySec, 90)),
    },
    selfMsgChars: {
      p50: pct(selfChars, 50),
      p80: pct(selfChars, 80),
      p90: pct(selfChars, 90),
      p95: pct(selfChars, 95),
    },
    turnChars: {
      p50: pct(turnChars, 50),
      p80: pct(turnChars, 80),
      p90: pct(turnChars, 90),
    },
    burstLen: {
      p50: pct(burstLen, 50),
      p80: pct(burstLen, 80),
      p90: pct(burstLen, 90),
    },
    burstGapSec: {
      p25: round2(pct(gapsSec, 25)),
      p50: round2(pct(gapsSec, 50)),
      p75: round2(pct(gapsSec, 75)),
      p90: round2(pct(gapsSec, 90)),
    },
    typingCps: round2(median(cps)),
    emojiRate: round2(selfMsgs.length ? emojiMsgs / selfMsgs.length : 0),
    emojis,
    shortRate: round2(selfMsgs.length ? shortMsgs / selfMsgs.length : 0),
    fillers,
    hourRatio,
    replyRate: round2(otherBursts ? repliedBursts / otherBursts : 0),
    totalText: msgs.length,
    selfText: selfMsgs.length,
  }
  return {
    ...stats,
    sample: {
      totalText: msgs.length,
      selfText: selfMsgs.length,
      bursts: bursts.length,
      otherBursts,
      replyPairs: latencySec.length,
    },
  }
}

function main() {
  const files = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_FILES
  console.log(`[mine] 目标发言人: ${SELF}`)
  console.log(`[mine] 输入: ${files.join(', ')}`)

  const { msgs, lines, skipped } = loadMessages(files)
  console.log(`[mine] 读取 ${lines} 行，有效 ${msgs.length} 条，跳过 ${skipped} 条`)
  if (!msgs.length) {
    console.error('[mine] 没有有效消息，退出')
    process.exit(1)
  }

  const { sample, ...stats } = computeStats(msgs)
  const override = buildProfileFromStats(stats)

  const out = {
    generatedAt: new Date().toISOString(),
    self: SELF,
    files,
    sample,
    stats,
    override,
  }
  const payload = JSON.stringify(out, null, 2) + '\n'
  mkdirSync(dirname(OUT_FILE), { recursive: true })
  writeFileSync(OUT_FILE, payload, 'utf8')
  saveMinedProfile(payload)

  console.log(`[mine] 已写出 ${OUT_FILE}（并写入 stats.db mined_profile）`)
  console.log('[mine] 关键统计:', JSON.stringify({ ...stats, hourRatio: undefined, emojis: stats.emojis.slice(0, 5), fillers: stats.fillers.slice(0, 8) }, null, 2))
  console.log('[mine] 画像覆盖:', JSON.stringify(override, null, 2))
}

main()
