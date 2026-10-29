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
    if (page === 'chat') history.replaceState(null, '', '#chat')
    else if (location.hash) history.replaceState(null, '', location.pathname + location.search)
    if (page === 'stats') loadStats(currentRange)
    if (page === 'persona') { loadPersona(); loadMemory(); loadPersonaForm(); loadPresets() }
    if (page === 'kb') void loadRagInfo()
    if (page === 'models') loadModels()
    if (page === 'config') { loadConfig(); loadServiceConfig() }
    if (page === 'overview') void loadThreadOverview()
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

// ── 渲染运行时状态（连接/冷却/近期状态）──
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
  $('ov-last-reply').textContent = fmtTime(snap.lastReplyAt)
  $('ov-batch-n').textContent = snap.batchN
  $('ov-batch-t').textContent = (snap.batchT / 1000).toFixed(0)
  $('ov-cooldown').textContent = snap.cooldownLeftMs > 0 ? fmtSince(snap.cooldownLeftMs) : '就绪'
  $('ov-mode-note').textContent = 'respondMode: ' + snap.respondMode
  renderRecentState(snap.recentState)
}

// ── 近期状态卡片 ──
function stateBar(label, value, color) {
  const v = Math.max(0, Math.min(1, Number(value) || 0))
  return `<div>
    <div class="flex justify-between text-[10px] text-slate-500 mb-1"><span>${label}</span><span class="font-mono">${(v * 100).toFixed(0)}%</span></div>
    <div class="w-full h-1.5 bg-black/40 rounded-full overflow-hidden"><div class="h-full ${color} rounded-full" style="width:${v * 100}%"></div></div>
  </div>`
}

function renderRecentState(s) {
  const el = $('recent-state')
  if (!el) return
  if (!s) {
    el.innerHTML = `<div class="text-sm font-semibold mb-2">近期状态</div><div class="text-xs text-slate-500">未启用</div>`
    return
  }
  const m = s.modifiers || {}
  const labels = s.labels || {}
  const topic = s.topic ? `${esc(s.topic)}×${Math.round(s.topicHits || 0)}` : '--'
  el.innerHTML = `
    <div class="flex items-center justify-between mb-3">
      <div class="text-sm font-semibold">近期状态 <span class="text-[10px] text-slate-500 font-normal">全局 · 实时</span></div>
      <div class="text-[10px] text-slate-500">${esc(labels.energy || '')} · ${esc(labels.mood || '')} · ${esc(labels.patience || '')} · ${esc(labels.social || '')} · ${esc(labels.busy || '')}</div>
    </div>
    <div class="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
      ${stateBar('精力', s.energy, 'bg-emerald-400')}
      ${stateBar('心情', s.mood, 'bg-sky-400')}
      ${stateBar('耐心', s.patience, 'bg-amber-400')}
      ${stateBar('社交电量', s.social, 'bg-fuchsia-400')}
      ${stateBar('忙碌', s.busy, 'bg-orange-400')}
      ${stateBar('烦躁', s.irritation, 'bg-rose-400')}
      ${stateBar('兴趣', s.interest, 'bg-indigo-400')}
      ${stateBar('专注', s.focus, 'bg-cyan-400')}
    </div>
    <div class="grid grid-cols-2 md:grid-cols-4 gap-3 text-[11px] text-slate-500 mt-3">
      <div>近期消息 <span class="font-mono text-slate-300">${(s.recentMsgs || 0).toFixed(1)}</span> · <span class="font-mono text-slate-300">${(s.msgRate || 0).toFixed(1)}/分</span></div>
      <div>近期回复 <span class="font-mono text-slate-300">${(s.recentReplies || 0).toFixed(1)}</span> · <span class="font-mono text-slate-300">${(s.replyRate || 0).toFixed(1)}/分</span></div>
      <div>静默 <span class="font-mono text-slate-300">${fmtSince(s.silenceMs)}</span> · 连发 <span class="font-mono text-slate-300">${s.otherStreak || 0}</span></div>
      <div>话题 <span class="text-slate-300">${topic}</span></div>
    </div>
    <div class="text-[11px] text-slate-500 mt-1">
      状态修正：回复×${(m.replyProb || 1).toFixed(2)} · 延迟×${(m.reactDelay || 1).toFixed(2)} · 长度×${(m.styleLength || 1).toFixed(2)} · 主动 ${Math.round((m.proactive || 0) * 100)}%
    </div>
  `
}

