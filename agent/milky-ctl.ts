import { spawn, execSync, type ChildProcess } from 'node:child_process'
import { watch, readFileSync, readdirSync, existsSync, openSync, type FSWatcher } from 'node:fs'
import { join } from 'node:path'

const MILKY_BIN = process.env.MILKY_BIN || '/opt/qqbot/Lagrange.Milky'
const MILKY_DIR = process.env.MILKY_DIR || '/opt/qqbot'
const MILKY_LOG = process.env.MILKY_LOG || '/tmp/milky-arm64.log'
const QR_TTL_MS = 150_000

export interface MilkyStatus {
  running: boolean
  managed: boolean
  loggedIn: boolean
  pid: number | null
  loginUrl: string | null
  qrTs: number | null
  qrExpired: boolean | null
  qrDataUrl: string | null
  milkyBin: string
  state: 'running' | 'crashed' | 'idle'
}

type Listener = (s: MilkyStatus) => void

/**
 * Milky 控制：全事件驱动，零轮询。
 * - milky 由 agent spawn（一切都让 agent 控制），崩了 exit 事件 → 状态"崩溃"，等用户手动拉起（不自动重启，防吃电/刷 eMMC）
 * - fs.watch（inotify）监听 qrcode.png（新码）与 *.ks（登录成功）——文件事件非轮询
 * - 状态全在内存，status() 零轮询；SSE 推给 /milky 面板
 */
class MilkyCtl {
  private child: ChildProcess | null = null
  private loginUrl: string | null = null
  private qrTs = 0
  private qrDataUrl: string | null = null
  private loggedIn = false
  private crashed = false
  private started = false
  private listeners = new Set<Listener>()
  private watchers: FSWatcher[] = []
  private onLoginCb: (() => void) | null = null

  private snapshot(): MilkyStatus {
    const running = this.child !== null && this.child.exitCode === null
    const qrExpired = this.qrTs ? Date.now() - this.qrTs > QR_TTL_MS : null
    return {
      running,
      managed: this.child !== null,
      loggedIn: this.loggedIn,
      pid: this.child?.pid ?? null,
      loginUrl: this.loginUrl,
      qrTs: this.qrTs || null,
      qrExpired,
      qrDataUrl: this.qrDataUrl,
      milkyBin: MILKY_BIN,
      state: running ? 'running' : this.crashed ? 'crashed' : 'idle',
    }
  }

  private emit(): void {
    const s = this.snapshot()
    for (const l of this.listeners) l(s)
  }

  /** /milky 面板订阅状态推送（SSE） */
  subscribe(l: Listener): () => void {
    this.listeners.add(l)
    return () => { this.listeners.delete(l) }
  }

  /** 登录成功（.ks 写入）事件回调——index.ts 用来触发 MilkyTransport 重连 */
  onLogin(cb: () => void): void {
    this.onLoginCb = cb
  }

  /** agent 启动：注册文件监听（事件驱动）+ 刷新已有状态。非轮询，只跑一次 */
  init(): void {
    if (this.started) return
    this.started = true
    this.refreshLoggedIn()
    this.readQr()
    this.watch()
  }

  private refreshLoggedIn(): void {
    try {
      this.loggedIn = readdirSync(MILKY_DIR).some(f => f.endsWith('.ks'))
    } catch {
      this.loggedIn = false
    }
  }

  /** 读 milky 画的二维码图（OnQrCode 写 qrcode.png），base64 直供面板，无需 URL/QR 库 */
  private readQr(): void {
    try {
      const p = join(MILKY_DIR, 'qrcode.png')
      if (!existsSync(p)) return
      const b64 = readFileSync(p).toString('base64')
      this.qrDataUrl = `data:image/png;base64,${b64}`
      this.qrTs = Date.now()
    } catch {
      /* 图未就绪时忽略 */
    }
  }

  private watch(): void {
    try {
      // 只 watch 目录（单个文件不存在会 ENOENT 中断）：qrcode.png 新码、*.ks 登录，都在目录里
      const kw = watch(MILKY_DIR, { persistent: false }, (_ev, fname) => {
        if (!fname) return
        if (fname === 'qrcode.png') {
          this.readQr()
          this.emit()
        } else if (fname.endsWith('.ks')) {
          const prev = this.loggedIn
          this.refreshLoggedIn()
          if (this.loggedIn && !prev) this.onLoginCb?.() // 登录成功 → 通知重连 3000
          this.emit()
        }
      })
      this.watchers.push(kw)
    } catch {
      /* inotify 不可用时静默（面板仍可用 status 兜底） */
    }
  }

