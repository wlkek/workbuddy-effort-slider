/* WorkBuddy mod injector
 * ------------------------------------------------------------------
 * 为什么不用 NODE_OPTIONS：Electron 打包应用只放行 NODE_OPTIONS 的一个白名单
 * （内存、证书、警告类），`--require` 不在里面。
 *
 * 这里用 `--inspect`：NodeCliInspect fuse 是开的，启动开关不会被过滤。
 * 流程：
 *   1. 以 Node 模式跑本脚本（快捷方式直接调用客户端自带的 node.exe）
 *   2. spawn 真正的客户端，带 --inspect=<随机端口>
 *   3. 连上主进程 inspector，Runtime.evaluate 一段 bootstrap
 *   4. bootstrap 挂 web-contents-created，把 mods 注入主界面
 *   5. 主进程里再起一个只监听 127.0.0.1 的小 HTTP 服务，给需要读本地数据的 mod 用
 *   6. 注入成功后从主进程里关掉 inspector，端口不留在外面
 *
 * 本脚本自身不常驻：注入完就退出。
 */
'use strict';

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, 'mods');
const LOG = path.join(process.env.LOCALAPPDATA || __dirname, 'WbMods', 'loader.log');
let CFG = {};
try { CFG = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')); } catch (e) { /* ignore */ }

/* 客户端位置：环境变量 > 上次成功的路径 > 安装时探测到的全部候选。
 * 安装器会把每个能命中 resources\app.asar 的目录都写进 candidates，
 * 所以客户端换了盘符或目录，这里仍能自己找回去，不必重装。 */
function resolveApp() {
  const tries = [];
  if (process.env.WB_APP_EXE) tries.push(process.env.WB_APP_EXE);
  if (CFG.app) tries.push(CFG.app);
  if (Array.isArray(CFG.candidates)) {
    for (const p of CFG.candidates) tries.push(p);
  }
  for (const p of tries) {
    try {
      if (p && fs.existsSync(p)) return p;
    } catch (e) { /* ignore */ }
  }
  return '';
}
const APP = resolveApp();

function log() {
  try {
    const parts = [];
    for (const a of arguments) parts.push(typeof a === 'string' ? a : JSON.stringify(a));
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    fs.appendFileSync(LOG, '[' + new Date().toISOString() + '] injector ' + parts.join(' ') + '\n');
  } catch (e) { /* ignore */ }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

function getJSON(url, timeout = 1500) {
  return new Promise((resolve) => {
    const req = require('http').get(url, { timeout }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(buf)); } catch (e) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

function waitForTarget(port, deadline) {
  return new Promise((resolve) => {
    const tick = async () => {
      const list = await getJSON(`http://127.0.0.1:${port}/json/list`);
      if (Array.isArray(list) && list.length) {
        const t = list.find((x) => x.webSocketDebuggerUrl) || list[0];
        if (t) return resolve(t);
      }
      if (Date.now() > deadline) return resolve(null);
      setTimeout(tick, 200);
    };
    tick();
  });
}

/* 在主进程里执行的 bootstrap。故意全用 ES5，避免上下文差异。 */
function buildBootstrap(modsRoot, logPath) {
  return `(function(){
  try {
    if (globalThis.__WB_BOOTSTRAP_DONE) return Promise.resolve('OK:already');

    var req = (typeof require === 'function') ? require
      : (process.mainModule && process.mainModule.require
          ? process.mainModule.require.bind(process.mainModule) : null);
    if (!req) return Promise.resolve('ERR:no-require');

    var electron = req('electron');
    if (!electron || !electron.app) return Promise.resolve('ERR:no-app');

    var fs = req('fs'), path = req('path');
    var ROOT = ${JSON.stringify(modsRoot)};
    var LOG = ${JSON.stringify(logPath)};
    function log(m) { try { fs.appendFileSync(LOG, '[' + new Date().toISOString() + '] main ' + m + '\\n'); } catch (e) {} }

    var mods = [];
    try {
      fs.readdirSync(ROOT).forEach(function (id) {
        try {
          var dir = path.join(ROOT, id);
          var meta = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
          if (meta.enabled === false) return;
          var files = (Array.isArray(meta.files) && meta.files.length) ? meta.files : [meta.main || 'mod.js'];
          var src = '';
          files.forEach(function (f) { src += fs.readFileSync(path.join(dir, f), 'utf8') + String.fromCharCode(10); });
          mods.push({
            id: id,
            v: meta.version || '',
            src: src,
            server: meta.server ? path.join(dir, meta.server) : ''
          });
        } catch (e) { log('bad mod ' + id + ': ' + e.message); }
      });
    } catch (e) { return Promise.resolve('ERR:scan:' + e.message); }

    /* 声明了 server 的 mod：拿到一个对象，call(op, args) 返回 Promise。
     * 老的函数式导出仍然兼容。 */
    var handlers = {};
    mods.forEach(function (m) {
      if (!m.server) return;
      try {
        var api = req(m.server);
        if (typeof api === 'function') {
          handlers[m.id] = { legacy: api };
        } else if (api && typeof api.call === 'function') {
          handlers[m.id] = api;
          if (typeof api.start === 'function') {
            try { api.start(); } catch (e) { log('server start fail ' + m.id + ': ' + e.message); }
          }
        }
        log('server loaded ' + m.id);
      } catch (e) { log('server load fail ' + m.id + ': ' + e.message); }
    });

    /* 主界面入口：5.9.2+ 在 app.asar 里，5.8.x 是解包目录，都按路径结尾判断。
     * 这里必须用字符串比较：正则里的 \/ 会被模板字符串吃成 /，整行变成注释。 */
    var TAIL = '/renderer/index.html';
    function isTarget(u) {
      if (typeof u !== 'string') return false;
      var s = u.split('#')[0].split('?')[0].toLowerCase();
      return s.length > TAIL.length && s.slice(-TAIL.length) === TAIL;
    }

    function reply(wc, rid, payload) {
      var js = 'try{window.__WB_CTX_ON_REPLY&&window.__WB_CTX_ON_REPLY(' +
        JSON.stringify(rid) + ',' + JSON.stringify(payload) + ')}catch(e){}';
      try { wc.executeJavaScript(js, true).catch(function () {}); } catch (e) {}
    }

    function progress(wc, rid, p) {
      var js = 'try{window.__WB_CTX_ON_PROGRESS&&window.__WB_CTX_ON_PROGRESS(' +
        JSON.stringify(rid) + ',' + JSON.stringify(p) + ')}catch(e){}';
      try { wc.executeJavaScript(js, true).catch(function () {}); } catch (e) {}
    }

    function handle(wc, r) {
      if (!r || !r.op) return;
      var h = handlers[r.mod] || handlers['context-panel'];
      if (!h) { reply(wc, r.rid, { ok: false, error: '没有可用的数据处理器' }); return; }
      var p;
      try {
        if (h.call) {
          p = h.call(r.op, r.args || {}, function (pr) { progress(wc, r.rid, pr); });
        } else {
          p = h.legacy([r.op], r.args || {});
        }
      } catch (e) {
        reply(wc, r.rid, { ok: false, error: String((e && e.message) || e) });
        return;
      }
      Promise.resolve(p).then(function (v) {
        reply(wc, r.rid, { ok: true, data: v });
      }).catch(function (e) {
        reply(wc, r.rid, { ok: false, error: String((e && e.message) || e) });
      });
    }

    /* 反向通道：页面调用 window.__WB_CTX_PUSH(req)，主进程这边 Promise 收到。
     * 不用轮询，也就不用每秒往页面里塞一次求值。 */
    function arm(wc) {
      try {
        wc.executeJavaScript('new Promise(function(res){window.__WB_CTX_PUSH=res;})', true)
          .then(function (r) { handle(wc, r); arm(wc); })
          .catch(function () { setTimeout(function () { arm(wc); }, 1500); });
      } catch (e) { log('arm fail: ' + e.message); }
    }

    function inject(wc) {
      var url = '';
      try { url = wc.getURL() || ''; } catch (e) { return; }
      if (!isTarget(url)) {
        /* 只记本地页面，免得 devtools 之类刷屏；同一个 URL 只记一次 */
        if (url.indexOf('file:') === 0 && wc.__wbSkipUrl !== url) {
          wc.__wbSkipUrl = url;
          log('skip wc ' + url.slice(0, 90));
        }
        return;
      }
      if (wc.__wbInjected) return;
      wc.__wbInjected = true;
      log('target wc ' + url.slice(0, 90));

      mods.forEach(function (m) {
        wc.executeJavaScript(m.src, true)
          .then(function () { log('injected ' + m.id + '@' + m.v); })
          .catch(function (e) { log('inject fail ' + m.id + ': ' + ((e && e.message) || e)); });
      });
      arm(wc);
    }

    /* 每个 webContents 只挂一次；窗口可能在 bootstrap 之前就建好，
     * 那 dom-ready 已经错过，所以下面还会做一轮兜底扫描。 */
    function hook(wc) {
      if (!wc || wc.__wbHooked) return;
      wc.__wbHooked = true;
      try {
        wc.on('did-start-loading', function () { wc.__wbInjected = false; });
        wc.on('dom-ready', function () { inject(wc); });
        wc.on('did-finish-load', function () { inject(wc); });
      } catch (e) { log('hook fail: ' + ((e && e.message) || e)); }
    }

    electron.app.on('web-contents-created', function (_e, wc) { hook(wc); });
    try {
      electron.webContents.getAllWebContents().forEach(function (wc) {
        hook(wc);
        inject(wc);
      });
    } catch (e) {}

    var wbScan = setInterval(function () {
      try {
        electron.webContents.getAllWebContents().forEach(function (wc) {
          hook(wc);
          inject(wc);
        });
      } catch (e) {}
    }, 800);
    setTimeout(function () { clearInterval(wbScan); }, 60000);

    log('bootstrap ok, mods=' + mods.length + ', servers=' + Object.keys(handlers).length);

    /* 留一点时间让页面把请求发过来，再把 inspector 关掉 */
    setTimeout(function () {
      try { req('inspector').close(); log('inspector closed'); }
      catch (e) { log('inspector close failed: ' + e.message); }
    }, 4000);

    globalThis.__WB_BOOTSTRAP_DONE = true;
    return Promise.resolve('OK mods=' + mods.length + ' servers=' + Object.keys(handlers).length);
  } catch (e) { return Promise.resolve('ERR:' + ((e && e.message) || e)); }
})()`;
}

/* 在主进程里求值。每条消息用自增 id，避免重试时撞号。 */
let evalSeq = 0;

function evaluateOnce(ws, expr, timeoutMs) {
  const id = ++evalSeq;
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.removeEventListener('message', onMsg);
      ws.removeEventListener('error', onErr);
      ws.removeEventListener('close', onClose);
      resolve(v);
    };
    const timer = setTimeout(() => done({ timeout: true }), timeoutMs);
    const onMsg = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.id !== id) return;
      done(m.result || {});
    };
    const onErr = () => done({ ioError: true });
    const onClose = () => done({ closed: true });
    ws.addEventListener('message', onMsg);
    ws.addEventListener('error', onErr);
    ws.addEventListener('close', onClose);
    try {
      ws.send(JSON.stringify({
        id: id,
        method: 'Runtime.evaluate',
        params: {
          expression: expr,
          includeCommandLineAPI: true,
          returnByValue: true,
          awaitPromise: true,
        },
      }));
    } catch (e) {
      done({ ioError: true });
    }
  });
}

