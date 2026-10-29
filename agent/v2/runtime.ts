import { config } from '../config.js'
import { callLlmWithProviders, callLlmWithTools, type ChatMessage } from '../llm.js'
import { buildSystemPrompt } from '../prompt.js'
import { tooSimilar, pushRecent } from '../antirepeat.js'
import { limitProfanity } from '../profanity.js'
import { applyStyle, sampleReactMs, splitLongSegment, type StyleBias } from '../profile.js'
import { loadDialog, saveDialog, shouldCompress, compressDialog, countMessagesTokens } from '../memory.js'
import { computeModifiers, loadState, buildStatePrompt, type StateModifiers } from '../state.js'
import { createToolRegistry, type SendMessageFn } from './tools.js'
import { addToolTrace, appendEvent, createRun, finishRun } from './store.js'
import {
  threadKey,
  type InboundMessage, type RunRecord, type ThreadRef, type TurnRequest, type V2Event,
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
    echoProb: clamp01(st.echoProb * mods.echo),
    maxChars: st.maxChars > 0 ? Math.max(20, Math.round(st.maxChars * mods.styleLength)) : 0,
  }
}

export class AgentRuntime {
  private recentReplies = new Map<string, string[]>()
  private lastReplyAt = new Map<string, number>()
  private chains = new Map<string, Promise<void>>()

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
    let tokensIn = 0
    let tokensOut = 0
    let cost = 0