// ── 活跃群概览（统一用 v2 线程数据）──
async function loadThreadOverview() {
  try {
    const r = await fetch('/api/v2/threads')
    const j = await r.json()
    const ts = j.threads || []
    const totals = j.totals || {}
    const realTs = ts.filter(t => t.channel === 'qq')
    $('ov-groups').textContent = String(realTs.filter(t => !t.archived).length)
    $('ov-dialog').textContent = String(realTs.reduce((a, t) => a + (t.messageCount || 0), 0))
    const list = $('group-list')
    if (!list) return
    if (!ts.length) {
      list.innerHTML = `<div class="p-6 text-center text-slate-500 text-sm">还没有会话，去「聊天」页新建</div>`
      return
    }
    const real = ts.filter(t => t.channel === 'qq' && !t.archived)
    const arch = ts.filter(t => t.channel === 'qq' && t.archived)
    const row = (t) => `
      <div class="flex items-center justify-between p-2 rounded-xl border border-white/5 hover:bg-white/5 transition" data-thread="${esc(t.id)}" role="button">
        <div class="min-w-0">
          <div class="flex items-center gap-2">
            <span class="text-[11px] font-bold text-indigo-300">真群</span>
            <span class="font-mono text-[12px] text-indigo-200">${esc(t.externalId)}</span>
            ${t.paused ? '<span class="pill bg-amber-500/15 text-amber-300">暂停</span>' : ''}
          </div>
          <div class="text-[10px] text-slate-500 truncate mt-0.5">${esc(t.lastPreview || '（暂无消息）')}</div>
        </div>
        <div class="shrink-0 text-right ml-3">
          <div class="text-[10px] font-mono text-slate-400">${t.messageCount || 0} 条</div>
          <div class="text-[9px] text-slate-600 mt-0.5">${fmtTime(t.lastMessageAt)}</div>
        </div>
      </div>`
    const head = (label, cls) => `<div class="px-1 pt-2 pb-1 text-[10px] uppercase tracking-widest font-semibold ${cls}">${label}</div>`
    let html = ''
    if (real.length) html += head('真群', 'text-indigo-400') + real.map(row).join('')
    if (arch.length) html += head('已归档', 'text-slate-600') + arch.map(row).join('')
    if (!real.length && !arch.length) html = '<div class="p-6 text-center text-slate-500 text-sm">还没有真群会话</div>'
    list.innerHTML = html
    list.querySelectorAll('[data-thread]').forEach(el => {
      el.addEventListener('click', () => {
        location.hash = '#chat'
        setTimeout(() => window.dispatchEvent(new CustomEvent('open-thread', { detail: el.dataset.thread })), 50)
      })
    })
  } catch (e) {
    console.warn('loadThreadOverview', e)
  }
}

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