function openWs(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  return new Promise((resolve) => {
    let done = false;
    const fin = () => { if (!done) { done = true; resolve(ws); } };
    if (ws.readyState === 1) return fin();
    ws.addEventListener('open', fin);
    ws.addEventListener('error', fin);
    setTimeout(fin, 3000);
  });
}

/* 一次求值的结果说人话，失败时日志能直接看出是超时、异常还是上下文没起来 */
function describe(r) {
  if (!r) return 'no-result';
  if (r.timeout) return 'timeout';
  if (r.closed) return 'socket-closed';
  if (r.ioError) return 'io-error';
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    return 'exception: ' + String((d.exception && (d.exception.description || d.exception.value)) || d.text || '').slice(0, 120);
  }
  const v = r.result && r.result.value;
  return 'value=' + JSON.stringify(v);
}

/* 客户端刚 spawn 时 inspector 端口先开，Node 环境还没起来，这段时间求值会超时；
 * 窗口重建时连接还可能失效。所以每轮都重新取 target，必要时换一条连接。
 * 返回 { ws, ok }：成功时把连接交回去，让调用方在同一条连接上跑 bootstrap。 */
async function waitForMainReady(port, budgetMs) {
  const deadline = Date.now() + (budgetMs || 90000);
  const expr = 'typeof require === "function" ? "yes" : "no"';
  let ws = null;
  let last = 'not-started';
  let n = 0;

  while (Date.now() < deadline) {
    if (!ws || ws.readyState > 1) {
      const t = await waitForTarget(port, Date.now() + 3000);
      if (!t) {
        last = 'no-target';
      } else {
        ws = await openWs(t);
      }
    }

    if (!ws || ws.readyState !== 1) {
      last = 'no-connection';
    } else {
      const r = await evaluateOnce(ws, expr, 4000);
      if (r && r.result && r.result.value === 'yes') {
        log('main ready, attempts=' + n);
        return { ws: ws, ok: true, last: 'ready' };
      }
      last = describe(r);
      /* 连接已经不可用，下一轮重新找 target */
      if (r && (r.closed || r.ioError)) {
        try { ws.close(); } catch (e) { /* ignore */ }
        ws = null;
      }
    }

    n += 1;
    log('wait main #' + n + ' => ' + last);
    await new Promise((res) => setTimeout(res, 400));
  }

  log('main not ready after ' + n + ' attempts: ' + last);
  return { ws: ws, ok: false, last: last };
}

