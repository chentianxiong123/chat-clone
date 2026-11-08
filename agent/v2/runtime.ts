import { config } from '../config.js'
import { type ChatMessage } from '../llm.js'
import { applyStyle, sampleReactMs, replaceMechanismWords, type StyleBias } from '../profile.js'
import { loadDialog, saveDialog, shouldCompress, compressDialog, countMessagesTokens } from '../memory.js'
import { computeModifiers, loadState, buildStatePrompt, type StateModifiers } from '../state.js'
import { PiAgentSession } from '../pi-agent.js'
import { getPiModel, getActiveProvider } from '../pi-provider.js'
import { type SendMessageFn } from './tools.js'
import { appendEvent, createRun, finishRun, addToolTrace } from './store.js'
import { recordUsage, recordGroupReply } from '../stats.js'
import {
  threadKey,
  type InboundMessage, type RunRecord, type ThreadRef, type ToolTrace, type TurnRequest, type V2Event,
} from './types.js'
import type { EventBus } from './bus.js'

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, Math.max(0, ms)))
const randInt = (min: number, max: number): number => {
  if (max <= min) return min
  return min + Math.floor(Math.random() * (max - min + 1))
}
const clamp01 = (x: number): number => Math.min(1, Math.max(0, x))

function stripSelfPrefix(text: string): string {
  const name = config.persona.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return text.replace(new RegExp('^\\s*' + name + '\\s*[：:]\\s*'), '')
}

function styleBias(mods?: StateModifiers): StyleBias | undefined {
  if (!mods || !config.humanlike.recentState.effects.style) return undefined
  const st = config.humanlike.style
  return {
    emojiProb: clamp01(st.emojiProb * mods.emoji),
    fillerProb: clamp01(st.fillerProb * mods.filler),
    typoProb: clamp01(st.typoProb * mods.typo),
    maxChars: st.maxChars > 0 ? Math.max(20, Math.round(st.maxChars * mods.styleLength)) : 0,
  }
}

export class AgentRuntime {
  private lastReplyAt = new Map<string, number>()
  private chains = new Map<string, Promise<void>>()
  private sessions = new Map<string, PiAgentSession>()

  /** 每会话一个 pi session（live 上下文 = pi 内存维护）。key = threadKey(thread) */
  private sessionFor(thread: ThreadRef): PiAgentSession {
    const key = threadKey(thread)
    let s = this.sessions.get(key)
    if (!s) {
      s = new PiAgentSession(
        key,
        thread.kind === 'group' ? 'group' : 'private',
        thread.channel === 'qq' && config.agent.getStateEnabled
          ? () => buildStatePrompt(loadState())
          : undefined,
      )
      this.sessions.set(key, s)
    }
    return s
  }

  /** 清空全部会话内存上下文（live 上下文 = pi 内存，清空即重置；归档不动） */
  clearSessions(): void {
    for (const s of this.sessions.values()) s.reset()
    this.sessions.clear()
  }

  constructor(
    private readonly bus: EventBus,
    private readonly send: SendMessageFn,
  ) {}

  private emit(ev: V2Event): void {
    appendEvent(ev)
    this.bus.emit(ev)
  }

  runTurn(req: TurnRequest): Promise<RunRecord> {
    const key = threadKey(req.thread)
    const prev = this.chains.get(key) ?? Promise.resolve()
    let result: RunRecord | null = null
    const task = prev
      .catch(() => undefined)
      .then(async () => { result = await this._runTurn(req) })
      .finally(() => {
        if (this.chains.get(key) === task) this.chains.delete(key)
      })
    this.chains.set(key, task)
    return task.then(() => result!)
  }

