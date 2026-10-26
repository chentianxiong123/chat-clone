// ── 工具 ──
const $ = (id) => document.getElementById(id)
const fmtTime = (ts) => (ts ? new Date(ts).toLocaleTimeString('zh-CN', { hour12: false }) : '--')
const fmtSince = (ms) => {
  if (!ms) return '--'
  const s = Math.floor(ms / 1000)
  if (s < 60) return s + 's'
  const m = Math.floor(s / 60)
  if (m < 60) return m + 'm ' + (s % 60) + 's'
  const h = Math.floor(m / 60)
  return h + 'h ' + (m % 60) + 'm'
}
const fmtMs = (ms) => (ms ? (ms >= 1000 ? (ms / 1000).toFixed(1) + 's' : Math.round(ms) + 'ms') : '--')
const fmtNum = (n) => (n == null ? '--' : Number(n).toLocaleString())
const pct = (r) => (r == null ? '--' : (r * 100).toFixed(0) + '%')
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

let currentSnap = null
let ragMeta = null

// ── 导航（AstrBot 式左侧栏）──
document.querySelectorAll('.side-item').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.side-item').forEach((b) => b.classList.remove('active'))
    document.querySelectorAll('.page').forEach((p) => p.classList.remove('active'))
    btn.classList.add('active')
    const page = btn.dataset.page
    $('page-' + page).classList.add('active')
    if (page === 'stats') loadStats(currentRange)
    if (page === 'persona') { loadPersona(); loadMemory() }
    if (page === 'kb') loadKbMeta()
  })
})

// ── SSE 状态流 ──
const evtSource = new EventSource('/api/stream')
evtSource.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.type === 'state') renderState(msg.snap)
  if (msg.type === 'log') appendLog(msg.entry)
})

// ── 问候 ──
function greeting() {
  const h = new Date().getHours()
  if (h < 5) return ['凌晨好', '🌙']
  if (h < 9) return ['早上好', '☀️']
  if (h < 12) return ['上午好', '🌤️']
  if (h < 14) return ['中午好', '🍚']
  if (h < 18) return ['下午好', '☕']
  if (h < 22) return ['晚上好', '🌆']
  return ['夜深了', '🌙']
}

// ── 渲染状态 ──
function renderState(snap) {
  currentSnap = snap
  $('conn-dot').className = 'pulse-dot ' + (snap.connected ? 'live' : 'dead')
  $('conn-text').textContent = snap.connected ? 'NapCat 已连接' : 'NapCat 未连接'

  $('greet').textContent = greeting()[0]
  $('hero-emoji').textContent = greeting()[1]
  $('ov-selfname').textContent = snap.selfName
  $('ov-conn').textContent = snap.connected ? '已连接' : '未连接'
  $('ov-conn-note').textContent = snap.connError || (snap.connected ? 'NapCat 正常' : '未接入 NapCat 适配器')
  if (snap.connError) $('ov-conn').classList.add('text-red-400')
  else $('ov-conn').classList.remove('text-red-400')
  $('ov-groups').textContent = String(Object.keys(snap.groups).length)
  $('ov-last-reply').textContent = fmtTime(snap.lastReplyAt)
  let dialogTotal = 0
  for (const g of Object.values(snap.groups)) dialogTotal += g.dialog.length
  $('ov-dialog').textContent = String(dialogTotal)
  $('ov-batch-n').textContent = snap.batchN
  $('ov-batch-t').textContent = (snap.batchT / 1000).toFixed(0)
  $('ov-cooldown').textContent = snap.cooldownLeftMs > 0 ? fmtSince(snap.cooldownLeftMs) : '就绪'
  $('ov-mode-note').textContent = 'respondMode: ' + snap.respondMode

  const list = $('group-list')
  const groups = Object.values(snap.groups).sort((a, b) => b.lastReplyAt - a.lastReplyAt)
  if (!groups.length) {
    list.innerHTML = `<div class="p-6 text-center text-slate-500 text-sm">还没有群消息，去「聊天」页模拟几条试试</div>`
    return
  }
  list.innerHTML = groups.map((g) => renderGroup(g)).join('')
  bindGroupButtons()
  renderChatFlow()
}

