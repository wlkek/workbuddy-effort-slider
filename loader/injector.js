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

const { spawn } = require('child_process');
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

    /* 主界面入口：5.9.2+ 在 app.asar 里，5.8.x 是解包目录，都按路径结尾判断 */
    function isTarget(u) {
      if (typeof u !== 'string') return false;
      var s = u.split('#')[0].split('?')[0];
      return /\/renderer\/index\.html$/i.test(s);
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
      if (!isTarget(url)) return;
      if (wc.__wbInjected) return;
      wc.__wbInjected = true;

      mods.forEach(function (m) {
        wc.executeJavaScript(m.src, true)
          .then(function () { log('injected ' + m.id + '@' + m.v); })
          .catch(function (e) { log('inject fail ' + m.id + ': ' + ((e && e.message) || e)); });
      });
      arm(wc);
    }

    electron.app.on('web-contents-created', function (_e, wc) {
      try {
        wc.on('did-start-loading', function () { wc.__wbInjected = false; });
        wc.on('dom-ready', function () { inject(wc); });
      } catch (e) {}
    });
    try { electron.webContents.getAllWebContents().forEach(inject); } catch (e) {}

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

/* 客户端刚 spawn 时 inspector 端口就开了，但 Electron 还没初始化完，
 * 这时求值拿不到 require。等它准备好，比盲目重试省时间也好排查。 */
async function waitForMainReady(ws) {
  const deadline = Date.now() + 30000;
  let last = '';
  let n = 0;
  while (Date.now() < deadline) {
    const r = await evaluateOnce(ws, 'typeof require', 3000);
    const v = r && r.result && r.result.value;
    if (v === 'function') return true;
    last = r && r.timeout ? 'timeout' : (r && r.closed ? 'closed' : 'value=' + String(v));
    if (++n % 10 === 0) log('wait main, #' + n + ' ' + last);
    await new Promise((res) => setTimeout(res, 300));
  }
  log('main not ready: ' + last);
  return false;
}

async function main() {
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
    return;
  }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve) => {
    if (ws.readyState === 1) return resolve();
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', () => resolve());
  });

  const ready = await waitForMainReady(ws);
  if (!ready) {
    log('main process never became ready; mods not injected');
    try { ws.close(); } catch (e) { /* ignore */ }
    return;
  }

  let outcome = '';
  for (let i = 0; i < 3; i++) {
    if (i) await new Promise((res) => setTimeout(res, 800));
    const r = await evaluateOnce(ws, buildBootstrap(ROOT, LOG), 30000);
    const v = r && r.result && typeof r.result.value === 'string' ? r.result.value : '';
    outcome = v || ('no-result ' + JSON.stringify(r).slice(0, 160));
    log('bootstrap #' + (i + 1) + ' => ' + outcome);
    if (outcome.indexOf('OK') === 0) break;
  }
  try { ws.close(); } catch (e) { /* ignore */ }
}

/* 直接运行（快捷方式走的路径）才启动；被 require 时只导出 buildBootstrap，方便单测 */
if (require.main === module) {
  main().catch((e) => log('fatal', String((e && e.message) || e)));
}

module.exports = { buildBootstrap: buildBootstrap, resolveApp: resolveApp };