// ── RAG 记忆库 ──
let ragInfo = null
async function loadRagInfo() {
  const r = await fetch('/api/rag/info')
  const res = await r.json()
  ragInfo = res
  const st = res.status || {}
  const im = res.import || null
  const cfg = res.config || {}
  $('kb-meta').textContent = `vec0 ${st.vecLoaded ? '✓' : '✗'} · ${st.count != null ? fmtNum(st.count) + ' chunk' : '未配置'} · embed ${st.embedOk ? '✓' : '✗'}`

  // 状态（4 张低信息熵卡片，一眼看清）
  const sysParts = [
    (st.vecLoaded ? 'vec0' : 'vec0 ✗'),
    (st.ftsOk ? 'FTS5' : 'FTS5 ✗'),
    (st.embedOk ? 'Embed' : 'Embed ✗'),
  ]
  const allOk = st.vecLoaded && st.ftsOk && st.embedOk
  const spanMonths = im && im.monthly ? im.monthly.length : 0
  const spanYears = im && im.minDate ? `${im.minDate.slice(0, 4)}~${im.maxDate.slice(0, 4)}` : '--'
  const srcNames = im && im.sources ? im.sources.map(s => s.name).join(' / ') : '--'
  const embPctTop = im && im.embeddedTotal ? Math.round((im.embeddedDone / im.embeddedTotal) * 100) : null
  const cards = [
    { label: '系统', value: allOk ? '<span class="text-emerald-400">✓ 就绪</span>' : '<span class="text-amber-400">部分降级</span>', sub: sysParts.join(' · ') },
    { label: 'Chunk', value: im ? fmtNum(im.total) : '--', sub: im ? `${(im.totalChars / 10000).toFixed(1)} 万字` : '库未打开' },
    { label: '跨度', value: spanYears, sub: im ? `${spanMonths} 个月 · ${esc(srcNames)}` : '--' },
    { label: 'Embed 覆盖', value: embPctTop != null ? embPctTop + '%' : '--', sub: im ? `${esc(im.meta?.embedding_dim || '--')} 维` : '--' },
  ]
  $('rag-overview').innerHTML = cards.map(c => `
    <div class="glass round-xl p-3">
      <div class="stat-label">${c.label}</div>
      <div class="stat-value">${c.value}</div>
      <div class="stat-note font-mono">${c.sub}</div>
    </div>`).join('')

  // 编排表单（可编辑，即时生效）
  renderRagForm(cfg)

  const imEl = $('rag-import')
  if (!im || !im.total) {
    imEl.innerHTML = '<div class="text-slate-600">无导入数据（RAG_DB_PATH 未配置或库为空）</div>'
  } else {
    const srcRows = (im.sources || []).map(s => `
      <div class="flex items-center justify-between py-1.5 border-b border-white/5 last:border-0">
        <span class="font-mono text-sky-300">${esc(s.name)}</span>
        <span class="text-slate-400">${fmtNum(s.count)} 块 · ${s.minDate.slice(0, 7)} ~ ${s.maxDate.slice(0, 7)}</span>
      </div>`).join('')
    const maxM = Math.max(...(im.monthly || []).map(x => x.n), 1)
    const bars = (im.monthly || []).map(x => `
      <div class="flex items-center gap-1.5" title="${x.m}：${x.n} 块">
        <span class="text-[9px] text-slate-600 font-mono w-11 shrink-0">${x.m}</span>
        <div class="flex-1 h-3 bg-black/40 rounded-sm overflow-hidden"><div class="h-full bg-cyan-400/60 rounded-sm" style="width:${Math.max(3, Math.round((x.n / maxM) * 100))}%"></div></div>
        <span class="text-[9px] text-slate-500 font-mono w-10 text-right shrink-0">${x.n}</span>
      </div>`).join('')
    imEl.innerHTML = `
      <div class="text-xs text-slate-400 mb-3">共 <span class="font-mono text-slate-200">${fmtNum(im.totalMessages)}</span> 条消息 · <span class="font-mono text-slate-200">${(im.totalChars / 10000).toFixed(1)}</span> 万字 · <span class="font-mono text-slate-200">${im.minDate}</span> ~ <span class="font-mono text-slate-200">${im.maxDate}</span></div>
      <div class="text-[10px] text-slate-500 uppercase tracking-wider mb-1">来源分布</div>
      ${srcRows || '<div class="text-slate-600">无数据</div>'}
      <div class="text-[10px] text-slate-500 uppercase tracking-wider mt-3 mb-1">月度分布（${(im.monthly || []).length} 个月）</div>
      <div class="space-y-1 max-h-52 overflow-y-auto pr-1">${bars}</div>`
  }

  // 连接信息（库 / 端点 —— 改动需重启）
  const conn = [
    ['库路径', cfg.dbPath || '未配置'],
    ['vec0 扩展', cfg.vec0 ? cfg.vec0.split('/').pop() : '未配置'],
    ['Embed 模型', cfg.embedModel || '--'],
    ['Embed 端点', cfg.embedEndpoint || '未配置'],
  ]
  $('rag-config').innerHTML = conn.map(([k, v]) => `
    <div class="flex items-center justify-between gap-3 py-1.5 border-b border-white/5 last:border-0">
      <span class="text-slate-500 shrink-0">${k}</span>
      <span class="font-mono text-slate-300 text-right break-all">${esc(String(v))}</span>
    </div>`).join('')
}