// ── 场景卡片 ──
function batchNFor(g) {
  return g.scene === 'private' ? (currentSnap?.privateBatchN || 1) : (currentSnap?.batchN || 5)
}

function renderGroup(g) {
  const tLeft = g.timerDeadlineAt ? Math.max(0, g.timerDeadlineAt - Date.now()) : null
  const timerBadge = tLeft !== null
    ? `<span class="badge badge-sm badge-warning">攒批中 ${fmtSince(tLeft)}</span>`
    : (g.pending.length ? `<span class="badge badge-sm badge-info">待触发</span>` : ``)
  const bn = batchNFor(g)
  const batchPct = currentSnap ? Math.min(100, Math.round((g.pending.length / bn) * 100)) : 0
  const progressHtml = g.pending.length
    ? `<div class="mt-2">
        <div class="flex items-center justify-between text-[10px] text-slate-500 mb-1">
          <span>攒批进度</span><span class="font-mono">${g.pending.length}/${bn}</span>
        </div>
        <div class="w-full h-1.5 bg-black/40 rounded-full overflow-hidden">
          <div class="h-full bg-gradient-to-r from-indigo-500 to-cyan-400 rounded-full transition-all" style="width:${batchPct}%"></div>
        </div>
      </div>`
    : ``
  const pendingHtml = g.pending.length
    ? `<div class="text-xs text-amber-300/80 mt-1">攒批：
        <span class="font-mono">${esc(g.pending.join(' ').slice(0, 160))}</span></div>`
    : ``
  const sceneBadge = g.scene === 'private'
    ? `<span class="badge badge-sm badge-accent">私聊</span>` : ``
  const dialogHtml = g.dialog.length
    ? `<div class="mt-2 space-y-1">${
        g.dialog.map((m) => `
          <div class="text-xs ${m.role === 'user' ? 'text-sky-300' : 'text-emerald-300'} leading-snug">
            <span class="text-[10px] text-slate-600 font-mono mr-1">${m.time ? fmtTime(m.time) : ''}</span>
            ${m.role === 'user' ? '👤' : '🤖'}${esc(m.content.slice(0, 80))}
          </div>`).join('')
      }</div>
      <div class="text-[10px] text-slate-600 mt-1">记忆 ${g.dialog.length} 条</div>`
    : ``
  return `
  <div class="glass round-2xl p-4" data-key="${g.key}">
    <div class="flex items-center justify-between">
      <div class="flex items-center gap-2">
        <div class="font-mono font-semibold">${g.title}</div>
        ${sceneBadge}
      </div>
      <div class="flex gap-2 items-center">
        ${timerBadge}
        <button class="btn btn-xs btn-ghost text-error act-clear" title="清空该场景记忆">清空</button>
        <button class="btn btn-xs btn-primary act-flush">立即触发</button>
      </div>
    </div>
    ${progressHtml}
    ${pendingHtml}
    ${dialogHtml}
  </div>`
}

function bindGroupButtons() {
  document.querySelectorAll('.act-flush').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const key = btn.closest('[data-key]').dataset.key
      await fetch('/api/flush', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key }) })
    })
  })
  document.querySelectorAll('.act-clear').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const key = btn.closest('[data-key]').dataset.key
      if (!confirm(`清空场景 ${key} 的会话记忆？`)) return
      await fetch('/api/clear', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key }) })
    })
  })
}

$('ov-clear-all').addEventListener('click', async () => {
  if (!confirm('清空所有群的会话记忆？')) return
  await fetch('/api/clear', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) })
})

