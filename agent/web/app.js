// ── 状态 ──
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
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

let currentSnap = null
let ragMeta = null

// ── Tabs ──
document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((b) => b.classList.remove('active'))
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'))
    btn.classList.add('active')
    $('tab-' + btn.dataset.tab).classList.add('active')
  })
})

// ── SSE 状态流 ──
const evtSource = new EventSource('/api/stream')
evtSource.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.type === 'state') renderState(msg.snap)
  if (msg.type === 'log') appendLog(msg.entry)
})

// ── 渲染状态 ──
function renderState(snap) {
  currentSnap = snap
  $('conn-dot').className = 'pulse-dot ' + (snap.connected ? 'live' : 'dead')
  $('conn-text').textContent = snap.connected ? `NapCat 已连接` : 'NapCat 未连接'
  $('batch-info').textContent = `N=${snap.batchN} / T=${(snap.batchT / 1000).toFixed(0)}s`
  $('cooldown').textContent = snap.cooldownLeftMs > 0 ? fmtSince(snap.cooldownLeftMs) : '就绪'
  $('group-count').textContent = String(Object.keys(snap.groups).length)
  $('last-reply').textContent = fmtTime(snap.lastReplyAt)
  let dialogTotal = 0
  for (const g of Object.values(snap.groups)) dialogTotal += g.dialog.length
  $('dialog-total').textContent = String(dialogTotal)
  $('subtitle').textContent = `本人：${snap.selfName}`

  const list = $('group-list')
  const groups = Object.values(snap.groups).sort((a, b) => b.lastReplyAt - a.lastReplyAt)
  if (!groups.length) {
    list.innerHTML = `<div class="glass round-2xl p-8 text-center text-slate-500">还没有群消息，去「调试台」模拟几条试试</div>`
    return
  }
  list.innerHTML = groups.map((g) => renderGroup(g)).join('')
  bindGroupButtons()
}

function renderGroup(g) {
  const tLeft = g.timerDeadlineAt ? Math.max(0, g.timerDeadlineAt - Date.now()) : null
  const timerBadge = tLeft !== null
    ? `<span class="badge badge-sm badge-warning">攒批中 ${fmtSince(tLeft)}</span>`
    : (g.pending.length ? `<span class="badge badge-sm badge-info">待触发</span>` : ``)
  const pendingHtml = g.pending.length
    ? `<div class="text-xs text-amber-300/80 mt-1">攒批（${g.pending.length}）：
        <span class="font-mono">${esc(g.pending.join(' ').slice(0, 160))}</span></div>`
    : ``
  const dialogHtml = g.dialog.length
    ? `<div class="text-xs text-slate-400 mt-1"><span class="text-slate-500">记忆(${g.dialog.length}条)：</span>${
        g.dialog.map((m) => `${m.role === 'user' ? '👤' : '🤖'}${esc(m.content.slice(0, 60))}`).join(' · ')
      }</div>`
    : ``
  return `
  <div class="glass round-2xl p-4" data-gid="${g.groupId}">
    <div class="flex items-center justify-between">
      <div class="font-mono font-semibold">群 ${g.groupId}</div>
      <div class="flex gap-2 items-center">
        ${timerBadge}
        <button class="btn btn-xs btn-primary act-flush">立即触发</button>
      </div>
    </div>
    ${pendingHtml}
    ${dialogHtml}
  </div>`
}

function bindGroupButtons() {
  document.querySelectorAll('.act-flush').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const gid = btn.closest('[data-gid]').dataset.gid
      await fetch('/api/flush', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ groupId: gid }) })
    })
  })
}

// ── 调试台 ──
$('sim-send').addEventListener('click', async () => {
  const text = $('sim-text').value.trim()
  if (!text) return
  const body = {
    groupId: $('sim-group').value || '10000',
    senderNick: $('sim-who').value || '测试员',
    text,
  }
  const r = await fetch('/api/simulate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const res = await r.json()
  $('sim-result').classList.remove('hidden')
  $('sim-result').textContent = `注入成功 → 群 ${res.groupId}，已进入攒批队列`
  $('sim-text').value = ''
})

$('sim-flush').addEventListener('click', async () => {
  const gid = $('sim-group').value || '10000'
  await fetch('/api/flush', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ groupId: gid }) })
  $('sim-result').classList.remove('hidden')
  $('sim-result').textContent = `已触发群 ${gid} 攒批`
})