/* 注入器互斥：用户连点两下图标时，第二个实例会再 spawn 一次客户端，
 * 单实例锁会让它立刻退出，但那一轮注入就白等了。 */
const LOCK = path.join(path.dirname(LOG), 'injector.lock');

function acquireLock() {
  try {
    const parts = fs.readFileSync(LOCK, 'utf8').split(',');
    const pid = Number(parts[0] || 0);
    const age = Date.now() - Number(parts[1] || 0);
    /* 只看时间不够：注入器被杀掉时不会清锁，45 秒内所有点击都被拦。
     * 先看这个进程还在不在，不在就直接接管。 */
    let ownerAlive = false;
    if (pid) {
      try { process.kill(pid, 0); ownerAlive = true; } catch (e) { ownerAlive = false; }
    }
    if (ownerAlive && age >= 0 && age < 45000) {
      log('another injector is running (' + Math.round(age / 1000) + 's), skip');
      return false;
    }
    if (!ownerAlive) log('stale lock from pid ' + pid + ', taking over');
  } catch (e) { /* 没有锁文件 */ }
  try {
    fs.mkdirSync(path.dirname(LOCK), { recursive: true });
    fs.writeFileSync(LOCK, process.pid + ',' + Date.now());
  } catch (e) { /* ignore */ }
  return true;
}

