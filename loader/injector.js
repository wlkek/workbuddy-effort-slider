/* WorkBuddy mod injector
 * ------------------------------------------------------------------
 * 为什么不用 NODE_OPTIONS：Electron 打包应用只放行 NODE_OPTIONS 的一个白名单
 * （内存、证书、警告类），`--require` 不在里面——二进制里那句
 * "Most NODE_OPTIONs are not supported in packaged apps" 就是这道闸。
 *
 * 这里改用 `--inspect`：NodeCliInspect fuse 是开的，启动开关不会被过滤。
 * 流程：
 *   1. 以 Node 模式跑本脚本（ELECTRON_RUN_AS_NODE=1 + WorkBuddy.exe）
 *   2. spawn 真正的客户端，带 --inspect=<随机端口>
 *   3. 连上主进程 inspector，Runtime.evaluate 一段 bootstrap
 *   4. bootstrap 挂 web-contents-created，把 mods 注入主界面
 *   5. 注入成功后从主进程里关掉 inspector，端口不留在外面
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
    var req = (typeof require === 'function') ? require
      : (process.mainModule && process.mainModule.require
          ? process.mainModule.require.bind(process.mainModule) : null);
    if (!req) return 'ERR:no-require';

    var electron = req('electron');
    if (!electron || !electron.app) return 'ERR:no-app';

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
          mods.push({ id: id, v: meta.version || '', src: fs.readFileSync(path.join(dir, meta.main || 'mod.js'), 'utf8') });
        } catch (e) { log('bad mod ' + id + ': ' + e.message); }
      });
    } catch (e) { return 'ERR:scan:' + e.message; }

    var TARGET = /app\\.asar[\\\\/]renderer[\\\\/]index\\.html/i;
    function inject(wc) {
      var url = '';
      try { url = wc.getURL() || ''; } catch (e) { return; }
      if (!TARGET.test(url)) return;
      mods.forEach(function (m) {
        wc.executeJavaScript(m.src, true)
          .then(function () { log('injected ' + m.id + '@' + m.v); })
          .catch(function (err) { log('inject failed ' + m.id + ': ' + ((err && err.message) || err)); });
      });
    }

    electron.app.on('web-contents-created', function (_e, wc) {
      try { wc.on('dom-ready', function () { inject(wc); }); } catch (e) {}
    });
    try { electron.webContents.getAllWebContents().forEach(inject); } catch (e) {}
    log('bootstrap ok, mods=' + mods.length);

    /* 注入器已经拿到结果，这里把 inspector 关掉，别留一个可执行代码的端口 */
    setTimeout(function () {
      try { req('inspector').close(); log('inspector closed'); } catch (e) { log('inspector close failed: ' + e.message); }
    }, 1200);

    return 'OK:' + mods.length;
  } catch (e) { return 'ERR:' + ((e && e.message) || e); }
})()`;
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
  const done = new Promise((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), 15000);
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: {
          expression: buildBootstrap(ROOT, LOG),
          includeCommandLineAPI: true,
          returnByValue: true,
        },
      }));
    });
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.id !== 1) return;
      clearTimeout(timer);
      const r = msg.result && msg.result.result;
      resolve(r && typeof r.value === 'string' ? r.value : 'no-result');
    });
    ws.addEventListener('error', () => { clearTimeout(timer); resolve('ws-error'); });
  });

  const outcome = await done;
  log('evaluate => ' + outcome);
  try { ws.close(); } catch (e) { /* ignore */ }
}

main().catch((e) => log('fatal', String((e && e.message) || e)));