// ── 聊天流（支持场景选择）──
let chatPickKey = null
function renderChatFlow() {
  if (!currentSnap) return
  const scenes = Object.values(currentSnap.scenes || currentSnap.groups)
  // 同步场景选择器选项
  const pick = $('chat-scene-pick')
  const cur = chatPickKey && scenes.some(s => s.key === chatPickKey) ? chatPickKey : (scenes[0]?.key || null)
  const opts = scenes.map(s => `<option value="${s.key}">${s.title}</option>`).join('')
  if (pick.innerHTML !== opts && pick.innerHTML !== `<option value="">${'-- 无 --'}</option>`) {
    pick.innerHTML = scenes.length ? opts : `<option value="">-- 无 --</option>`
  }
  if (cur) pick.value = cur
  const sc = scenes.find(s => s.key === cur)
  const box = $('chat-flow')
  $('chat-scene-label').textContent = sc ? `· ${sc.title}` : ''
  if (!sc || !sc.dialog.length) {
    box.innerHTML = `<div class="text-center text-slate-600 text-sm py-8">暂无对话，先在下面「模拟消息」注入一条</div>`
    return
  }
  // 消息体：assistant 按换行拆成多条气泡（和真实发送一致：回车分割逐条发）
  const bubbles = (m) => {
    const isBot = m.role !== 'user'
    const lines = isBot ? String(m.content).split('\n') : [m.content]
    const valid = lines.filter((l) => l.trim() !== '').length ? lines : lines
    const header = `<div class="text-[10px] text-slate-500 mb-1">${m.role === 'user' ? '👤 群友' : '🤖 ' + (currentSnap?.selfName || '我')} · ${m.time ? fmtTime(m.time) : ''}</div>`
    const body = valid.map((l) => l.trim() === ''
      ? `<div class="text-[8px] text-slate-700 py-0.5">· · ·</div>`
      : `<div class="whitespace-pre-wrap break-words">${esc(l)}</div>`).join('')
    return `${header}${body}`
  }
  box.innerHTML = sc.dialog.map((m) => `
    <div class="flex ${m.role === 'user' ? 'justify-start' : 'justify-end'}">
      <div class="max-w-[80%] round-xl px-4 py-2 text-sm ${m.role === 'user' ? 'bg-slate-800/70 text-sky-200' : 'bg-indigo-600/50 text-emerald-100'}">
        ${bubbles(m)}
      </div>
    </div>`).join('')
  box.scrollTop = box.scrollHeight
}
$('chat-scene-pick')?.addEventListener('change', (e) => { chatPickKey = e.target.value; renderChatFlow() })

// ── 聊天页注入（私聊/群聊）──
function simScene() { return $('sim-scene').value === 'private' ? 'private' : 'group' }
function simId() { return $('sim-id').value || '10000' }

$('sim-send').addEventListener('click', async () => {
  const text = $('sim-text').value.trim()
  if (!text) return
  const body = {
    scene: simScene(),
    groupId: simId(),
    senderId: simId(),
    senderNick: $('sim-who').value || '测试员',
    text,
    atBot: $('sim-at').checked,
  }
  const r = await fetch('/api/simulate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const res = await r.json()
  $('sim-result').classList.remove('hidden')
  $('sim-result').textContent = `注入成功 → ${res.scene === 'private' ? '私聊' : '群'} ${res.id}，已进入攒批队列${body.atBot ? '（@bot）' : ''}`
  $('sim-text').value = ''
})
$('sim-text').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('sim-send').click() })

$('sim-flush').addEventListener('click', async () => {
  const key = (simScene() === 'private' ? 'p:' : 'g:') + simId()
  await fetch('/api/flush', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key }) })
  $('sim-result').classList.remove('hidden')
  $('sim-result').textContent = `已触发 ${key} 攒批`
})