  /** agent 全控制：杀掉不归本实例管的旧 milky（agent 重启后的孤儿），保证 spawn 的是自己 */
  private ensureNoOld(): void {
    try {
      const out = execSync(`pgrep -f '^${MILKY_BIN}$'`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
      for (const line of out.split('\n').filter(Boolean)) {
        const p = parseInt(line, 10)
        if (p && p !== process.pid) {
          try { execSync(`kill -9 ${p}`, { stdio: 'ignore' }) } catch { /* 已死 */ }
        }
      }
    } catch {
      /* 无旧进程 */
    }
  }

  /** 手动/启动拉起 milky（agent spawn，全控制） */
  start(): void {
    if (this.child && this.child.exitCode === null) return
    this.ensureNoOld()
    let logFd: number | null = null
    try { logFd = openSync(MILKY_LOG, 'a') } catch { /* 日志不可写时忽略 */ }
    const child = spawn(MILKY_BIN, [], {
      cwd: MILKY_DIR,
      detached: true, // milky 独立进程组：agent 退出不影响 milky 运行；agent 重启 ensureNoOld 接管
      stdio: ['ignore', logFd ?? 'ignore', logFd ?? 'ignore'],
    })
    if (logFd != null) { /* fd 由子进程继承，父进程关闭句柄 */ }
    child.unref()
    this.child = child
    this.crashed = false
    this.loginUrl = null
    this.qrTs = 0
    child.on('exit', () => {
      if (this.child === child) this.crashed = true
      this.emit() // 崩溃事件 → 面板显示"崩溃"，等用户手动拉起（不自动重启）
    })
    child.on('error', () => {
      if (this.child === child) this.crashed = true
      this.emit()
    })
    this.emit()
  }

  /** 手动停止 */
  stop(): void {
    if (this.child && this.child.exitCode === null) {
      try { execSync(`kill -9 ${this.child.pid}`, { stdio: 'ignore' }) } catch { /* 已死 */ }
    }
  }

  /** 手动重启（/milky 页按钮）——用户手动拉起，一次 */
  restart(): void {
    this.stop()
    setTimeout(() => this.start(), 600)
  }

  /** 零轮询：状态全在内存，直接返回快照 */
  status(): Promise<MilkyStatus> {
    return Promise.resolve(this.snapshot())
  }

  /** 是否已登录过（.ks 存在）。有登录态 agent 启动自动拉起恢复在线；无登录态等用户手动触发，不白挂进程 */
  hasLogin(): boolean {
    return this.loggedIn
  }
}

export const milkyCtl = new MilkyCtl()

export const MILKY_HTML = `<!DOCTYPE html>
<html lang="zh" data-theme="dark">
<head>
<meta charset="utf-8">
<title>Milky 管理</title>
<style>
:root{color-scheme:dark}
body{font-family:system-ui,sans-serif;background:#111;color:#ddd;margin:0;padding:20px;max-width:560px}
h1{font-size:18px;margin:0 0 12px}
.card{background:#1a1a1a;border:1px solid #2a2a2a;border-radius:10px;padding:14px;margin:10px 0}
.row{display:flex;align-items:center;gap:8px;margin:6px 0;font-size:14px}
.dot{display:inline-block;width:9px;height:9px;border-radius:50%}
.ok{background:#4caf50}.bad{background:#f44336}.warn{background:#ff9800}
button{background:#333;color:#fff;border:1px solid #555;padding:8px 14px;border-radius:6px;cursor:pointer;font-size:13px}
button:hover{background:#444}
#qr img{width:260px;height:260px;image-rendering:pixelated;border-radius:6px;background:#fff;padding:6px}
code{word-break:break-all;font-size:11px;color:#999}
</style>
</head>
<body>
<h1>Milky 管理</h1>
<div class="card">
  <div class="row"><span class="dot" id="dRun"></span>进程 <span id="run">—</span></div>
  <div class="row"><span class="dot" id="dLogin"></span>登录 <span id="login">—</span></div>
  <div class="row"><code id="pid"></code></div>
</div>
<div class="card" id="qrCard">
  <div id="qrTitle">—</div>
  <div id="qrImg"></div>
</div>
<div class="card">
  <button id="btnRestart">拉起/重启 Milky</button>
</div>
<script>
const $=id=>document.getElementById(id);
const set=(id,txt)=>$(id).textContent=txt;
const dot=(id,ok)=>$(id).className='dot '+(ok?'ok':'bad');
function render(s){
  const running=s.running, loggedIn=s.loggedIn;
  set('run',running?(s.state==='running'?'运行中':'…'):(s.state==='crashed'?'已崩溃（手动拉起）':'未运行'));
  set('login',loggedIn?'已登录':'未登录');
  dot('dRun',running);dot('dLogin',loggedIn);
  set('pid',s.pid?'pid '+s.pid:s.milkyBin);
  if(loggedIn){set('qrTitle','已登录，无需扫码');$('qrImg').innerHTML='';}
  else if(s.qrDataUrl){
    set('qrTitle','用手机 QQ 扫码登录（勾「下次登录无需确认」）：');
    $('qrImg').innerHTML='<img src="'+s.qrDataUrl+'">';
  } else {
    set('qrTitle',running?'等待 Milky 输出二维码…':'Milky 未运行，点「拉起/重启」');
    $('qrImg').innerHTML='';
  }
}
// SSE 事件流：状态变化由 agent 推送，零轮询
const es=new EventSource('/api/milky/stream');
es.onmessage=e=>{try{render(JSON.parse(e.data))}catch{}};
// 打开先拿一次当前状态（单次，非轮询）
fetch('/api/milky/status').then(r=>r.json()).then(render).catch(()=>{});
$('btnRestart').onclick=async()=>{
  $('btnRestart').disabled=true;
  try{await fetch('/api/milky/restart',{method:'POST'})}catch{}
  setTimeout(()=>{$('btnRestart').disabled=false},1500);
};
</script>
</body>
</html>`