  private async _runTurn(req: TurnRequest): Promise<RunRecord> {
    const thread = req.thread
    const key = threadKey(thread)
    const runId = `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
    const startedAt = Date.now()
    const rec: RunRecord = {
      id: runId,
      threadId: key,
      trigger: req.trigger.reason,
      status: 'running',
      startedAt,
    }
    createRun(rec)
    this.emit({ type: 'run.started', thread: key, runId, trigger: req.trigger.reason, at: startedAt })

    let status: RunRecord['status'] = 'skipped'
    let error: string | undefined
    let reply = ''
    let toolCalls = 0
    let providerId = ''
    try {
      const pm = getPiModel()
      // 优先用 model id（如 agnes-2.5-flash），避免中文 name 进 usage_log.sub 糊桶
      // 用 provider.model（真模型 id，如 agnes-2.5-flash）做 sub，中文 name 进 usage_log 会糊 perModel 桶
      const active = getActiveProvider()
      providerId = active.model || pm.id || pm.name || 'unknown'
    } catch { /* ignore */ }
    let tokensIn = 0
    let tokensOut = 0
    let cost = 0
    let lastToolLog: ToolTrace[] = []

    try {
      const ctx = req.messages.map(m => `${m.senderNick}: ${m.text}`).join('\n')
      const triggerNick = req.trigger.triggerNick || req.messages[req.messages.length - 1]?.senderNick || ''

      const scopeLine = thread.kind === 'group' && triggerNick
        ? `（这一轮群里有好几个人在说话，你只回应 ${triggerNick} 说的这条，其他人先别管）`
        : ''
      const userContent = `${ctx}\n${scopeLine}${config.persona.name}：`

      const mods = thread.channel === 'qq' && config.humanlike.recentState.enabled
        ? computeModifiers(loadState())
        : undefined

      if (thread.channel === 'sim') {
        await sleep(randInt(config.sim.reactMsMin, config.sim.reactMsMax))
      } else {
        await sleep(Math.max(1000, Math.round(sampleReactMs() * (mods?.reactDelay ?? 1))))
      }

      // pi 内核：每会话一个 PiAgentSession，live 上下文 = pi 内存 messages[]
      const session = this.sessionFor(thread)
      const r = await session.runOnce(userContent)

      // 工具关键节点流水（search 搜了什么/门禁拦没拦/reply）→ ToolTrace[]，挂 run.finished 给前端 agent 视图
      const toolLog: ToolTrace[] = (r.toolLog ?? []).map((node, i) => ({
        id: `${runId}_t${i}`,
        runId,
        name: node.name,
        args: node.args ?? {},
        result: node.resultText ?? '',
        status: node.intercepted ? 'intercepted' : (node.isError ? 'error' : 'ok'),
        startedAt: Date.now() - (node.durationMs ?? 0),
        durationMs: node.durationMs ?? 0,
       }))

      lastToolLog = toolLog
      toolCalls = r.segments.length
      tokensIn = r.tokensIn ?? 0
      tokensOut = r.tokensOut ?? 0
      cost = r.cost ?? 0

      // 沉默：模型没调 reply 也没产出 assistant 文本
      if (!r.segments.length) {
        console.log(`[V2] ${key} 无输出（模型沉默/未生成）`)
        status = 'skipped'
        return rec
      }

      // 每条 reply 独立样式，保持"每条一条消息"的工具边界
      const styled = r.segments.map(s => replaceMechanismWords(stripSelfPrefix(applyStyle(s, styleBias(mods)))))
      reply = styled.join('\n')
      if (!reply) {
        status = 'skipped'
        return rec
      }

      const segments = await this.sendSegments(thread, styled, runId)

      this.emit({
        type: 'assistant.message', thread: key, runId,
        text: reply, segments, at: Date.now(),
      })
      console.log(`[V2] 回复 ${key}: ${reply}`)

      // 归档：live 上下文已在 session（pi 内存）；落盘仅作纯归档，永不回灌上下文
      const userMsg: ChatMessage = { role: 'user', content: userContent, time: Date.now() }
      const assistantMsg: ChatMessage = { role: 'assistant', content: r.assistantText || reply, time: Date.now() }
      const archived = [...loadDialog(key).dialog, userMsg, assistantMsg].slice(-config.agent.maxHistory)
      await this.persist(key, archived)
      this.lastReplyAt.set(key, Date.now())
      status = 'ok'
      return rec
    } catch (e) {
      status = 'error'
      error = (e as Error).message
      console.error('[V2] run 错误:', e)
      return rec
    } finally {
      rec.status = status
      rec.endedAt = Date.now()
      rec.model = providerId || undefined
      rec.error = error
      rec.reply = reply || undefined
      rec.toolCalls = toolCalls
      rec.tokensIn = tokensIn
      rec.tokensOut = tokensOut
      rec.cost = cost
      // 工具流水写 tool_calls 表（双视图 LLM 视角数据源，之前 addToolTrace 全仓无人调=空壳）
      for (const t of lastToolLog) {
        addToolTrace({
          id: t.id,
          runId,
          name: t.tool,
          args: t.args,
          result: t.note,
          status: 'ok',
          startedAt: rec.endedAt - (t.ms ?? 0),
          durationMs: t.ms ?? 0,
        })
      }
      finishRun(rec)
      // 写 usage_log（stats.db）——v2 pi 内核自动记 LLM 用量，/api/stats 看板可查
      // skipped（模型主动沉默）算 ok（主动选择，非失败）；只有 error 才算 fail
      const isOk = status === 'ok' || status === 'skipped'
      recordUsage({
        kind: 'llm',
        sub: providerId || 'unknown',
        ok: isOk ? 1 : 0,
        fail: isOk ? 0 : 1,
        cost,
        tokensIn,
        tokensOut,
        ts: rec.endedAt,
        durationMs: rec.endedAt - rec.startedAt,
      })
      this.emit({
        type: 'run.finished', thread: key, runId, status,
        reply: rec.reply, error, toolLog: lastToolLog, at: rec.endedAt,
      })
      this.emit({ type: 'thread.updated', thread: key, at: rec.endedAt })
    }
  }

  private async sendSegments(thread: ThreadRef, segments: string[], runId: string): Promise<string[]> {
    const ty = config.humanlike.typing
    // 工具格式分割：每条 reply = 一条消息，原样发送，程序不再按长度/条数拆分。
    const kept = segments.map(s => s.trimEnd()).filter(s => ty.keepBlank || s.trim() !== '')
    // 真群回复计数（group_stats，sim 不记）
    if (thread.channel === 'qq' && thread.kind === 'group' && thread.externalId && kept.length) {
      recordGroupReply(Number(thread.externalId))
    }
    const total = kept.length
    let i = 0
    for (const seg of kept) {
      i++
      this.emit({
        type: 'assistant.segment', thread: threadKey(thread), runId,
        text: seg, index: i, total, at: Date.now(),
      })
      try { await this.send(thread, seg) } catch (e) {
        console.warn(`[V2] 分段发送失败(跳过): ${(e as Error).message}`)
      }
      if (i < total) {
        const gap = thread.channel === 'sim'
          ? randInt(config.sim.segGapMsMin, config.sim.segGapMsMax)
          : randInt(ty.segGap.minMs, ty.segGap.maxMs)
        await sleep(gap)
      }
    }
    return kept
  }

  private async persist(key: string, dialog: ChatMessage[]): Promise<void> {
    if (!config.agent.memoryPersist) return
    const { summary } = loadDialog(key)
    const maxTokens = config.agent.memoryMaxTokens
    if (maxTokens > 0 && shouldCompress(dialog, maxTokens, config.agent.memoryCompressThreshold)) {
      console.log(`[Memory] ${key} 上下文超限，触发摘要压缩 (${countMessagesTokens(dialog)} tok)`)
      const result = await compressDialog(dialog, summary, maxTokens, config.agent.memoryKeepRecentRatio)
      saveDialog(key, result.dialog, result.summary)
      return
    }
    saveDialog(key, dialog, summary)
  }
}