// ── 人设 ──
async function loadPersona() {
  const r = await fetch('/api/status')
  const res = await r.json()
  const p = res.persona || {}
  $('persona-card').innerHTML = `
    <div class="space-y-3">
      <div><span class="text-slate-500">姓名：</span><span class="font-mono">${esc(p.name || '--')}</span></div>
      <div><span class="text-slate-500">称呼朋友：</span><span class="font-mono">${esc(p.friendName || '--')}</span></div>
      ${p.base ? `<div class="text-slate-300">${esc(p.base)}</div>` : ''}
      ${p.traits?.length ? `<div class="flex flex-wrap gap-1">${p.traits.map(t => `<span class="badge badge-sm badge-outline">${esc(t)}</span>`).join('')}</div>` : ''}
      <div class="text-slate-500 text-xs">LLM: <span class="font-mono">${esc(res.llm?.model || '--')}</span></div>
    </div>`
  const shots = p.demoDialogs || p.fewShots || ''
  $('persona-shots').innerHTML = Array.isArray(shots)
    ? shots.map((s) => `<div class="glass round-lg p-2 text-[11px] font-mono">${esc(s)}</div>`).join('')
    : (typeof shots === 'string' && shots.trim()
      ? shots.split('\n').map((s) => `<div class="glass round-lg p-2 text-[11px] font-mono whitespace-pre-wrap">${esc(s)}</div>`).join('')
      : '<div class="text-slate-600">未配置 few-shot 示例（PERSONA_DEMO_DIALOGS）</div>')
}

// ── 长期记忆 ──
async function loadMemory() {
  const r = await fetch('/api/memory')
  const res = await r.json()
  const box = $('memory-panels')
  const cfgInfo = `<div class="text-[10px] text-slate-500 mb-2">持久化 ${res.enabled ? '✓' : '✗'} · 压缩阈值 ${res.maxTokens} tok × ${(res.threshold * 100).toFixed(0)}% · 保留最近 ${(res.keepRecentRatio * 100).toFixed(0)}%</div>`
  if (!res.enabled) {
    box.innerHTML = cfgInfo + '<div class="text-slate-600">记忆持久化已关闭（MEMORY_PERSIST=false）</div>'
    return
  }
  const scenes = res.scenes || []
  box.innerHTML = cfgInfo + (scenes.length
    ? scenes.map((s) => `
        <div class="glass round-lg p-3">
          <div class="flex items-center justify-between text-[11px]">
            <span class="font-mono text-sky-300">${esc(s.key)}</span>
            <span class="text-slate-500">${s.dialogLen} 条 · ${fmtTime(s.updatedAt)}</span>
          </div>
          ${s.summary ? `<div class="mt-2 text-slate-300 whitespace-pre-wrap">📌 ${esc(s.summary)}</div>` : '<div class="mt-1 text-slate-600">尚未生成摘要</div>'}
        </div>`).join('')
    : '<div class="text-slate-600">暂无记忆，聊一会儿后这里会显示 LLM 摘要</div>')
}

// ── 知识库 ──
async function loadKbMeta() {
  const r = await fetch('/api/status')
  const res = await r.json()
  if (res.rag) {
    $('kb-meta').textContent = `vec0 ${res.rag.vecLoaded ? '✓' : '✗'} · ${res.rag.count ? res.rag.count + ' chunk' : ''} · ${res.rag.embedOk ? 'embed ✓' : 'embed ✗'}`
    $('rag-badge').textContent = `RAG ${res.rag.vecLoaded ? 'vec' : ''} ${res.rag.count ? '·' + res.rag.count + 'chunk' : ''} ${res.rag.embedOk ? '·embed' : ''}`
  }
}

