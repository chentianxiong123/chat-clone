import { execSync } from 'node:child_process'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import net from 'node:net'
import QRCode from 'qrcode'

const MILKY_BIN = process.env.MILKY_BIN || '/opt/qqbot/Lagrange.Milky'
const MILKY_DIR = process.env.MILKY_DIR || '/opt/qqbot'
const MILKY_LOG = process.env.MILKY_LOG || '/tmp/milky-arm64.log'
const MILKY_PORT = Number(process.env.MILKY_PORT || 3000)
const QR_TTL_MS = 150_000

export interface MilkyStatus {
  running: boolean
  listening: boolean
  loggedIn: boolean
  pid: number | null
  loginUrl: string | null
  qrTs: number | null
  qrExpired: boolean | null
  qrDataUrl: string | null
  milkyBin: string
  logTail: string[]
}

class MilkyCtl {
  private loginUrl: string | null = null
  private qrTs = 0

  private pid(): number | null {
    try {
      // 精确匹配真实 milky 可执行路径（模糊匹配会误伤 npm/sh/agent 等含 "Lagrange.Milky" 字符串的进程，
      // 导致 start() 误判已在跑而不启动）
      const out = execSync(`pgrep -f '^${MILKY_BIN}$'`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
      const p = parseInt(out.split('\n')[0], 10)
      return Number.isFinite(p) ? p : null
    } catch {
      return null
    }
  }

  private listening(): Promise<boolean> {
    return new Promise(resolve => {
      const sock = net.connect({ host: '127.0.0.1', port: MILKY_PORT })
      const done = (ok: boolean): void => { sock.destroy(); resolve(ok) }
      sock.setTimeout(800)
      sock.once('connect', () => done(true))
      sock.once('error', () => done(false))
      sock.once('timeout', () => done(false))
    })
  }

  private ksFile(): string | null {
    try {
      return readdirSync(MILKY_DIR).find(f => f.endsWith('.ks')) ?? null
    } catch {
      return null
    }
  }

  /** 读 Milky 日志，抓登录 URL（日志很小，直接全读） */
  private scanLog(): void {
    try {
      if (!existsSync(MILKY_LOG)) return
      const text = readFileSync(MILKY_LOG, 'utf8')
      const m = text.match(/URL:\s*(https:\/\/txz\.qq\.com\/p\?k=[^\s]+)/)
      if (m) {
        this.loginUrl = m[1]
        this.qrTs = Date.now()
      }
    } catch { /* 日志不可读时忽略 */ }
  }

  private tail(n: number): string[] {
    try {
      if (!existsSync(MILKY_LOG)) return []
      return readFileSync(MILKY_LOG, 'utf8').split('\n').filter(Boolean).slice(-n)
    } catch {
      return []
    }
  }

  async start(): Promise<void> {
    if (this.pid()) return
    // 与 AGENTS.md 后台长驻规则一致：setsid nohup + 输出重定向。
    // 注意不能用 disown（手机 /bin/sh 是 dash，无 disown 会 execSync 抛错）；
    // setsid 已保证脱离会话/进程组，disown 冗余。
    execSync(`setsid nohup ${MILKY_BIN} > ${MILKY_LOG} 2>&1 < /dev/null &`, {
      cwd: MILKY_DIR,
      stdio: 'ignore',
    })
    this.loginUrl = null
    this.qrTs = 0
  }

  async stop(): Promise<void> {
    const p = this.pid()
    if (p) {
      try { execSync(`kill -9 ${p}`, { stdio: 'ignore' }) } catch { /* 已死 */ }
    }
  }

  async restart(): Promise<void> {
    await this.stop()
    await new Promise(r => setTimeout(r, 800))
    await this.start()
  }

  async status(): Promise<MilkyStatus> {
    this.scanLog()
    const running = this.pid() !== null
    const listening = await this.listening()
    const qrExpired = this.qrTs ? Date.now() - this.qrTs > QR_TTL_MS : null
    let qrDataUrl: string | null = null
    if (this.loginUrl && !qrExpired) {
      try {
        qrDataUrl = await QRCode.toDataURL(this.loginUrl, { width: 300, margin: 1 })
      } catch { /* QR 生成失败则前端用 URL 兜底 */ }
    }
    return {
      running,
      listening,
      loggedIn: this.ksFile() !== null,
      pid: this.pid(),
      loginUrl: this.loginUrl,
      qrTs: this.qrTs || null,
      qrExpired,
      qrDataUrl,
      milkyBin: MILKY_BIN,
      logTail: this.tail(10),
    }
  }

  /** agent 启动时调用：Milky 没跑就拉起（触发协议端） */
  autoEnsure(): void {
    void (async () => {
      const listening = await this.listening()
      const running = this.pid() !== null
      if (!listening && !running) {
        console.log(`[MilkyCtl] Milky 未运行，自动拉起: ${MILKY_BIN}`)
        await this.start()
      }
    })()
  }
}

export const milkyCtl = new MilkyCtl()

export const MILKY_HTML = `<!DOCTYPE html>
<html lang="zh" data-theme="dark">
<head>
<meta charset="utf-8">
<title>Milky 控制台</title>
<style>
:root{color-scheme:dark}
body{font-family:system-ui,sans-serif;background:#111;color:#ddd;margin:0;padding:20px;max-width:640px}
h1{font-size:20px}
.card{background:#1a1a1a;border:1px solid #2a2a2a;border-radius:10px;padding:16px;margin:12px 0}
.dot{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:6px}
.ok{background:#4caf50}.bad{background:#f44336}.warn{background:#ff9800}
button{background:#333;color:#fff;border:1px solid #555;padding:8px 14px;border-radius:6px;cursor:pointer;font-size:14px}
button:hover{background:#444}
#qr img{width:300px;height:300px;image-rendering:pixelated;border-radius:6px}
a{color:#64b5f6}
code{word-break:break-all;font-size:12px}
.log{background:#000;border:1px solid #2a2a2a;border-radius:6px;padding:10px;font-family:monospace;font-size:12px;max-height:220px;overflow:auto;white-space:pre-wrap}
</style>
</head>
<body>
<h1>Milky 控制台</h1>
<div class="card">
  <div><span class="dot" id="dRunning"></span>进程 <span id="running"></span></div>
  <div><span class="dot" id="dListen"></span>端口 <span id="listen"></span></div>
  <div><span class="dot" id="dLogin"></span>登录 <span id="login"></span></div>
  <div style="margin-top:8px"><code id="pid"></code></div>
</div>
<div class="card" id="qr">
  <div id="qrTitle"></div>
  <div id="qrImg"></div>
  <div style="margin-top:8px"><code id="qrUrl"></code></div>
</div>
<div class="card">
  <button id="btnRestart">重启 Milky（重新出码）</button>
  <button id="btnRefresh" style="margin-left:8px">刷新</button>
</div>
<div class="card"><div class="log" id="log"></div></div>
<script>
async function refresh(){
  try{
    const r=await fetch('/api/milky/status');const s=await r.json();
    const set=(id,txt)=>{document.getElementById(id).textContent=txt};
    const dot=(id,ok)=>document.getElementById(id).className='dot '+(ok?'ok':'bad');
    set('running',s.running?'是':'否');set('listen',s.listening?'是':'否');set('login',s.loggedIn?'已登录':'未登录');
    dot('dRunning',s.running);dot('dListen',s.listening);dot('dLogin',s.loggedIn);
    set('pid',s.pid?'pid '+s.pid:s.milkyBin);
    if(s.loggedIn){set('qrTitle','已登录，无需扫码');document.getElementById('qrImg').innerHTML='';set('qrUrl','');}
    else if(s.qrDataUrl){
      document.getElementById('qrTitle').textContent='用手机 QQ 扫码登录：';
      document.getElementById('qrImg').innerHTML='<img src="'+s.qrDataUrl+'">';
      set('qrUrl',s.loginUrl||'');
    } else if(s.qrExpired){
      document.getElementById('qrTitle').textContent='二维码已过期，点「重启 Milky」重新出码';
      document.getElementById('qrImg').innerHTML='';set('qrUrl','');
    } else {
      document.getElementById('qrTitle').textContent=s.running?'等待 Milky 输出登录码…':'Milky 未运行，点「重启 Milky」';
      document.getElementById('qrImg').innerHTML='';set('qrUrl','');
    }
    set('log',(s.logTail||[]).join('\\n'));
  }catch(e){set('log','状态获取失败: '+e)}
}
document.getElementById('btnRestart').onclick=async()=>{
  document.getElementById('btnRestart').disabled=true;
  await fetch('/api/milky/restart',{method:'POST'});
  setTimeout(()=>{document.getElementById('btnRestart').disabled=false;refresh()},1500);
};
document.getElementById('btnRefresh').onclick=refresh;
refresh();setInterval(refresh,3000);
</script>
</body>
</html>`