function releaseLock() {
  try {
    const parts = fs.readFileSync(LOCK, 'utf8').split(',');
    if (String(parts[0]) === String(process.pid)) fs.unlinkSync(LOCK);
  } catch (e) { /* ignore */ }
}

/* 客户端是不是已经在跑。任务管理器里只看得到镜像名，够用了：
 * 有任何一个 WorkBuddy.exe 就当作在运行，让它自己处理单实例。 */
function appRunning() {
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq WorkBuddy.exe', '/FO', 'CSV', '/NH'], {
      encoding: 'buffer',
      timeout: 5000,
      windowsHide: true,
    });
    return out.toString('latin1').indexOf('WorkBuddy.exe') >= 0;
  } catch (e) {
    return false;
  }
}

/* 在同一条连接上跑 bootstrap，最多三次；返回最后一次的结果 */
async function runBootstrap(ws) {
  let outcome = '';
  for (let i = 0; i < 3; i++) {
    if (i) await new Promise((res) => setTimeout(res, 800));
    const r = await evaluateOnce(ws, buildBootstrap(ROOT, LOG), 30000);
    if (r && r.exceptionDetails) {
      outcome = 'exception ' + describe(r);
    } else {
      const v = r && r.result && typeof r.result.value === 'string' ? r.result.value : '';
      outcome = v || ('no-result ' + describe(r));
    }
    /* 结果里可能带多行堆栈，压成一行，日志才不会断成好几条 */
    log('bootstrap #' + (i + 1) + ' => ' + outcome.replace(/\s+/g, ' ').slice(0, 300));
    if (outcome.indexOf('OK') === 0) break;
  }
  return outcome;
}