$('rag-go').addEventListener('click', async () => {
  const q = $('rag-q').value.trim()
  if (!q) return
  const btn = $('rag-go')
  btn.textContent = '检索中...'
  btn.disabled = true
  try {
    const r = await fetch('/api/rag?q=' + encodeURIComponent(q))
    const res = await r.json()
    ragMeta = res
    $('rag-meta').textContent = `向量(v=${res.vec.length} ${res.usedEmbed ? '✓ embed' : '✗ 无embed'} · vec0 ${res.vecLoaded ? '✓' : '✗'}) | FTS5(${res.fts.length}) | LIKE(${res.like.length})`
    renderRagResults(res)
  } finally {
    btn.textContent = '检索'
    btn.disabled = false
  }
})
$('rag-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('rag-go').click() })

function renderRagResults(res) {
  const box = $('rag-results')
  const cols = [
    { title: '向量 vec0', hits: res.vec, color: 'text-emerald-400' },
    { title: 'FTS5 BM25', hits: res.fts, color: 'text-sky-400' },
    { title: 'LIKE 兜底', hits: res.like, color: 'text-slate-400' },
  ]
  const q = res.q || $('rag-q').value.trim()
  const terms = q.split(/\s+/).filter(Boolean).map(esc)
  const hl = (text) => {
    const safe = esc(text)
    if (!terms.length) return safe
    let out = safe
    for (const t of terms) {
      if (!t) continue
      out = out.split(t).join(`<mark class="bg-amber-300/30 text-amber-200 rounded px-0.5">${t}</mark>`)
    }
    return out
  }
  box.innerHTML = cols.map((c) => `
    <div class="glass round-2xl p-4">
      <div class="text-xs font-semibold ${c.color} mb-2">${c.title}（${c.hits.length}）</div>
      ${c.hits.length ? c.hits.map((h, i) => `
        <div class="mb-2 p-2 rounded-lg bg-black/30">
          <div class="flex items-center justify-between">
            <div class="text-[10px] text-slate-500 font-mono">#${i + 1} score=${h.score.toFixed(4)} · ${h.date} · ${h.chunkId}</div>
            <button class="btn btn-xs btn-ghost text-[10px] rag-copy" data-text="${esc(h.text)}">复制</button>
          </div>
          <div class="text-xs whitespace-pre-wrap mt-1">${hl(h.text.slice(0, 220))}${h.text.length > 220 ? '…' : ''}</div>
        </div>`).join('')
      : `<div class="text-xs text-slate-600">无结果</div>`}
    </div>`).join('')
  box.querySelectorAll('.rag-copy').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(btn.dataset.text)
        btn.textContent = '✓'
        setTimeout(() => { btn.textContent = '复制' }, 1200)
      } catch {
        btn.textContent = '✗'
      }
    })
  })
}

// ── 统计（ECharts）──
let currentRange = 24
let stTrendChart = null
let stTokenChart = null

document.querySelectorAll('.range-chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    document.querySelectorAll('.range-chip').forEach((c) => c.classList.remove('active'))
    chip.classList.add('active')
    currentRange = Number(chip.dataset.range)
    loadStats(currentRange)
  })
})

