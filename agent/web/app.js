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
    if (btn.dataset.tab === 'stats') loadStats()
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
  const connPill = document.querySelector('.status-pill')
  connPill.title = snap.connError || (snap.connected ? '连接正常' : '未接入 NapCat 适配器')
  if (snap.connError) connPill.classList.add('ring-1', 'ring-red-500/50')
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
  // 攒批进度条：目标 N 条
  const batchPct = Math.min(100, Math.round((g.pending.length / currentSnap.batchN) * 100))
  const progressHtml = g.pending.length
    ? `<div class="mt-2">
        <div class="flex items-center justify-between text-[10px] text-slate-500 mb-1">
          <span>攒批进度</span><span class="font-mono">${g.pending.length}/${currentSnap.batchN}</span>
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
  // 记忆：每条带时间戳 + 角色色差
  const dialogHtml = g.dialog.length
    ? `<div class="mt-2 space-y-1">${
        g.dialog.map((m) => `
          <div class="text-xs ${m.role === 'user' ? 'text-sky-300' : 'text-emerald-300'} leading-snug">
            <span class="text-[10px] text-slate-600 font-mono mr-1">${m.time ? fmtTime(m.time) : ''}</span>
            <span class="${m.role === 'user' ? '' : 'opacity-90'}">${m.role === 'user' ? '👤' : '🤖'}${esc(m.content.slice(0, 80))}</span>
          </div>`).join('')
      }</div>
      <div class="text-[10px] text-slate-600 mt-1">记忆 ${g.dialog.length} 条 · 历史 ${currentSnap.batchN * 2} 轮</div>`
    : ``
  return `
  <div class="glass round-2xl p-4" data-gid="${g.groupId}">
    <div class="flex items-center justify-between">
      <div class="font-mono font-semibold">群 ${g.groupId}</div>
      <div class="flex gap-2 items-center">
        ${timerBadge}
        <button class="btn btn-xs btn-ghost text-error act-clear" title="清空该群记忆">清空</button>
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
      const gid = btn.closest('[data-gid]').dataset.gid
      await fetch('/api/flush', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ groupId: gid }) })
    })
  })
  document.querySelectorAll('.act-clear').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const gid = btn.closest('[data-gid]').dataset.gid
      if (!confirm(`清空群 ${gid} 的会话记忆？`)) return
      await fetch('/api/clear', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ groupId: gid }) })
    })
  })
}

// 全清按钮（状态页顶部）
$('clear-all')?.addEventListener('click', async () => {
  if (!confirm('清空所有群的会话记忆？')) return
  await fetch('/api/clear', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) })
})

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

// ── 用量统计 ──
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
  const totalMsg = Object.values(groups).reduce((a, g) => a + g.msg, 0) || 0
  const totalReply = Object.values(groups).reduce((a, g) => a + g.reply, 0) || 0

  $('st-llm').textContent = String(llm.ok + llm.fail || 0)
  $('st-llm').nextElementSibling.innerHTML = `成功 ${llm.ok || 0} · 失败 <span class="${llm.fail ? 'text-red-400' : ''}">${llm.fail || 0}</span><br><span class="text-slate-500">Token in ${(llm.tokensIn || 0).toLocaleString()} · out ${(llm.tokensOut || 0).toLocaleString()}</span>`
  $('st-embed').textContent = String(embed.ok + embed.fail || 0)
  $('st-embed').nextElementSibling.innerHTML = `成功 ${embed.ok || 0} · 失败 <span class="${embed.fail ? 'text-red-400' : ''}">${embed.fail || 0}</span>`
  $('st-msg').textContent = `${totalMsg} / ${totalReply}`
  $('st-msg').nextElementSibling.textContent = `进程运行 ${fmtSince(s.sinceStart)}`

  $('st-bars').innerHTML = series.map((x) => {
    const h = x.hour.slice(11, 16)
    const total = x.llmCalls + x.embedCalls
    const pct = Math.max(4, Math.round((total / maxCalls) * 100))
    return `<div class="flex flex-col items-center gap-1 flex-1">
      <div class="text-[9px] text-slate-500">${total || ''}</div>
      <div class="w-full bg-indigo-500/60 rounded-sm" style="height:${pct}px" title="LLM ${x.llmCalls} · Embed ${x.embedCalls}"></div>
      <div class="text-[9px] text-slate-600 font-mono">${h}</div>
    </div>`
  }).join('')

  $('st-table').innerHTML = gEntries.length ? `<table class="table table-xs w-full">
    <thead><tr><th>群号</th><th>消息</th><th>回复</th><th>最后活跃</th></tr></thead>
    <tbody>${gEntries.map(([gid, g]) => `<tr>
      <td class="font-mono">${esc(gid)}</td>
      <td>${g.msg}</td>
      <td>${g.reply}</td>
      <td>${fmtTime(g.lastAt)}</td>
    </tr>`).join('')}</tbody>
  </table>` : '<div class="text-xs text-slate-600">暂无数据</div>'
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