// ── 检索编排表单（可编辑，即时生效）──
function renderRagForm(cfg) {
  const strat = cfg.strategy || ['vec', 'fts', 'like']
  const labelOf = { vec: '向量', fts: '全文', like: '关键词' }
  const el = $('rag-orchestrate')
  if (!el) return

  // 统一气泡：标签 / 控件(flex-1 垂直居中) / 提示(贴底)，整行等高
  const cell = (label, control, hint = '', cls = '') => `
    <div class="glass rounded-xl p-3 flex flex-col h-full min-h-[108px] ${cls}">
      <div class="rag-form-label">${label}</div>
      <div class="flex-1 flex items-center min-h-[30px]">${control}</div>
      ${hint ? `<div class="rag-form-hint">${hint}</div>` : `<div class="rag-form-hint placeholder">&nbsp;</div>`}
    </div>`
  const chip = (cls, attrs, text, on, wide = false) =>
    `<button type="button" class="rag-chip ${cls} ${on ? 'active' : ''} ${wide ? 'w-full' : ''}" ${attrs}>${text}</button>`
  const vp = Math.round((cfg.vecProb || 0) * 100)
  const rp = Math.round((cfg.recallProb || 0) * 100)

  el.innerHTML = `
    <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
      ${cell('注入方式', `
        <div class="grid grid-cols-2 gap-2 w-full">
          ${chip('mode-btn', 'data-mode="false"', '每轮固定', !cfg.toolsEnabled)}
          ${chip('mode-btn', 'data-mode="true"', '工具按需', !!cfg.toolsEnabled)}
        </div>`, '固定=每轮都注入；工具=模型自己决定是否回忆')}
      ${['vec', 'fts', 'like'].map(ch => cell(`${labelOf[ch]}通道`,
        chip('strat-btn', `data-ch="${ch}"`, strat.includes(ch) ? '开' : '关', strat.includes(ch), true),
        ch === 'vec' ? '向量语义相似' : ch === 'fts' ? '全文 BM25' : '关键词 LIKE 兜底',
      )).join('')}
    </div>
    <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mt-3">
      ${cell('向量升级概率', `
        <div class="flex items-center gap-2 w-full">
          <input type="range" id="rag-vp" class="flex-1 accent-indigo-500" min="0" max="100" step="5" value="${vp}">
          <span class="font-mono text-xs text-slate-300 w-9 text-right shrink-0" id="rag-vp-v">${vp}%</span>
        </div>`, '本地有命中时，以该概率额外升级向量（0=只用本地）')}
      ${cell('嵌入上游', `
        <select id="rag-embed-provider" class="rag-select">
          <option value="" ${cfg.embedProvider ? '' : 'selected'}>自动（首个可用）</option>
          ${(cfg.embedProviders || []).map(p => `<option value="${esc(p.id)}" ${cfg.embedProvider === p.id ? 'selected' : ''}>${esc(p.name)} · ${esc(p.embedModel)}</option>`).join('')}
        </select>`, cfg.embedProviders?.length ? '选择做向量化的 provider 上游' : 'providers.json 未配 embedModel')}
      ${cell('本地空时强制向量', chip('fb-btn', '', cfg.vecFallbackOnEmpty ? '开' : '关', !!cfg.vecFallbackOnEmpty, true), '本地无命中就向量兜底')}
      ${cell('每路命中 topK', `<input type="number" id="rag-topk" class="rag-num" min="1" max="50" value="${cfg.topK ?? 3}">`, '每个通道最多取几条')}
    </div>
    <div id="rag-toolbox" class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mt-3 ${cfg.toolsEnabled ? '' : 'hidden'}">
      ${cell('主动回忆概率', `
        <div class="flex items-center gap-2 w-full">
          <input type="range" id="rag-rp" class="flex-1 accent-indigo-500" min="0" max="100" step="5" value="${rp}">
          <span class="font-mono text-xs text-slate-300 w-9 text-right shrink-0" id="rag-rp-v">${rp}%</span>
        </div>`, '工具发起回忆的触发概率')}
      ${cell('工具循环上限', `<input type="number" id="rag-maxiter" class="rag-num" min="1" max="10" value="${cfg.toolMaxIter ?? 2}">`, '单轮最多反复回忆几次')}
      ${cell('每次注入条数', `<input type="number" id="rag-maxitems" class="rag-num" min="1" max="10" value="${cfg.toolMaxItems ?? 1}">`, '每次工具调用取几条')}
      ${cell('单条记忆上限', `<input type="number" id="rag-fact" class="rag-num" min="10" max="500" step="10" value="${cfg.factMaxChars ?? 60}">`, '单条记忆最多多少字')}
    </div>`

  el.querySelectorAll('.mode-btn').forEach(b => b.addEventListener('click', () => {
    const on = b.dataset.mode === 'true'
    el.querySelectorAll('.mode-btn').forEach(x => x.classList.toggle('active', x.dataset.mode === String(on)))
    $('rag-toolbox').classList.toggle('hidden', !on)
  }))
  el.querySelectorAll('.strat-btn').forEach(b => b.addEventListener('click', () => {
    const on = !b.classList.contains('active')
    b.classList.toggle('active', on)
    b.textContent = on ? '开' : '关'
  }))
  const fb = el.querySelector('.fb-btn')
  if (fb) fb.addEventListener('click', () => {
    const on = !fb.classList.contains('active')
    fb.classList.toggle('active', on)
    fb.textContent = on ? '开' : '关'
  })
  $('rag-vp').addEventListener('input', () => { $('rag-vp-v').textContent = $('rag-vp').value + '%' })
  $('rag-rp').addEventListener('input', () => { $('rag-rp-v').textContent = $('rag-rp').value + '%' })
}