async function loadStats(hours) {
  const r = await fetch('/api/stats?hours=' + (hours || 24))
  const s = await r.json()
  const agg = s.agg || {}
  const llm = agg.llm || {}
  const embed = agg.embed || {}
  const groups = s.perGroup || {}
  const models = s.perModel || {}
  const series = s.timeseries || []
  const gEntries = Object.entries(groups).sort((a, b) => b[1].msg - a[1].msg)
  const mEntries = Object.entries(models).sort((a, b) => (b[1].tokensIn + b[1].tokensOut) - (a[1].tokensIn + a[1].tokensOut))
  const totalMsg = Object.values(groups).reduce((a, g) => a + g.msg, 0) || 0
  const totalReply = Object.values(groups).reduce((a, g) => a + g.reply, 0) || 0

  // 费用
  const cost = agg.totalCost || 0
  $('st-cost').textContent = cost > 0 ? '¥' + cost.toFixed(4) : '¥0'
  $('st-cost-sub').innerHTML = (cost > 0
    ? `LLM ¥${(llm.cost || 0).toFixed(4)} · Embed ¥${(embed.cost || 0).toFixed(4)}`
    : '未配置价格（LLM_PRICE_PER_M_IN/OUT）→ 免费')

  $('st-llm').textContent = String(llm.calls || 0)
  $('st-llm-sub').innerHTML = `成功 ${llm.ok || 0} · 失败 <span class="${llm.fail ? 'text-red-400' : ''}">${llm.fail || 0}</span><br>成功率 ${pct(llm.successRate)} · 缓存命中 <span class="font-mono ${(llm.cacheHitRate || 0) > 0 ? 'text-emerald-400' : ''}">${pct(llm.cacheHitRate)}</span>`
  $('st-embed').textContent = String(embed.calls || 0)
  $('st-embed-sub').innerHTML = `成功 ${embed.ok || 0} · 失败 <span class="${embed.fail ? 'text-red-400' : ''}">${embed.fail || 0}</span><br>成功率 ${pct(embed.successRate)}`
  $('st-token').textContent = fmtNum((llm.tokensIn || 0) + (llm.tokensOut || 0))
  $('st-token-sub').innerHTML = `in <span class="font-mono">${fmtNum(llm.tokensIn)}</span> · out <span class="font-mono">${fmtNum(llm.tokensOut)}</span>${llm.cachedTokens ? ` · 缓存 <span class="font-mono text-emerald-400">${fmtNum(llm.cachedTokens)}</span>` : ''}`
  $('st-msg').textContent = `${totalMsg} / ${totalReply}`
  $('st-msg-sub').textContent = `进程运行 ${fmtSince(s.sinceStart)}`

  // 调用趋势
  const stEl = $('st-trend')
  if (!stTrendChart) stTrendChart = echarts.init(stEl)
  stTrendChart.setOption({
    backgroundColor: 'transparent',
    tooltip: { trigger: 'axis' },
    grid: { left: 40, right: 16, top: 24, bottom: 28 },
    xAxis: { type: 'category', data: series.map(x => x.hour.slice(5, 16)), axisLabel: { color: '#64748b', fontSize: 10 } },
    yAxis: { type: 'value', minInterval: 1, axisLabel: { color: '#64748b', fontSize: 10 } },
    series: [
      { name: 'LLM', type: 'line', smooth: true, areaStyle: { opacity: 0.15 }, data: series.map(x => x.llmCalls), itemStyle: { color: '#6366f1' } },
      { name: 'Embed', type: 'line', smooth: true, areaStyle: { opacity: 0.15 }, data: series.map(x => x.embedCalls), itemStyle: { color: '#22d3ee' } },
    ],
  })

  // Token 趋势
  const ttEl = $('st-token-trend')
  if (!stTokenChart) stTokenChart = echarts.init(ttEl)
  stTokenChart.setOption({
    backgroundColor: 'transparent',
    tooltip: { trigger: 'axis' },
    grid: { left: 40, right: 16, top: 24, bottom: 28 },
    xAxis: { type: 'category', data: series.map(x => x.hour.slice(5, 16)), axisLabel: { color: '#64748b', fontSize: 10 } },
    yAxis: { type: 'value', axisLabel: { color: '#64748b', fontSize: 10 } },
    series: [
      { name: 'tokens in', type: 'bar', stack: 't', data: series.map(x => x.tokensIn), itemStyle: { color: '#a78bfa' } },
      { name: 'tokens out', type: 'bar', stack: 't', data: series.map(x => x.tokensOut), itemStyle: { color: '#34d399' } },
    ],
  })

  // 模型排行（by Token + 花费）
  $('st-model-rank').innerHTML = mEntries.length
    ? mEntries.map(([name, m]) => {
        const tok = m.tokensIn + m.tokensOut
        return rankRow(name, `${m.calls} 次 · ${fmtNum(tok)} tok${(m.cost || 0) > 0 ? ' · ¥' + (m.cost).toFixed(4) : ''}`, `${m.calls ? '✓' + m.ok + ' · 均值 ' + fmtMs(m.avgDurationMs) : '--'}`, tok, mEntries[0][1].tokensIn + mEntries[0][1].tokensOut)
      }).join('')
    : '<div class="text-xs text-slate-600">暂无数据</div>'

  // 按群
  $('st-group-rank').innerHTML = gEntries.length
    ? gEntries.map(([gid, g]) => rankRow('群 ' + gid, `消息 ${g.msg} · 回复 ${g.reply}`, '最后活跃 ' + fmtTime(g.lastAt), g.msg, gEntries[0][1].msg))
    : '<div class="text-xs text-slate-600">暂无数据</div>'
}