    try {
      const ctx = req.messages.map(m => `${m.senderNick}: ${m.text}`).join('\n')
      const triggerNick = req.trigger.triggerNick || req.messages[req.messages.length - 1]?.senderNick || ''
      const { dialog, summary } = loadDialog(key)
      let hist = dialog
      if (summary && dialog.length && dialog[0]?.role !== 'user') {
        hist = [
          { role: 'user', content: `我们之前的对话摘要：${summary}`, time: Date.now() },
          { role: 'assistant', content: '（收到，继续聊）', time: Date.now() },
          ...dialog,
        ]
      }
      hist = hist.slice(-config.agent.maxHistory)

      const recent = this.recentReplies.get(key) ?? []
      const ar = config.humanlike.antiRepeat

      const scopeLine = thread.kind === 'group' && triggerNick
        ? `（这一轮群里有好几个人在说话，你只回应 ${triggerNick} 说的这条，其他人先别管）`
        : ''
      const scopeMsg: ChatMessage | null = scopeLine
        ? { role: 'system', content: scopeLine, time: Date.now() }
        : null
      const userMsg: ChatMessage = { role: 'user', content: ctx, time: Date.now() }

      const mods = thread.channel === 'qq' && config.humanlike.recentState.enabled
        ? computeModifiers(loadState())
        : undefined

      if (thread.channel === 'sim') {
        await sleep(randInt(config.sim.reactMsMin, config.sim.reactMsMax))
      } else {
        await sleep(Math.max(1000, Math.round(sampleReactMs() * (mods?.reactDelay ?? 1))))
      }

      const messages: ChatMessage[] = [
        { role: 'system', content: buildSystemPrompt(thread.kind) },
        ...hist,
        ...(scopeMsg ? [scopeMsg] : []),
        userMsg,
      ]

      const tools = createToolRegistry(
        thread,
        thread.channel === 'qq' && config.agent.getStateEnabled
          ? () => buildStatePrompt(loadState())
          : undefined,
      )
      const onToolStart = (info: { name: string; args: Record<string, unknown>; startedAt: number }): void => {
        const callId = `${runId}:${info.name}:${info.startedAt}`
        this.emit({
          type: 'tool.started', thread: key, runId, callId,
          name: info.name, args: info.args, at: info.startedAt,
        })
      }
      const onTool = (info: {
        name: string; args: Record<string, unknown>; result: string
        status: 'ok' | 'error'; durationMs: number; startedAt: number
      }): void => {
        const callId = `${runId}:${info.name}:${info.startedAt}`
        addToolTrace({
          id: callId, runId, name: info.name, args: info.args,
          result: info.result, status: info.status,
          startedAt: info.startedAt, durationMs: info.durationMs,
        })
        this.emit({
          type: 'tool.finished', thread: key, runId, callId,
          name: info.name, result: info.result, status: info.status,
          durationMs: info.durationMs, at: info.startedAt + info.durationMs,
        })
      }

      const llm = config.rag.toolsEnabled
        ? await callLlmWithTools(messages, {
            tools: tools.specs,
            executors: tools.executors,
            maxIter: config.rag.toolMaxIter,
            onToolStart,
            onTool,
          })
        : await callLlmWithProviders(messages)
      providerId = llm.providerId
      toolCalls = llm.toolCalls ?? 0
      tokensIn = llm.tokensIn ?? 0
      tokensOut = llm.tokensOut ?? 0
      cost = llm.cost ?? 0
      let raw = llm.text
      // 模型没调 reply 也没输出内容 → 强制补一句。回不回由外部系统决定；走到这步就是"决定回"。
      if (!raw && !tools.context.sentByTool) {
        const fb = await callLlmWithProviders(messages)
        raw = fb.text
      }
      if (!raw && !tools.context.sentByTool) {
        console.log(`[V2] ${key} 无输出（模型未生成）`)
        status = 'skipped'
        return rec
      }

      reply = stripSelfPrefix(applyStyle(raw, ctx, styleBias(mods)))
      if (config.humanlike.profanity.hardBlock) {
        const cleaned = limitProfanity(reply, config.humanlike.profanity.replace)
        if (cleaned !== reply) {
          console.log('[V2] 重级脏话拦截')
          reply = cleaned
        }
      }

      if (ar.enabled && reply && tooSimilar(reply, recent, ar.dropSim)) {
        console.log(`[V2] ${key} 回复与近期过于相似，跳过`)
        status = 'skipped'
        return rec
      }

      const finalReply = tools.context.sentByTool
        ? tools.context.sentTexts.join('\n')
        : reply
      reply = finalReply
      if (!finalReply) {
        status = 'skipped'
        return rec
      }

      const segments = await this.sendSegments(thread, finalReply, runId)

      this.emit({
        type: 'assistant.message', thread: key, runId,
        text: finalReply, segments, at: Date.now(),
      })
      console.log(`[V2] 回复 ${key}: ${finalReply}`)

      const assistantMsg: ChatMessage = { role: 'assistant', content: finalReply, time: Date.now() }
      const updated: ChatMessage[] = [...hist, userMsg, assistantMsg].slice(-config.agent.maxHistory)
      await this.persist(key, updated)
      this.recentReplies.set(key, pushRecent(recent, finalReply, ar.window))
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
      finishRun(rec)
      this.emit({
        type: 'run.finished', thread: key, runId, status,
        reply: rec.reply, error, at: rec.endedAt,
      })
      this.emit({ type: 'thread.updated', thread: key, at: rec.endedAt })
    }
  }

  private async sendSegments(thread: ThreadRef, reply: string, runId: string): Promise<string[]> {
    const ty = config.humanlike.typing
    let segments = ty.onNewline
      ? reply.split('\n').map(s => s.trimEnd())
      : [reply]
    const maxSegChars = config.humanlike.style.maxSegmentChars
    if (maxSegChars > 0) segments = segments.flatMap(s => splitLongSegment(s, maxSegChars))
    const maxSeg = ty.maxSegments > 0 ? Math.max(1, ty.maxSegments) : 0
    if (maxSeg > 0 && segments.length > maxSeg) {
      const head = segments.slice(0, maxSeg - 1)
      const tail = segments.slice(maxSeg - 1).filter(s => s.trim() !== '')
      segments = [...head, tail.join('\n')]
    }
    const kept = segments.filter(s => ty.keepBlank || s.trim() !== '')
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