// ── RAG 检索 ──
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
  box.innerHTML = cols.map((c) => `
    <div class="glass round-2xl p-4">
      <div class="text-xs font-semibold ${c.color} mb-2">${c.title}（${c.hits.length}）</div>
      ${c.hits.length ? c.hits.map((h, i) => `
        <div class="mb-2 p-2 rounded-lg bg-black/30">
          <div class="text-[10px] text-slate-500 font-mono">#${i + 1} score=${h.score.toFixed(4)} · ${h.date} · ${h.chunkId}</div>
          <div class="text-xs whitespace-pre-wrap mt-1">${esc(h.text.slice(0, 180))}${h.text.length > 180 ? '…' : ''}</div>
        </div>`).join('')
      : `<div class="text-xs text-slate-600">无结果</div>`}
    </div>`).join('')
}

// ── 手测 LLM ──
async function loadModels() {
  const r = await fetch('/api/models')
  const res = await r.json()
  const sel = $('llm-model')
  sel.innerHTML = res.models.map((m) => `<option value="${esc(m.id)}">${esc(m.id)}</option>`).join('')
}
$('llm-go').addEventListener('click', async () => {
  const prompt = $('llm-prompt').value.trim()
  if (!prompt) return
  const btn = $('llm-go')
  const out = $('llm-out')
  btn.textContent = '发送中...'
  btn.disabled = true
  out.classList.remove('hidden')
  out.textContent = '…'
  try {
    const r = await fetch('/api/llm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, withRag: $('llm-rag').checked }),
    })
    const res = await r.json()
    out.classList.remove('hidden')
    if (res.ok) out.textContent = res.text || '(空回复)'
    else out.textContent = '❌ ' + (res.error || '未知错误')
    out.className = 'mt-3 text-sm whitespace-pre-wrap glass round-xl p-4 ' + (res.ok ? 'text-emerald-200' : 'text-red-300')
  } finally {
    btn.textContent = '发送'
    btn.disabled = false
  }
})

// ── 配置 ──
async function loadConfig() {
  const r = await fetch('/api/config')
  const res = await r.json()
  $('cfg-editor').value = res.env
  // 同时渲染活跃配置摘要
  if (res.active) renderActiveConfig(res.active, res.rag)
}

function renderActiveConfig(cfg, rag) {
  const panels = document.getElementById('active-config')
  if (!panels) return
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
        <div class="text-slate-600">COOLDOWN ${(cfg.agent.replyCooldown/1000).toFixed(0)}s</div>
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

// ── 用量统计 tab 注入（配置 tab 旁加一个）──
document.querySelectorAll('.tab').forEach((b) => {
  if (b.dataset.tab === 'config') {
    const nav = b.parentElement
    const statsBtn = document.createElement('button')
    statsBtn.className = 'tab'
    statsBtn.dataset.tab = 'stats'
    statsBtn.textContent = '用量'
    nav.insertBefore(statsBtn, b.nextSibling)
    statsBtn.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'))
      document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'))
      statsBtn.classList.add('active')
      $('tab-stats').classList.add('active')
      loadStats()
    })
  }
})

// 用量面板容器（动态插入）
const statsSection = document.createElement('section')
statsSection.id = 'tab-stats'
statsSection.className = 'tab-panel'
document.querySelector('footer').insertAdjacentElement('beforebegin', statsSection)

