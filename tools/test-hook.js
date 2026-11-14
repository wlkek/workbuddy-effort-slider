/* hook.js 逻辑测试：用假的 electron 模块跑一遍加载器。
 * 覆盖：NODE_OPTIONS 摘除、mod 扫描、URL 过滤、注入调用。
 * 运行：node tools/test-hook.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const Module = require('module');
const EventEmitter = require('events');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-mod-test-'));
const modDir = path.join(tmp, 'demo');
fs.mkdirSync(modDir, { recursive: true });
fs.writeFileSync(path.join(modDir, 'manifest.json'), JSON.stringify({
  name: 'demo', version: '1.0.0', main: 'mod.js',
}));
fs.writeFileSync(path.join(modDir, 'mod.js'), 'window.__DEMO__ = 1;');
fs.mkdirSync(path.join(tmp, 'broken'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'broken', 'manifest.json'), '{bad json');

process.type = 'browser';
process.env.NODE_OPTIONS = '--require "C:\\x\\hook.js" --use-system-ca';
process.env.WB_MODS_DIR = tmp;

const calls = [];
const fakeWebContents = [];
const fakeApp = new EventEmitter();
fakeApp.whenReady = () => Promise.resolve();

const fakeElectron = {
  app: fakeApp,
  webContents: { getAllWebContents: () => fakeWebContents },
};

const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'electron') return fakeElectron;
  return origLoad.apply(this, arguments);
};

require('../loader/hook.js');

/* 1. 环境变量被摘掉 --require，但保留其它选项 */
assert.ok(!/--require/.test(process.env.NODE_OPTIONS || ''), 'NODE_OPTIONS 里仍有 --require');
assert.ok(/--use-system-ca/.test(process.env.NODE_OPTIONS || ''), '误删了其它 NODE_OPTIONS');

/* 2. 收到 web-contents-created 后，只有目标页面被注入 */
const wc = new EventEmitter();
wc.getURL = () => 'file:///D:/Apps/WorkBuddy/resources/app.asar/renderer/index.html#/chat';
wc.executeJavaScript = (src) => { calls.push(src); return Promise.resolve(); };
fakeApp.emit('web-contents-created', {}, wc);
wc.emit('dom-ready');

const other = new EventEmitter();
other.getURL = () => 'file:///D:/Apps/WorkBuddy/resources/app.asar/renderer/markdown-shared-guest.html';
other.executeJavaScript = () => { throw new Error('不该注入 guest 页面'); };
fakeApp.emit('web-contents-created', {}, other);
other.emit('dom-ready');

/* 3. 断言 */
assert.strictEqual(calls.length, 1, '应只注入 1 次，实际 ' + calls.length);
assert.ok(/__DEMO__/.test(calls[0]), '注入内容不是 mod 源码');

setTimeout(function () {
  const logFile = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'WbMods', 'loader.log');
  const log = fs.readFileSync(logFile, 'utf8');
  assert.ok(/loader start/.test(log), '没有写启动日志');
  assert.ok(/injected demo@1\.0\.0/.test(log), '没有写注入成功日志');

  console.log('PASS  env stripped   :', JSON.stringify(process.env.NODE_OPTIONS));
  console.log('PASS  inject count  :', calls.length);
  console.log('PASS  log           :', log.trim().split('\n').slice(-2).join(' | '));
}, 100);