// ── 保存编排：即时生效 + 写回 .env ──
async function saveRagConfig() {
  const el = $('rag-orchestrate')
  const strat = [...el.querySelectorAll('.strat-btn.active')].map(b => b.dataset.ch)
  const modeBtn = el.querySelector('.mode-btn.active')
  const body = {
    strategy: strat,
    toolsEnabled: modeBtn ? modeBtn.dataset.mode === 'true' : false,
    vecProb: Number($('rag-vp').value) / 100,
    vecFallbackOnEmpty: !!el.querySelector('.fb-btn') && el.querySelector('.fb-btn').classList.contains('active'),
    topK: Number($('rag-topk').value),
    recallProb: Number($('rag-rp').value) / 100,
    toolMaxIter: Number($('rag-maxiter').value),
    toolMaxItems: Number($('rag-maxitems').value),
    factMaxChars: Number($('rag-fact').value),
    embedProvider: $('rag-embed-provider') ? $('rag-embed-provider').value : '',
  }
  const btn = $('rag-save')
  const note = $('rag-save-note')
  btn.disabled = true
  btn.textContent = '保存中…'
  try {
    const r = await fetch('/api/rag/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const res = await r.json()
    note.textContent = res.ok ? '✓ ' + res.note : '❌ ' + (res.error || '保存失败')
    note.className = 'mt-2 text-xs ' + (res.ok ? 'text-emerald-400' : 'text-red-400')
    if (res.ok) await loadRagInfo()
  } catch (e) {
    note.textContent = '❌ ' + e.message
    note.className = 'mt-2 text-xs text-red-400'
  } finally {
    btn.disabled = false
    btn.textContent = '保存并生效'
  }
}
$('rag-save').addEventListener('click', () => { void saveRagConfig() })

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
  const providers = s.perProvider || {}
  const provLine = Object.entries(providers)
    .filter(([k]) => k !== 'Embed')
    .sort((a, b) => (b[1].cost || 0) - (a[1].cost || 0))
    .map(([k, v]) => `${k} ¥${(v.cost || 0).toFixed(4)}`)
    .join(' · ')
  $('st-cost').textContent = cost > 0 ? '¥' + cost.toFixed(4) : '¥0'
  $('st-cost-sub').innerHTML = (cost > 0
    ? `LLM ¥${(llm.cost || 0).toFixed(4)} · Embed ¥${(embed.cost || 0).toFixed(4)}${provLine ? '<br>' + provLine : ''}`
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
  if (res.active) renderActiveConfig(res.active, res.rag, res.profileMeta)
}

// ── 服务配置 ──
async function loadServiceConfig() {
  const r = await fetch('/api/service/config')
  const res = await r.json()
  if (!res.ok) return
  $('svc-napcat-host').value = res.napcat?.host || ''
  $('svc-napcat-port').value = res.napcat?.port ?? ''
  $('svc-webui-host').value = res.webui?.host || ''
  $('svc-webui-port').value = res.webui?.port ?? ''
  $('svc-real-groups').value = (res.sim?.realGroups || []).join(',')
  $('svc-sim-max').value = res.sim?.maxThreads ?? ''
}
async function saveServiceConfig() {
  const body = {
    napcatHost: $('svc-napcat-host').value.trim(),
    napcatPort: Number($('svc-napcat-port').value),
    webuiHost: $('svc-webui-host').value.trim(),
    webuiPort: Number($('svc-webui-port').value),
    realGroups: $('svc-real-groups').value.trim(),
    simMax: Number($('svc-sim-max').value),
  }
  const r = await fetch('/api/service/config', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  const res = await r.json()
  const note = $('svc-note')
  note.textContent = res.ok ? '✓ ' + res.note : '❌ ' + (res.error || '保存失败')
  note.className = 'text-xs ' + (res.ok ? 'text-emerald-400' : 'text-red-400')
}

// ── 人格配置 ──
async function loadPersonaForm() {
  const r = await fetch('/api/status')
  const res = await r.json()
  const p = res.persona || {}
  $('pf-name').value = p.name || ''
  $('pf-friend').value = p.friendName || ''
  $('pf-wake').value = Array.isArray(p.wakeWords) ? p.wakeWords.join(',') : (p.wakeWords || '')
  $('pf-sys').value = p.systemPromptTemplate || ''
  $('pf-sys-pri').value = p.privateSystemPromptTemplate || ''
  $('pf-shots').value = Array.isArray(p.demoDialogs) ? p.demoDialogs.join('\n') : (p.demoDialogs || '')
}
async function savePersonaConfig() {
  const body = {
    name: $('pf-name').value.trim(),
    friendName: $('pf-friend').value.trim(),
    wakeWords: $('pf-wake').value.trim(),
    systemPrompt: $('pf-sys').value,
    privateSystemPrompt: $('pf-sys-pri').value,
    demoDialogs: $('pf-shots').value,
  }
  const r = await fetch('/api/persona/config', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  const res = await r.json()
  const note = $('persona-save-note')
  note.textContent = res.ok ? '✓ ' + res.note : '❌ ' + (res.error || '保存失败')
  note.className = 'text-xs ' + (res.ok ? 'text-emerald-400' : 'text-red-400')
}

async function loadPresets() {
  const r = await fetch('/api/config/presets')
  const res = await r.json()
  const sel = $('cfg-preset')
  if (!sel || !Array.isArray(res.presets)) return
  sel.innerHTML = res.presets.map(p =>
    `<option value="${esc(p.name)}" title="${esc(p.description)}">${esc(p.label)} — ${esc(p.description)}</option>`
  ).join('')
}

async function postConfigAction(path, body) {
  const r = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  })
  const res = await r.json()
  const note = $('cfg-preset-note')
  if (note) {
    note.textContent = res.ok ? '✓ ' + res.note : '❌ ' + (res.error || '操作失败')
    note.className = 'text-xs ' + (res.ok ? 'text-emerald-400' : 'text-red-400')
  }
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
  const st = hl.replyProb.state || { active: 0, semi: 0, cold: 0, veryCold: 0 }
  const hourly = hl.replyProb.hourly || []
  const bp = hl.replyProb.batchPenalty || { threshold: 0, factor: 1 }
  const pct = (v) => `${Math.round((v || 0) * 100)}%`
  const bars = hourly.length === 24
    ? hourly.map((v, i) => `<div title="${String(i).padStart(2, '0')}:00 ${pct(v)}" style="flex:1;height:${Math.min(100, Math.max(6, Math.round(v * 100)))}%;background:rgba(56,189,248,.55);border-radius:1px"></div>`).join('')
    : ''
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
        <div class="font-mono">N=${cfg.batch.nMin}~${cfg.batch.nMax} T=${(cfg.batch.t/1000).toFixed(0)}s</div>
        <div class="text-slate-600">COOLDOWN ${(hl.cooldown.groupMs/1000).toFixed(0)}s / 私 ${(hl.cooldown.privateMs/1000).toFixed(0)}s</div>
      </div>
      <div class="glass p-3 round-xl">
        <div class="text-slate-500 uppercase mb-1">拟人 · 反应</div>
        <div class="font-mono">${(hl.react.minMs/1000).toFixed(1)}~${(hl.react.maxMs/1000).toFixed(1)}s · ${(hl.react.distribution||[]).length ? '经验分布' : '均匀'}</div>
        <div class="text-slate-600">热聊${pct(st.active)} 半热${pct(st.semi)} 冷${pct(st.cold)} 很冷${pct(st.veryCold)}</div>
      </div>
      <div class="glass p-3 round-xl">
        <div class="text-slate-500 uppercase mb-1">分时段回复</div>
        <div style="display:flex;align-items:flex-end;gap:2px;height:26px">${bars || '<span class="text-slate-600">未导入</span>'}</div>
        <div class="text-slate-600">07 ${pct(hourly[7])} · 08 ${pct(hourly[8])} · 09 ${pct(hourly[9])} · 连发≥${bp.threshold} ×${bp.factor}</div>
      </div>
      <div class="glass p-3 round-xl">
        <div class="text-slate-500 uppercase mb-1">拟人 · 打字</div>
        <div class="font-mono">${hl.typing.charsPerSec.min}~${hl.typing.charsPerSec.max} 字/秒</div>
        <div class="text-slate-600">间隔 ${(hl.typing.segGap.minMs/1000).toFixed(1)}~${(hl.typing.segGap.maxMs/1000).toFixed(1)}s · ${hl.typing.maxSegments ? '最多'+hl.typing.maxSegments+'条' : '条数不限'}</div>
      </div>
      <div class="glass p-3 round-xl">
        <div class="text-slate-500 uppercase mb-1">拟人 · 风格</div>
        <div class="font-mono">${hl.style.maxChars ? '整段≤'+hl.style.maxChars+'字' : '整段不限'} · 单条${hl.style.maxSegmentChars ? '≤'+hl.style.maxSegmentChars+'字' : '不限'}</div>
        <div class="text-slate-600">表情${(hl.style.emojiProb*100).toFixed(0)}% 语气词${(hl.style.fillerProb*100).toFixed(0)}% 错字${(hl.style.typoProb*100).toFixed(0)}%</div>
      </div>
      <div class="glass p-3 round-xl">
        <div class="text-slate-500 uppercase mb-1">拟人 · 节律</div>
        <div class="font-mono">${hl.schedule.quietHours ? esc(hl.schedule.quietHours) : '全天在线'}</div>
        <div class="text-slate-600">半醒 ${hl.schedule.drowsy.length}段 · 主动 ${hl.schedule.proactiveGapMs ? (hl.schedule.proactiveGapMs/60000).toFixed(0)+'min' : '关'}</div>
      </div>
      <div class="glass p-3 round-xl">
        <div class="text-slate-500 uppercase mb-1">画像来源</div>
        <div class="font-mono">${esc(hl.source || 'env')}${profileMeta?.source ? ' → ' + esc(profileMeta.source) : ''}</div>
        <div class="text-slate-600">${profileMeta?.generatedAt ? '挖掘 ' + esc(profileMeta.generatedAt.slice(0, 16).replace('T', ' ')) + ' · 本人' + (profileMeta.sample?.selfText ?? 0) + '条' : '未加载画像，全部用 env'}</div>
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
$('cfg-reload').addEventListener('click', () => { loadConfig(); loadServiceConfig() })
$('cfg-apply-preset')?.addEventListener('click', () => {
  const name = $('cfg-preset').value
  if (!name) return
  if (!confirm('将修改 .env 中相关配置项（自动备份），重启后生效。继续？')) return
  void postConfigAction('/api/config/preset', { name })
})
$('cfg-reset')?.addEventListener('click', () => {
  if (!confirm('恢复默认的触发/节律/近期状态配置（自动备份，保留密钥与其他配置）。继续？')) return
  void postConfigAction('/api/config/reset')
})
$('svc-save')?.addEventListener('click', () => { void saveServiceConfig() })
$('persona-save')?.addEventListener('click', () => { void savePersonaConfig() })

function pct2(v) { return Math.round((v || 0) * 100) + '%' }
const fmtMoney = (v) => (v || 0).toFixed(v > 10 ? 0 : v > 0.1 ? 1 : 2)

// ── 模型管理面板（runtime 热切换）──
let _models = { active: null, providers: [], remote: [] }
let _health = []
async function loadModels() {
  const r = await fetch('/api/models')
  _models = await r.json()
  renderModels()
}
async function loadHealth() {
  const panel = $('model-panels')
  if (panel) panel.classList.add('opacity-60')
  const r = await fetch('/api/models/health')
  _health = (await r.json()).health || []
  if (panel) panel.classList.remove('opacity-60')
  renderModels()
}
function renderModels() {
  const panel = $('model-panels')
  if (!panel) return
  const activeId = _models.active
  const health = Object.fromEntries(_health.map(h => [h.id, h]))
  panel.innerHTML = _models.providers.map(p => {
    const isActive = p.id === activeId
    const h = health[p.id]
    const remoteCount = (_models.remote.find(r => r.providerId === p.id)?.models || []).length
    const price = (p.pricePerMIn || p.pricePerMOut)
      ? `¥${fmtMoney(p.pricePerMIn)}/¥${fmtMoney(p.pricePerMOut)}/M`
      : '未计费'
    const hTag = h
      ? (h.ok
        ? `<span class="text-emerald-400">${h.kind === 'embed' ? '嵌入' : '对话'} ✓ ${fmtMs(h.latencyMs)}</span>`
        : `<span class="text-red-400">✗ ${esc((h.error || '').slice(0, 60))}</span>`)
      : '<span class="text-slate-500">未测</span>'
    return `<div class="glass round-xl p-4 ${isActive ? 'ring-1 ring-primary/50' : ''}">
      <div class="flex items-center justify-between mb-1">
        <div class="font-semibold text-sm flex items-center gap-2">
          ${isActive ? '<span class="badge badge-primary badge-sm">活跃</span>' : ''}
          ${esc(p.name)}
        </div>
        <span class="text-xs font-mono text-slate-500">${esc(p.model)}</span>
      </div>
      <div class="text-xs text-slate-500 mb-2 font-mono break-all">${esc(p.baseUrl || '官方')} · ${price} · 远端 ${remoteCount} 模型</div>
      <div class="flex items-center gap-2 flex-wrap">
        ${hTag}
        <button class="btn btn-xs btn-ghost" onclick="testModel('${esc(p.id)}', this)">测试</button>
        ${isActive
          ? '<span class="text-xs text-slate-500">fallback: ' + esc((p.fallback || []).join(', ') || '无') + '</span>'
          : `<button class="btn btn-xs btn-primary" onclick="switchModel('${esc(p.id)}', this)">切换使用</button>`}
      </div>
    </div>`
  }).join('')
}
async function switchModel(id, btn) {
  if (btn) { btn.disabled = true; btn.textContent = '切换中...' }
  const r = await fetch('/api/models/switch', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }),
  })
  const res = await r.json()
  const note = $('model-note')
  if (res.ok) {
    note.textContent = `✓ 已切换活跃模型 → ${_models.providers.find(p => p.id === id)?.name}`
    note.className = 'mt-3 text-xs text-emerald-400'
    await loadModels()
  } else {
    note.textContent = '❌ ' + (res.error || '切换失败')
    note.className = 'mt-3 text-xs text-red-400'
    if (btn) { btn.disabled = false; btn.textContent = '切换使用' }
  }
}
async function testModel(id, btn) {
  if (btn) { btn.disabled = true; btn.textContent = '测试中...' }
  const r = await fetch('/api/models/test', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }),
  })
  const res = await r.json()
  const note = $('model-note')
  if (res.ok) {
    note.textContent = `✓ ${id} 可用，耗时 ${fmtMs(res.latencyMs)}`
    note.className = 'mt-3 text-xs text-emerald-400'
  } else {
    note.textContent = `❌ ${id}: ${esc(res.error || '不可用')}`
    note.className = 'mt-3 text-xs text-red-400'
  }
  await loadHealth()
  if (btn) { btn.disabled = false; btn.textContent = '测试' }
}

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
loadPresets()
void loadRagInfo()
loadModels()
void loadThreadOverview()
window.testModel = testModel
window.switchModel = switchModel
$('model-refresh')?.addEventListener('click', () => { void loadModels() })
$('model-check')?.addEventListener('click', () => { void loadHealth() })
$('ov-goto-chat')?.addEventListener('click', () => { document.querySelector('.side-item[data-page="chat"]')?.click() })
setInterval(() => { $('footer-time').textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false }) }, 1000)

// 首次状态（SSE 会推，兜底拉一次）
fetch('/api/state').then((r) => r.json()).then((snap) => renderState(snap)).catch(() => {})

// 当前页对应数据（/console 或带 hash 进入）
const curPage = document.querySelector('.side-item.active')?.dataset.page
if (curPage === 'config') loadServiceConfig()
if (curPage === 'persona') { loadPersonaForm(); loadPresets() }
if (location.hash === '#chat') document.querySelector('.side-item[data-page="chat"]')?.click()