/* --attach <port>：客户端已经在跑、inspector 端口还开着时，直接注入。
 * 处理的是「上一次注入没做完、进程带着 --inspect 但界面是原版」这种半死状态：
 * 不重启客户端就能补上。成功返回 0，失败返回 2。 */
async function attachAndInject(port) {
  log('attach mode, port=' + port);
  /* 端口是「已经在跑」的实例留下来的，正常情况下立刻就能连上。
   * 连不上就说明这次补不了，别拖着，交给上层决定要不要重启。 */
  const probe = await getJSON('http://127.0.0.1:' + port + '/json/list');
  if (!Array.isArray(probe) || !probe.length) {
    log('attach: nothing listening on ' + port);
    return 2;
  }
  const ready = await waitForMainReady(port, 8000);
  if (!ready.ok) {
    log('attach failed: ' + ready.last);
    try { if (ready.ws) ready.ws.close(); } catch (e) { /* ignore */ }
    return 2;
  }
  const outcome = await runBootstrap(ready.ws);
  try { ready.ws.close(); } catch (e) { /* ignore */ }
  return outcome.indexOf('OK') === 0 ? 0 : 2;
}

async function main() {
  const attachIdx = process.argv.indexOf('--attach');
  if (attachIdx > 0) {
    const port = Number(process.argv[attachIdx + 1] || 0);
    if (!port) {
      log('attach without a port');
      process.exitCode = 2;
      return;
    }
    process.exitCode = await attachAndInject(port);
    return;
  }

  if (!APP) {
    log('app exe not found; tried config.app=' + (CFG.app || '-') +
        ' and ' + (Array.isArray(CFG.candidates) ? CFG.candidates.length : 0) + ' candidates');
    log('client may have moved; re-run install.cmd to refresh paths');
    return;
  }
  if (!fs.existsSync(ROOT)) {
    log('no mods dir:', ROOT);
    return;
  }

  /* WB_DRY_RUN=1 只打印解析结果，不启动客户端——排查「为什么没注入」时用 */
  if (process.env.WB_DRY_RUN === '1') {
    let modIds = [];
    try {
      modIds = fs.readdirSync(ROOT).filter(function (id) {
        return fs.existsSync(path.join(ROOT, id, 'manifest.json'));
      });
    } catch (e) { /* ignore */ }
    log('dry-run app=' + APP + ' mods=[' + modIds.join(',') + ']');
    return;
  }

  /* 已经在跑的时候不要再 spawn 一个带 --inspect 的实例去撞单实例锁：
   * 那个进程会卡在启动画面，这边要空等 90 秒。正常启动一次让客户端自己
   * 把已有窗口带到前台，然后立刻退出。 */
  if (appRunning()) {
    log('app already running, open it without injector');
    try {
      const c = spawn(APP, [], { cwd: path.dirname(APP), detached: true, stdio: 'ignore' });
      c.unref();
    } catch (e) { log('focus spawn failed: ' + ((e && e.message) || e)); }
    return;
  }

  if (!acquireLock()) return;
  process.on('exit', releaseLock);

  const port = await freePort();
  const env = Object.assign({}, process.env);
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;

  log('spawn app with --inspect=' + port);
  const child = spawn(APP, ['--inspect=' + port], {
    cwd: path.dirname(APP),
    env,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  const target = await waitForTarget(port, Date.now() + 15000);
  if (!target) {
    log('inspector not reachable (app already running, or --inspect blocked); mods not injected');
    log('if the client is running, quit it from the tray and start it again');
    releaseLock();
    return;
  }

  const ready = await waitForMainReady(port);
  if (!ready.ok) {
    log('main process never became ready; mods not injected (' + ready.last + ')');
    try { if (ready.ws) ready.ws.close(); } catch (e) { /* ignore */ }
    releaseLock();
    return;
  }

  const outcome = await runBootstrap(ready.ws);
  try { ready.ws.close(); } catch (e) { /* ignore */ }
  if (outcome.indexOf('OK') !== 0) {
    log('injection did not complete; the client is running without mods');
    log('start it again from the shortcut to retry');
  }
  releaseLock();
}

/* 直接运行（快捷方式走的路径）才启动；被 require 时只导出 buildBootstrap，方便单测 */
if (require.main === module) {
  main().catch((e) => log('fatal', String((e && e.message) || e)));
}

module.exports = { buildBootstrap: buildBootstrap, resolveApp: resolveApp };
