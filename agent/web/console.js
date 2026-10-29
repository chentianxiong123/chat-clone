/* chat-clone v2 console */
const $ = (id) => document.getElementById(id)
const S = {
  threads: [],
  active: null,
  detail: null,
  events: [],
  live: new Map(),
  selectedRun: null,
  tab: 'runs',
  sending: false,
  status: null,
  snapshot: null,
  newKind: 'group',
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]))
const fmtTime = (t) => {
  if (!t) return ''
  const d = new Date(t)
  return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}
const fmtDur = (ms) => {
  if (ms === undefined || ms === null) return ''
  if (ms < 1000) return `${Math.round(ms)} 毫秒`
  return `${(ms / 1000).toFixed(1)} 秒`
}
const short = (s, n = 80) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n) + '…' : t
}
const fmtNum = (n) => Number(n || 0).toLocaleString('zh-CN')
const tokenLine = (tokensIn, tokensOut, cost) => {
  if (!tokensIn && !tokensOut) return ''
  return `Token ${fmtNum(tokensIn)} 输入 / ${fmtNum(tokensOut)} 输出${cost ? ` · ￥${Number(cost).toFixed(4)}` : ''}`
}
const personaName = () => S.status?.persona?.name || 'Agent'

async function api(path, opts) {
  const r = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`)
  return j
}

async function boot() {
  try { S.status = await api('/api/status') } catch { /* ignore */ }
  await loadThreads()
  const firstReal = S.threads.find(t => t.channel === 'qq' && !t.archived)
  const first = firstReal
    || S.threads.find(t => t.channel === 'sim' && !t.archived)
    || S.threads.find(t => t.channel === 'sim')
    || S.threads[0]
  if (first) {
    await openThread(first.id)
  } else {
    await newSimGroup(undefined, true)
  }
  connectSSE()
}

async function loadThreads() {
  try {
    const j = await api('/api/v2/threads')
    S.threads = j.threads || []
    S.snapshot = j.snapshot || S.snapshot
    renderThreads()
  } catch (e) {
    console.warn('loadThreads', e)
  }
}

function threadLabel(t) {
  if (t.channel === 'qq') return `真群 ${t.externalId}`
  return `${t.kind === 'group' ? '模拟群' : '模拟私聊'} ${t.externalId}`
}

function threadBadge(t) {
  return [t.archived ? '已归档' : ''].filter(Boolean).join(' · ')
}

function threadRow(t) {
  const btn = document.createElement('button')
  btn.className = `w-full text-left rounded-xl border px-3 py-2.5 transition ${t.id === S.active ? 'thread-active' : 'border-transparent hover:bg-white/5'} ${t.archived ? 'thread-archived' : ''}`
  btn.onclick = () => openThread(t.id)
  btn.innerHTML = `
    <div class="flex items-center gap-2">
      <span class="h-7 w-7 shrink-0 rounded-lg grid place-items-center text-[10px] font-bold ${t.channel === 'qq' ? 'bg-indigo-500/20 text-indigo-300' : 'bg-white/5 text-slate-300'}">${t.channel === 'qq' ? '真' : (t.kind === 'group' ? '群' : '私')}</span>
      <span class="min-w-0 flex-1">
        <span class="flex items-center gap-1.5">
          <span class="text-[12px] font-medium truncate ${t.channel === 'qq' ? 'text-indigo-200' : 'text-slate-200'}">${esc(threadLabel(t))}</span>
          ${t.archived ? '<span class="pill bg-white/5 text-slate-500">归档</span>' : ''}
          ${t.paused ? '<span class="pill bg-amber-500/15 text-amber-300">暂停</span>' : ''}
        </span>
        <span class="block text-[10px] text-slate-500 truncate mt-0.5">${esc(short(t.lastPreview || '（暂无消息）', 42))}</span>
      </span>
      <span class="shrink-0 text-right">
        <span class="block text-[9px] text-slate-600">${fmtTime(t.lastMessageAt)}</span>
        ${t.unread ? `<span class="mt-1 inline-block min-w-4 h-4 px-1 rounded-full bg-indigo-500 text-white text-[9px] leading-4 text-center">${t.unread > 99 ? '99+' : t.unread}</span>` : ''}
      </span>
    </div>`
  return btn
}

function sectionHead(label, cls) {
  const div = document.createElement('div')
  div.className = `px-2 pt-3 pb-1 text-[10px] uppercase tracking-widest font-semibold ${cls}`
  div.textContent = label
  return div
}

function renderThreads() {
  const box = $('threads')
  box.innerHTML = ''
  if (!S.threads.length) {
    box.innerHTML = `<div class="p-3 text-[11px] text-slate-600">还没有会话，点上方新建。</div>`
    return
  }
  const real = S.threads.filter(t => t.channel === 'qq')
  const sims = S.threads.filter(t => t.channel === 'sim')
  const arch = S.threads.filter(t => t.archived)
  // 真群分区
  if (real.length) {
    box.appendChild(sectionHead('真群', 'text-indigo-400'))
    for (const t of real) box.appendChild(threadRow(t))
  }
  // 模拟群分区（未归档）
  if (sims.some(t => !t.archived)) {
    box.appendChild(sectionHead('模拟群', 'text-slate-500'))
    for (const t of sims) if (!t.archived) box.appendChild(threadRow(t))
  }
  // 已归档分区
  if (arch.length) {
    box.appendChild(sectionHead('已归档', 'text-slate-600'))
    for (const t of arch) box.appendChild(threadRow(t))
  }
}

async function openThread(id) {
  try {
    const j = await api(`/api/v2/thread/${encodeURIComponent(id)}`)
    S.active = id
    S.detail = j
    S.events = []
    S.live.clear()
    S.selectedRun = j.runs?.[0]?.id || null
    renderThreads()
    renderHeader()
    renderMessages()
    renderInspector()
    await loadThreads()
  } catch (e) {
    console.warn('openThread', e)
    alert(e.message)
  }
}

function renderHeader() {
  const t = S.detail?.meta
  const title = $('thread-title')
  const badge = $('thread-badge')
  const sub = $('thread-sub')
  const paused = $('thread-paused')
  const trigger = $('trigger')
  const pause = $('pause')
  const archive = $('archive')
  const composer = $('composer')
  const send = $('send')
  const sender = $('sender')
  const atBot = $('at-bot')
  const policy = $('policy')
  if (!t) {
    title.textContent = '选择一个会话'
    badge.classList.add('hidden')
    paused.classList.add('hidden')
    sub.textContent = ''
    for (const b of [trigger, pause, archive, send, composer, sender, atBot, policy]) b.disabled = true
    return
  }
  title.textContent = threadLabel(t)
  const badgeText = threadBadge(t)
  badge.textContent = badgeText
  badge.className = 'pill bg-white/5 text-slate-400 border border-white/10'
  badge.classList.toggle('hidden', !badgeText)
  paused.classList.toggle('hidden', !t.paused)
  sub.textContent = ''
  const writable = !t.archived
  for (const b of [trigger, pause, send, composer, sender, atBot, policy]) b.disabled = !writable
  archive.disabled = false
  archive.textContent = t.archived ? '恢复' : '归档'
  pause.textContent = t.paused ? '恢复' : '暂停'
  updateHint()
}

function updateHint() {
  const t = S.detail?.meta
  if (!t) return
  const writable = !t.archived
  const policy = $('policy')?.checked
  const b = S.snapshot?.batch
  const hint = $('composer-hint')
  if (!writable || !policy) {
    hint.textContent = ''
    hint.classList.add('hidden')
    return
  }
  hint.textContent = `攒够 ${b ? `${b.nMin}~${b.nMax}` : 'N'} 条 / 静默 ${b ? Math.round(b.t / 1000) : 'T'} 秒触发`
  hint.classList.remove('hidden')
}

function cleanUserContent(content) {
  return String(content || '')
    .split('\n')
    .filter(l => !l.startsWith('（这一轮群里有好几个人') && !/^[^：:\n]{1,20}：\s*$/.test(l.trim()))
    .join('\n')
}

function parseUserLine(line) {
  const m = line.match(/^([^：:\n]{1,24})[：:]\s+(.+)$/s)
  if (m) return { nick: m[1].trim(), text: m[2].trim() }
  return { nick: '朋友', text: line.trim() }
}

function renderMessages() {
  const box = $('messages')
  box.innerHTML = ''
  const dialog = S.detail?.dialog || []
  if (!dialog.length) {
    box.innerHTML = `<div class="h-full grid place-items-center text-center text-slate-600">
      <div><div class="text-3xl mb-2">💬</div><div class="text-sm">还没有对话</div><div class="text-[11px] mt-1">发一条消息试试</div></div>
    </div>`
    return
  }
  for (const m of dialog) {
    if (m.role === 'user') {
      const lines = cleanUserContent(m.content).split('\n').filter(l => l.trim())
      for (const line of lines) {
        const p = parseUserLine(line)
        appendBubble('user', p.text, { nick: p.nick, time: m.time })
      }
    } else if (m.role === 'assistant') {
      for (const line of String(m.content || '').split('\n')) {
        if (line.trim()) appendBubble('assistant', line.trim(), { nick: personaName(), time: m.time })
      }
    }
  }
  scrollBottom()
}

function appendBubble(role, text, opts = {}) {
  const box = $('messages')
  const wrap = document.createElement('div')
  wrap.className = `flex gap-2 fade-in ${role === 'assistant' ? 'justify-start' : 'justify-end'}`
  if (opts.runId) wrap.dataset.run = opts.runId
  const isAssistant = role === 'assistant'
  const nick = opts.nick || (isAssistant ? personaName() : '朋友')
  const avatar = document.createElement('div')
  avatar.className = `h-8 w-8 shrink-0 rounded-xl grid place-items-center text-[11px] font-bold ${isAssistant ? 'bg-gradient-to-br from-indigo-500 to-fuchsia-500 text-white' : 'bg-white/5 text-slate-300 border border-white/10'}`
  avatar.textContent = String(nick).slice(0, 1).toUpperCase()
  const content = document.createElement('div')
  content.className = `max-w-[min(680px,78%)] ${isAssistant ? 'items-start' : 'items-end'} flex flex-col`
  const meta = document.createElement('div')
  meta.className = 'text-[10px] text-slate-500 mb-1 px-1'
  meta.textContent = `${nick}${opts.time ? ' · ' + fmtTime(opts.time) : ''}`
  const bubble = document.createElement('div')
  bubble.className = `px-3.5 py-2.5 text-[13px] leading-relaxed whitespace-pre-wrap break-words border ${isAssistant ? 'bubble-assistant bg-indigo-500/15 border-indigo-400/20 text-indigo-50' : 'bubble-user bg-white/[0.055] border-white/10 text-slate-200'}`
  bubble.textContent = text
  content.appendChild(meta)
  content.appendChild(bubble)
  if (isAssistant) {
    wrap.appendChild(avatar)
    wrap.appendChild(content)
  } else {
    wrap.appendChild(content)
    wrap.appendChild(avatar)
  }
  box.appendChild(wrap)
  scrollBottom()
}

function scrollBottom() {
  const box = $('messages')
  box.scrollTop = box.scrollHeight
}

function allEvents() {
  const map = new Map()
  for (const e of [...(S.detail?.events || []), ...S.events]) {
    const key = `${e.type}|${e.runId || ''}|${e.callId || ''}|${e.at || ''}`
    map.set(key, e)
  }
  return [...map.values()].sort((a, b) => (a.at || 0) - (b.at || 0))
}

function renderInspector() {
  for (const b of document.querySelectorAll('.insp-tab')) {
    b.classList.toggle('tab-active', b.dataset.tab === S.tab)
  }
  const box = $('inspector')
  if (!S.detail?.meta) {
    box.innerHTML = '<div class="text-slate-600">未选择会话</div>'
    return
  }
  if (S.tab === 'runs') return renderRuns(box)
  if (S.tab === 'tools') return renderTools(box)
  return renderContext(box)
}

const RUN_STATUS = { ok: '已回复', skipped: '已跳过', error: '失败' }
const RUN_TRIGGER = { message: '收到消息', mention: '被 @', timer: '定时触发', manual: '手动触发', proactive: '主动发言' }
const TOOL_NAME = { search_past_memory: '检索记忆', remember: '记住信息', send_message: '发送消息' }

function renderRuns(box) {
  const runs = S.detail?.runs || []
  if (!runs.length) {
    box.innerHTML = '<div class="text-slate-600">还没有回复记录。</div>'
    return
  }
  box.innerHTML = ''
  for (const r of runs) {
    const ok = r.status === 'ok'
    const skipped = r.status === 'skipped'
    const div = document.createElement('button')
    div.className = `w-full text-left rounded-xl border p-3 mb-2 transition ${r.id === S.selectedRun ? 'border-indigo-400/40 bg-indigo-500/10' : 'border-white/5 bg-white/[0.02] hover:bg-white/[0.05]'}`
    div.onclick = () => { S.selectedRun = r.id; renderInspector() }
    div.innerHTML = `
      <div class="flex items-center gap-2">
        <span class="pill ${ok ? 'bg-emerald-500/15 text-emerald-300' : skipped ? 'bg-slate-500/15 text-slate-400' : 'bg-red-500/15 text-red-300'}">${RUN_STATUS[r.status] || '完成'}</span>
        <span class="text-[10px] text-slate-500">${RUN_TRIGGER[r.trigger] || '自动触发'}</span>
        <span class="ml-auto text-[10px] text-slate-600">${fmtDur((r.endedAt || r.startedAt) - r.startedAt)}</span>
      </div>
      <div class="mt-1 text-[11px] text-slate-300">${esc(short(r.reply || r.error || '（无文本）', 120))}</div>
      <div class="mt-1 flex items-center gap-2 text-[9px] text-slate-600">
        <span>${fmtTime(r.startedAt)}</span>
        ${tokenLine(r.tokensIn, r.tokensOut, r.cost) ? `<span class="ml-auto">${tokenLine(r.tokensIn, r.tokensOut, r.cost)}</span>` : ''}
      </div>`
    box.appendChild(div)
  }
}

function renderTools(box) {
  const runId = S.selectedRun || S.detail?.runs?.[0]?.id
  const evs = allEvents().filter(e => (!runId || e.runId === runId) && String(e.type).startsWith('tool.'))
  if (!evs.length) {
    box.innerHTML = '<div class="text-slate-600">这一轮没有调用工具。</div>'
    return
  }
  const calls = new Map()
  for (const e of evs) {
    const id = e.callId || `${e.runId}:${e.name}`
    const c = calls.get(id) || { name: e.name, status: '', durationMs: null }
    if (e.type === 'tool.started') c.name = e.name
    if (e.type === 'tool.finished') { c.status = e.status; c.durationMs = e.durationMs }
    calls.set(id, c)
  }
  box.innerHTML = ''
  for (const c of calls.values()) {
    const div = document.createElement('div')
    div.className = 'rounded-xl border border-white/5 bg-white/[0.02] p-3 mb-2'
    div.innerHTML = `
      <div class="flex items-center gap-2">
        <span class="text-[11px] font-medium text-indigo-200">${TOOL_NAME[c.name] || '工具调用'}</span>
        <span class="pill ${c.status === 'error' ? 'bg-red-500/15 text-red-300' : 'bg-emerald-500/15 text-emerald-300'}">${c.status === 'error' ? '失败' : c.status === 'ok' ? '完成' : '进行中'}</span>
        <span class="ml-auto text-[9px] text-slate-600">${fmtDur(c.durationMs)}</span>
      </div>`
    box.appendChild(div)
  }
}

function renderContext(box) {
  const t = S.detail.meta
  const d = S.detail
  const provider = String(S.status?.llm?.provider || '')
  const providerName = provider.replace(/\s*\(.*?\)\s*/g, '').trim()
  const model = /agnes/i.test(provider) ? 'Agnes 2.5（本地）' : (providerName || S.status?.llm?.model || '未知模型')
  const totalIn = (d.runs || []).reduce((n, r) => n + Number(r.tokensIn || 0), 0)
  const totalOut = (d.runs || []).reduce((n, r) => n + Number(r.tokensOut || 0), 0)
  const totalCost = (d.runs || []).reduce((n, r) => n + Number(r.cost || 0), 0)
  const totalTokens = tokenLine(totalIn, totalOut, totalCost)
  box.innerHTML = `
    <div class="rounded-xl border border-white/5 bg-white/[0.02] p-3">
      <div class="text-[10px] text-slate-500">会话</div>
      <div class="mt-1 text-[12px] text-slate-200">${esc(threadLabel(t))}</div>
      <div class="mt-2 grid grid-cols-2 gap-2 text-[10px]">
        <div><span class="text-slate-600">消息</span><div class="text-slate-300">${d.dialog?.length || 0} 条</div></div>
        <div><span class="text-slate-600">未读</span><div class="text-slate-300">${t.unread} 条</div></div>
      </div>
      ${totalTokens ? `<div class="mt-2 text-[10px] text-slate-500">${esc(totalTokens)}</div>` : ''}
    </div>
    <div class="mt-2 rounded-xl border border-white/5 bg-white/[0.02] p-3">
      <div class="text-[10px] text-slate-500">模型</div>
      <div class="mt-1 text-[11px] text-slate-300">${esc(model)}</div>
    </div>
    ${d.summary ? `<div class="mt-2 rounded-xl border border-white/5 bg-white/[0.02] p-3"><div class="text-[10px] text-slate-500">历史摘要</div><div class="mt-1 text-[10px] text-slate-400 whitespace-pre-wrap">${esc(d.summary)}</div></div>` : ''}`
}

async function refreshInspector() {
  if (!S.active) return
  try {
    const j = await api(`/api/v2/thread/${encodeURIComponent(S.active)}`)
    if (j.meta) {
      S.detail.runs = j.runs || S.detail.runs
      S.detail.events = j.events || S.detail.events
      S.detail.summary = j.summary ?? S.detail.summary
      renderHeader()
      renderInspector()
    }
  } catch { /* ignore */ }
}

async function send() {
  if (!S.active || S.sending) return
  const t = S.detail?.meta
  if (!t || t.archived) return
  const text = $('composer').value.trim()
  if (!text) return
  S.sending = true
  $('send').disabled = true
  $('composer').value = ''
  const atBot = $('at-bot').checked
  const policy = $('policy').checked
  try {
    await api(`/api/v2/thread/${encodeURIComponent(S.active)}/message`, {
      method: 'POST',
      body: JSON.stringify({
        text,
        senderNick: $('sender').value.trim() || '测试员',
        atBot,
        policy,
      }),
    })
    await openThread(S.active)
  } catch (e) {
    alert(e.message)
  } finally {
    S.sending = false
    $('send').disabled = false
    $('composer').focus()
  }
}

async function newSimThread(kind, id, silent = false) {
  try {
    const j = await api('/api/v2/threads/sim', {
      method: 'POST',
      body: JSON.stringify({ kind, id }),
    })
    await loadThreads()
    await openThread(j.thread.id)
    return true
  } catch (e) {
    if (!silent) alert(e.message)
    return false
  }
}

async function newSimGroup(id, silent) {
  return newSimThread('group', id, silent)
}

function setNewKind(kind) {
  S.newKind = kind
  for (const b of document.querySelectorAll('.new-kind')) {
    b.classList.toggle('kind-active', b.dataset.kind === kind)
  }
  const id = $('new-id')
  id.value = kind === 'group'
    ? String(S.snapshot?.sim?.defaultGroup || 900001)
    : '10001'
  id.placeholder = kind === 'group' ? '群号' : '私聊号'
  $('new-error').textContent = ''
}

function openNewDialog() {
  setNewKind('group')
  $('new-dialog').hidden = false
  $('new-id').focus()
  $('new-id').select()
}

function closeNewDialog() {
  $('new-dialog').hidden = true
}

async function createFromDialog() {
  const id = Number($('new-id').value.trim())
  if (!Number.isInteger(id) || id <= 0) {
    $('new-error').textContent = '请输入有效号码。'
    return
  }
  if (S.newKind === 'group') {
    const min = S.snapshot?.sim?.groupMin ?? 900000
    const max = S.snapshot?.sim?.groupMax ?? 999999
    if (id < min || id > max) {
      $('new-error').textContent = `群号需在 ${min}–${max}。`
      return
    }
  }
  $('new-error').textContent = ''
  if (await newSimThread(S.newKind, id)) closeNewDialog()
}

async function trigger() {
  const t = S.detail?.meta
  if (!S.active || t?.archived) return
  try {
    await api(`/api/v2/thread/${encodeURIComponent(S.active)}/trigger`, { method: 'POST', body: '{}' })
    await openThread(S.active)
  } catch (e) { alert(e.message) }
}

async function togglePause() {
  const t = S.detail?.meta
  if (!t || t.archived) return
  try {
    await api(`/api/v2/thread/${encodeURIComponent(S.active)}/pause`, {
      method: 'POST',
      body: JSON.stringify({ paused: !t.paused }),
    })
    await openThread(S.active)
  } catch (e) { alert(e.message) }
}

async function toggleArchive() {
  const t = S.detail?.meta
  if (!t) return
  try {
    await api(`/api/v2/thread/${encodeURIComponent(S.active)}/archive`, {
      method: 'POST',
      body: JSON.stringify({ archived: !t.archived }),
    })
    await openThread(S.active)
  } catch (e) { alert(e.message) }
}

function connectSSE() {
  const es = new EventSource('/api/v2/stream')
  es.onmessage = (m) => {
    let ev
    try { ev = JSON.parse(m.data) } catch { return }
    handleEvent(ev)
  }
  es.onerror = () => {
    // EventSource 会自动重连
  }
}

function handleEvent(ev) {
  if (ev.type === 'hello') {
    S.snapshot = ev.snapshot || S.snapshot
    return
  }
  if (ev.type === 'thread.updated' || ev.type === 'run.finished') {
    loadThreads()
  }
  if (ev.thread && ev.thread !== S.active) {
    if (ev.type === 'message.received') loadThreads()
    return
  }

  if (ev.type === 'message.received') {
    const msg = ev.message
    if (msg) appendBubble('user', msg.text, { nick: msg.senderNick, time: ev.at })
    loadThreads()
    return
  }
  if (ev.type === 'run.started') {
    $('typing').classList.remove('hidden')
    S.selectedRun = ev.runId
    S.events.push(ev)
    renderInspector()
    return
  }
  if (ev.type === 'assistant.segment') {
    const arr = S.live.get(ev.runId) || []
    arr.push(ev.text)
    S.live.set(ev.runId, arr)
    appendBubble('assistant', ev.text, { nick: personaName(), time: ev.at, runId: ev.runId })
    return
  }
  if (ev.type === 'assistant.message') {
    const had = S.live.get(ev.runId) || []
    if (!had.length) {
      for (const seg of (ev.segments || [])) {
        if (seg && seg.trim()) appendBubble('assistant', seg, { nick: personaName(), time: ev.at, runId: ev.runId })
      }
    }
    S.live.delete(ev.runId)
    S.events.push(ev)
    renderInspector()
    return
  }
  if (ev.type === 'run.finished') {
    $('typing').classList.add('hidden')
    S.events.push(ev)
    setTimeout(() => refreshInspector(), 120)
    return
  }
  if (ev.type === 'tool.started' || ev.type === 'tool.finished') {
    S.events.push(ev)
    if (S.tab === 'tools') renderInspector()
    return
  }
}

$('send').onclick = send
$('composer').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
})
$('policy').onchange = updateHint
$('new-thread').onclick = openNewDialog
$('new-cancel').onclick = closeNewDialog
$('new-create').onclick = createFromDialog
$('new-id').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); createFromDialog() }
  if (e.key === 'Escape') closeNewDialog()
})
$('new-dialog').addEventListener('click', (e) => {
  if (e.target === $('new-dialog')) closeNewDialog()
})
for (const b of document.querySelectorAll('.new-kind')) {
  b.onclick = () => setNewKind(b.dataset.kind)
}
$('trigger').onclick = trigger
$('pause').onclick = togglePause
$('archive').onclick = toggleArchive
for (const b of document.querySelectorAll('.insp-tab')) {
  b.onclick = () => { S.tab = b.dataset.tab; renderInspector() }
}

// 首页「活跃群」点击 → 跳到聊天页并打开该线程
window.addEventListener('open-thread', (e) => {
  const id = e.detail
  if (id) void openThread(id)
})

boot()
