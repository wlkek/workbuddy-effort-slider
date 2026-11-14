/* WorkBuddy mod loader — main-process preload
 * ------------------------------------------------------------------
 * 从 WorkBuddy 5.9.2 起，renderer 入口打进 app.asar 且带 SHA256 完整性校验，
 * 老的「往 app.asar.unpacked/renderer/index.html 插脚本」方案失效。
 *
 * 这个 loader 走 Electron 的 NODE_OPTIONS fuse：
 *   NODE_OPTIONS=--require "…\hook.js"  WorkBuddy.exe
 * 在 main 进程启动、窗口创建之前加载，监听 web-contents-created，
 * 等主界面 dom-ready 后把 mods/<id>/mod.js 注入页面。
 *
 * 安全边界：
 *   - 只处理 process.type === 'browser'（main 进程），不碰渲染进程与子进程
 *   - 立即把自己从 NODE_OPTIONS 里摘掉，避免被 agent 的 node 子进程继承
 *   - 只在 app.asar/renderer/index.html 这个页面上注入
 *   - 全程 try/catch，失败只写日志，不影响客户端启动
 */
'use strict';

(function () {
  if (process.type !== 'browser') return;

  var fs = require('fs');
  var path = require('path');

  var ROOT = process.env.WB_MODS_DIR || path.join(__dirname, 'mods');
  var LOG_DIR = path.join(process.env.LOCALAPPDATA || __dirname, 'WbMods');
  var LOG = path.join(LOG_DIR, 'loader.log');

  function log() {
    try {
      fs.mkdirSync(LOG_DIR, { recursive: true });
      var parts = [];
      for (var i = 0; i < arguments.length; i++) {
        var a = arguments[i];
        parts.push(typeof a === 'string' ? a : JSON.stringify(a));
      }
      fs.appendFileSync(LOG, '[' + new Date().toISOString() + '] ' + parts.join(' ') + '\n');
    } catch (e) { /* 日志失败也不影响启动 */ }
  }

  /* 1. 摘掉 --require，避免污染 agent 的 node 子进程 */
  try {
    var raw = process.env.NODE_OPTIONS || '';
    var cleaned = raw
      .replace(/--require(=|\s+)("[^"]*"|'[^']*'|\S+)/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (cleaned) process.env.NODE_OPTIONS = cleaned;
    else delete process.env.NODE_OPTIONS;
  } catch (e) {
    log('strip NODE_OPTIONS failed:', String(e && e.message));
  }

  /* 2. 读取 mods/<id>/manifest.json */
  var mods = [];
  try {
    var ids = fs.readdirSync(ROOT);
    for (var j = 0; j < ids.length; j++) {
      var id = ids[j];
      try {
        var dir = path.join(ROOT, id);
        var mf = path.join(dir, 'manifest.json');
        if (!fs.existsSync(mf)) continue;
        var meta = JSON.parse(fs.readFileSync(mf, 'utf8'));
        if (meta.enabled === false) continue;
        var file = path.join(dir, meta.main || 'mod.js');
        if (!fs.existsSync(file)) {
          log('missing file for mod', id);
          continue;
        }
        mods.push({
          id: id,
          name: meta.name || id,
          version: meta.version || '',
          source: fs.readFileSync(file, 'utf8')
        });
      } catch (err) {
        log('bad mod, skipped:', id, String((err && err.message) || err));
      }
    }
  } catch (e) {
    log('scan mods failed:', String(e && e.message));
  }

  log('loader start | pid=' + process.pid + ' | mods=' + mods.map(function (m) {
    return m.id + '@' + m.version;
  }).join(',') + (mods.length ? '' : '(none)'));

  if (!mods.length) return;

  /* 3. 注入主界面 */
  var electron;
  try {
    electron = require('electron');
  } catch (e) {
    log('require electron failed:', String(e && e.message));
    return;
  }

  var TARGET = /app\.asar[\\/]renderer[\\/]index\.html/i;

  function inject(wc) {
    var url = '';
    try { url = wc.getURL() || ''; } catch (e) { return; }
    if (!TARGET.test(url)) return;

    mods.forEach(function (mod) {
      wc.executeJavaScript(mod.source, true)
        .then(function () {
          log('injected', mod.id + '@' + mod.version);
        })
        .catch(function (err) {
          log('inject failed', mod.id, String((err && err.message) || err));
        });
    });
  }

  function watch(wc) {
    try {
      // 每次导航/重载都会重新 dom-ready；mod 脚本自身是幂等的
      wc.on('dom-ready', function () { inject(wc); });
    } catch (e) {
      log('watch failed:', String(e && e.message));
    }
  }

  electron.app.on('web-contents-created', function (_e, wc) { watch(wc); });

  electron.app.whenReady().then(function () {
    try {
      electron.webContents.getAllWebContents().forEach(watch);
    } catch (e) { /* ignore */ }
  }).catch(function () { /* ignore */ });
})();