function rankRow(name, val, sub, n, max) {
  const w = max ? Math.max(4, Math.round((n / max) * 100)) : 0
  return `
  <div class="mb-2">
    <div class="flex items-center justify-between text-xs">
      <span class="font-mono">${esc(name)}</span>
      <span class="text-slate-400">${val}</span>
    </div>
    <div class="text-[10px] text-slate-600">${sub}</div>
    <div class="w-full h-1 bg-black/40 rounded-full mt-1 overflow-hidden">
      <div class="h-full bg-indigo-500/70 rounded-full" style="width:${w}%"></div>
    </div>
  </div>`
}

// ── 配置 ──
async function loadConfig() {
  const r = await fetch('/api/config')
  const res = await r.json()
  $('cfg-editor').value = res.env
  if (res.active) renderActiveConfig(res.active, res.rag, res.profileMeta)
}

function renderActiveConfig(cfg, rag, profileMeta) {
  const panels = document.getElementById('active-config')
  if (!panels) return
  const hl = cfg.humanlike || {
    replyProb: { group: 1, private: 1 }, react: { minMs: 0, maxMs: 0 },
    cooldown: { groupMs: 0, privateMs: 0 }, typing: { charsPerSec: { min: 0, max: 0 }, segGap: { minMs: 0, maxMs: 0 }, maxSegments: 0 },
    style: { maxChars: 0, emojiProb: 0, fillerProb: 0, typoProb: 0 },
    schedule: { quietHours: '', drowsy: [], proactiveGapMs: 0 },
  }
  panels.innerHTML = `
    <div class="grid grid-cols-2 gap-3 text-xs">
      <div class="glass p-3 round-xl">
        <div class="text-slate-500 uppercase mb-1">LLM</div>
        <div class="font-mono">${esc(cfg.llm.model || '未配置')}</div>
        <div class="text-slate-600">${esc(cfg.llm.baseUrl)}</div>
      </div>
      <div class="glass p-3 round-xl">
        <div class="text-slate-500 uppercase mb-1">Embed</div>
        <div class="font-mono">${esc(cfg.rag.embedModel)}</div>
        <div class="text-slate-600">${cfg.rag.embedEndpoint ? esc(cfg.rag.embedEndpoint) : '未配置'}</div>
      </div>
      <div class="glass p-3 round-xl">
        <div class="text-slate-500 uppercase mb-1">RAG 策略</div>
        <div class="font-mono">${esc((rag?.enabledModes || []).join(' → ') || '无')}</div>
        <div class="text-slate-600">${cfg.rag.dbPath ? esc(cfg.rag.dbPath.split('/').pop()) : '未配置'}</div>
      </div>
      <div class="glass p-3 round-xl">
        <div class="text-slate-500 uppercase mb-1">攒批 / 冷却</div>
        <div class="font-mono">N=${cfg.batch.n} T=${(cfg.batch.t/1000).toFixed(0)}s</div>
        <div class="text-slate-600">COOLDOWN ${(hl.cooldown.groupMs/1000).toFixed(0)}s / 私 ${(hl.cooldown.privateMs/1000).toFixed(0)}s</div>
      </div>
      <div class="glass p-3 round-xl">
        <div class="text-slate-500 uppercase mb-1">拟人 · 反应</div>
        <div class="font-mono">${(hl.react.minMs/1000).toFixed(1)}~${(hl.react.maxMs/1000).toFixed(1)}s</div>
        <div class="text-slate-600">回复率 群${(hl.replyProb.group*100).toFixed(0)}% / 私${(hl.replyProb.private*100).toFixed(0)}%</div>
      </div>
      <div class="glass p-3 round-xl">
        <div class="text-slate-500 uppercase mb-1">拟人 · 打字</div>
        <div class="font-mono">${hl.typing.charsPerSec.min}~${hl.typing.charsPerSec.max} 字/秒</div>
        <div class="text-slate-600">间隔 ${(hl.typing.segGap.minMs/1000).toFixed(1)}~${(hl.typing.segGap.maxMs/1000).toFixed(1)}s · 最多${hl.typing.maxSegments}条</div>
      </div>
      <div class="glass p-3 round-xl">
        <div class="text-slate-500 uppercase mb-1">拟人 · 风格</div>
        <div class="font-mono">≤${hl.style.maxChars}字</div>
        <div class="text-slate-600">表情${(hl.style.emojiProb*100).toFixed(0)}% 语气词${(hl.style.fillerProb*100).toFixed(0)}% 错字${(hl.style.typoProb*100).toFixed(0)}%</div>
      </div>
      <div class="glass p-3 round-xl">
        <div class="text-slate-500 uppercase mb-1">拟人 · 节律</div>
        <div class="font-mono">${hl.schedule.quietHours ? esc(hl.schedule.quietHours) : '全天在线'}</div>
        <div class="text-slate-600">半醒 ${hl.schedule.drowsy.length}段 · 主动 ${hl.schedule.proactiveGapMs ? (hl.schedule.proactiveGapMs/60000).toFixed(0)+'min' : '关'}</div>
      </div>
      <div class="glass p-3 round-xl">
        <div class="text-slate-500 uppercase mb-1">画像来源</div>
        <div class="font-mono">${esc(hl.source || 'env')}</div>
        <div class="text-slate-600">${profileMeta?.generatedAt ? '挖掘 ' + esc(profileMeta.generatedAt.slice(0, 16).replace('T', ' ')) + ' · 本人' + (profileMeta.sample?.selfText ?? 0) + '条' : '未加载 profile.json'}</div>
      </div>
      <div class="glass p-3 round-xl">
        <div class="text-slate-500 uppercase mb-1">记忆 / 触发</div>
        <div class="font-mono">MAX_HISTORY=${cfg.agent.maxHistory}</div>
        <div class="text-slate-600">MODE=${cfg.agent.respondMode}</div>
      </div>
      <div class="glass p-3 round-xl">
        <div class="text-slate-500 uppercase mb-1">Persona</div>
        <div class="font-mono">${esc(cfg.persona.name)}</div>
        <div class="text-slate-600">friend=${esc(cfg.persona.friendName)}</div>
      </div>
    </div>`
}
$('cfg-reload').addEventListener('click', loadConfig)
$('cfg-save').addEventListener('click', async () => {
  const env = $('cfg-editor').value
  const r = await fetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ env }),
  })
  const res = await r.json()
  const note = $('cfg-note')
  note.textContent = res.ok ? '✓ ' + res.note : '❌ ' + (res.error || '保存失败')
})

// ── 日志 ──
let logCount = 0
function appendLog(entry) {
  const box = $('log-box')
  if (logCount === 0) box.innerHTML = ''
  logCount++
  const color = entry.level === 'error' ? 'text-red-400' : entry.level === 'warn' ? 'text-amber-400' : 'text-slate-300'
  const div = document.createElement('div')
  div.className = color
  div.textContent = `[${new Date(entry.t).toLocaleTimeString('zh-CN', { hour12: false })}] ${entry.l}`
  box.appendChild(div)
  if (box.childElementCount > 500) box.removeChild(box.firstChild)
  box.scrollTop = box.scrollHeight
}
$('log-clear').addEventListener('click', () => { $('log-box').innerHTML = ''; logCount = 0 })

// ── 初始化 ──
loadConfig()
loadKbMeta()
setInterval(() => { $('footer-time').textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false }) }, 1000)
setInterval(() => { if (document.getElementById('page-overview').classList.contains('active')) renderChatFlow() }, 2000)

// 首次状态（SSE 会推，兜底拉一次）
fetch('/api/state').then((r) => r.json()).then((snap) => renderState(snap)).catch(() => {})