async function loadStats() {
  const r = await fetch('/api/stats?hours=24')
  const s = await r.json()
  const t = s.totals || {}
  const llm = t.llm || {}
  const embed = t.embed || {}
  const groups = s.perGroup || {}
  const series = s.timeseries || []
  const maxCalls = Math.max(1, ...series.map((x) => x.llmCalls + x.embedCalls))
  const gEntries = Object.entries(groups).sort((a, b) => b[1].msg - a[1].msg)

  const bars = series.map((x) => {
    const h = x.hour.slice(11, 16)
    const total = x.llmCalls + x.embedCalls
    const pct = Math.max(4, Math.round((total / maxCalls) * 100))
    return `<div class="flex flex-col items-center gap-1 flex-1">
      <div class="text-[9px] text-slate-500">${total || ''}</div>
      <div class="w-full bg-indigo-500/60 rounded-sm" style="height:${pct}px" title="LLM ${x.llmCalls} · Embed ${x.embedCalls}"></div>
      <div class="text-[9px] text-slate-600 font-mono">${h}</div>
    </div>`
  }).join('')

  statsSection.innerHTML = `
  <div class="grid md:grid-cols-3 gap-4">
    <div class="glass round-2xl p-5">
      <div class="text-xs text-slate-500 uppercase">LLM 调用</div>
      <div class="text-2xl font-mono mt-1">${llm.ok + llm.fail || 0}</div>
      <div class="text-xs mt-2">成功 ${llm.ok || 0} · 失败 <span class="${llm.fail ? 'text-red-400' : ''}">${llm.fail || 0}</span></div>
      <div class="text-xs text-slate-500 mt-1">Token in ${(llm.tokensIn || 0).toLocaleString()} · out ${(llm.tokensOut || 0).toLocaleString()}</div>
    </div>
    <div class="glass round-2xl p-5">
      <div class="text-xs text-slate-500 uppercase">Embed 调用</div>
      <div class="text-2xl font-mono mt-1">${embed.ok + embed.fail || 0}</div>
      <div class="text-xs mt-2">成功 ${embed.ok || 0} · 失败 <span class="${embed.fail ? 'text-red-400' : ''}">${embed.fail || 0}</span></div>
    </div>
    <div class="glass round-2xl p-5">
      <div class="text-xs text-slate-500 uppercase">群消息 / 回复</div>
      <div class="text-2xl font-mono mt-1">${Object.values(groups).reduce((a, g) => a + g.msg, 0) || 0} <span class="text-base text-slate-500">/</span> ${Object.values(groups).reduce((a, g) => a + g.reply, 0) || 0}</div>
      <div class="text-xs mt-2">进程运行 ${fmtSince(s.sinceStart)}</div>
    </div>
  </div>

  <div class="glass round-2xl p-5 mt-4">
    <div class="text-xs text-slate-500 uppercase mb-3">最近 24h 调用趋势（LLM+Embed）</div>
    <div class="flex items-end gap-1 h-24">${bars}</div>
  </div>

  <div class="glass round-2xl p-5 mt-4">
    <div class="text-xs text-slate-500 uppercase mb-3">按群统计</div>
    ${gEntries.length ? `<table class="table table-xs w-full">
      <thead><tr><th>群号</th><th>消息</th><th>回复</th><th>最后活跃</th></tr></thead>
      <tbody>${gEntries.map(([gid, g]) => `<tr>
        <td class="font-mono">${esc(gid)}</td>
        <td>${g.msg}</td>
        <td>${g.reply}</td>
        <td>${fmtTime(g.lastAt)}</td>
      </tr>`).join('')}</tbody>
    </table>` : '<div class="text-xs text-slate-600">暂无数据</div>'}
  </div>`
}

// ── 初始化 ──
loadConfig()
loadModels()
setInterval(() => { $('footer-time').textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false }) }, 1000)

// 每 5s 拉一次 RAG 状态徽标（静态信息，SSE 不推）
setInterval(async () => {
  if (!ragMeta) {
    const r = await fetch('/api/status')
    const res = await r.json()
    if (res.rag) {
      $('rag-badge').textContent = `RAG ${res.rag.vecLoaded ? 'vec' : ''} ${res.rag.count ? '·' + res.rag.count + 'chunk' : ''} ${res.rag.embedOk ? '·embed' : ''}`
    }
  }
}, 5000)

// 加载完成后立即拉一次状态
fetch('/api/status').then((r) => r.json()).then((res) => {
  if (res.rag) $('rag-badge').textContent = `RAG ${res.rag.vecLoaded ? 'vec' : ''} ${res.rag.count ? '·' + res.rag.count + 'chunk' : ''} ${res.rag.embedOk ? '·embed' : ''}`
})