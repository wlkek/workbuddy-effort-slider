/*!
 * wb-effort-slider v2.8.0
 * WorkBuddy「思考强度」Codex 风格滑条（含 Off 档）
 * ------------------------------------------------------------------
 * 纯 DOM 注入：不注册宿主钩子、不改官方 React 树、不碰官方文案。
 *
 * 档位模型（和官方一致）：
 *   ON  ：[关] + 低 / 中 / 高 / 超高 / 极致   ← 档位数由模型决定（自定义模型可能只有 1/3 档）
 *   OFF ：官方面板只剩「思考模式」开关那一行（思考强度小标题与档位列表都不渲染）
 *
 * 所以滑条把「关」当成第 0 档：
 *   - 拖到最左 → 关（点官方开关）
 *   - 从关往右拖 → 先点开关开启，再落到最近的档位
 * 写入始终走官方 UI：点开关 / 点档位项 —— 就是官方 onClick。
 *
 * 视觉层完全对齐 Codex/DSH 原版的真实参数：
 *   轨道 28px、旋钮直径 = 轨道高度（管子里的球）、
 *   星云 = 平滑水平渐变 #3b1178→#6d28d9→#9333ea→#c084fc（不动背景位置，不会有接缝）、
 *   星尘 = 整轨宽度横排上的白点持续横穿（两端淡出在可视区外，从不消失）。
 */
(function () {
  'use strict';

  var VERSION = '2.8.0';
  if (window.__WB_EFFORT_SLIDER__) return;
  window.__WB_EFFORT_SLIDER__ = VERSION;

  /* ------------------------------------------------------------------ */
  /* 常量                                                                */
  /* ------------------------------------------------------------------ */
  var TRACK_H = 28;               // 轨道高度 = 旋钮直径（管子里的球）
  var INSET = TRACK_H / 2;        // 旋钮圆心活动范围 [14, W-14]
  var STORE_KEY = 'wb.effort-slider.settings.v1';
  var STAR_COUNT = 10;
  var STAR_MEAN_MS = 1600;
  var SPEED_MAX = 2;
  var APPLY_INTERVAL = 120;
  var ENABLE_THRESHOLD = 0.16;    // 关态下往右拖过 16% 就开启

  var SEL_PANEL = '[class*="model-selector__sub-panel"]';

  var T_LABEL = 'model-selector__sub-panel-section-label';
  var T_ITEM = 'model-selector__sub-panel-item';
  var T_ACTIVE = 'model-selector__sub-panel-item--active';
  var T_TOGGLE = 'model-selector__sub-panel-toggle';

  /* ------------------------------------------------------------------ */
  /* 档位文案（固定 i18n，只用来识别"这是不是思考强度面板"）               */
  /* ------------------------------------------------------------------ */
  var LEVELS = [
    { id: 'minimal', names: ['最低', '最小', 'Minimal', 'Mínimo', 'Minimo'] },
    { id: 'low', names: ['低', 'Low', 'Rendah', 'Baixo'] },
    { id: 'medium', names: ['中', 'Medium', 'Sedang', 'Médio', 'Medio'] },
    { id: 'high', names: ['高', 'High', 'Tinggi', 'Alto'] },
    { id: 'xhigh', names: ['超高', 'Extra High', 'Sangat Tinggi', 'Muito alto'] },
    { id: 'max', names: ['极致', '極致', 'Max', 'Maks', 'Máximo', 'Maximo'] }
  ];

  function norm(s) {
    return String(s == null ? '' : s).replace(/[\s\u00a0]+/g, ' ').trim().toLowerCase();
  }

  var NAME_TO_ID = Object.create(null);
  LEVELS.forEach(function (lv) {
    lv.names.forEach(function (n) { NAME_TO_ID[norm(n)] = lv.id; });
  });

  /* ------------------------------------------------------------------ */
  /* 设置                                                                */
  /* ------------------------------------------------------------------ */
  var DEFAULTS = {
    animation: 'simple',
    animv: 2,
    ticks: 'bright',
    showOfficial: false,
    glow: false
  };

  var settings = readSettings();

  function readSettings() {
    var o = {};
    for (var k in DEFAULTS) if (Object.prototype.hasOwnProperty.call(DEFAULTS, k)) o[k] = DEFAULTS[k];
    try {
      var raw = window.localStorage && localStorage.getItem(STORE_KEY);
      if (!raw) return o;
      var parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        /* animv=2 之前一律用老默认（快速），升级后默认改"简洁" */
        if (parsed.animv === 2 && (parsed.animation === 'simple' || parsed.animation === 'full')) o.animation = parsed.animation;
        /* 步进的"快速"已下线（慢拖会出现台阶感），老选择归到"简洁" */
        if (parsed.ticks === 'bright' || parsed.ticks === 'same' || parsed.ticks === 'hidden') o.ticks = parsed.ticks;
        if (typeof parsed.showOfficial === 'boolean') o.showOfficial = parsed.showOfficial;
        if (typeof parsed.glow === 'boolean') o.glow = parsed.glow;
      }
    } catch (e) { /* ignore */ }
    return o;
  }

  function saveSettings() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(settings)); } catch (e) { /* ignore */ }
  }

  /* ------------------------------------------------------------------ */
  /* 诊断                                                                */
  /* ------------------------------------------------------------------ */
  var diag = [];
  function log(kind, data) {
    try {
      diag.push({ t: Math.round(performance.now()), k: kind, d: data });
      if (diag.length > 240) diag.shift();
    } catch (e) { /* ignore */ }
  }

  /* ------------------------------------------------------------------ */
  /* 小工具                                                              */
  /* ------------------------------------------------------------------ */
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

  function hasToken(el, name) {
    if (!el || !el.classList) return false;
    for (var i = 0; i < el.classList.length; i++) {
      var t = el.classList[i];
      if (t === name || t === 'cr-' + name) return true;
      if (t.length > name.length && t.slice(-(name.length + 1)) === '-' + name) return true;
    }
    return false;
  }

  function el(tag, cls, attrs) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (attrs) for (var k in attrs) if (attrs.hasOwnProperty(k)) n.setAttribute(k, attrs[k]);
    return n;
  }

  function childItems(panel) {
    var out = [];
    var kids = panel.children || [];
    for (var i = 0; i < kids.length; i++) {
      if (hasToken(kids[i], T_ITEM)) out.push(kids[i]);
    }
    return out;
  }

  function findLabel(panel) {
    var kids = panel.children || [];
    for (var i = 0; i < kids.length; i++) {
      if (hasToken(kids[i], T_LABEL)) return kids[i];
    }
    return null;
  }

  function findToggleRow(panel) {
    var kids = panel.children || [];
    for (var i = 0; i < kids.length; i++) {
      if (hasToken(kids[i], T_TOGGLE)) return kids[i];
    }
    return null;
  }

  function findToggleControl(panel) {
    var row = findToggleRow(panel);
    if (!row) return null;
    return row.querySelector('input[type="checkbox"], [role="switch"], button, [class*="switch"]') || row;
  }

  function isActive(item) { return hasToken(item, T_ACTIVE); }

  /** 档位名：只取第一个 span 的文字，避开官方那个勾选图标 */
  function itemLabel(item) {
    if (!item) return '';
    var sp = item.querySelector('span');
    return (sp ? sp.textContent : item.textContent).replace(/\s+/g, ' ').trim();
  }

  function panelTheme(panel) {
    var n = panel;
    while (n && n !== document.documentElement) {
      if (n.getAttribute) {
        var t = n.getAttribute('data-theme') || n.getAttribute('data-cr-theme');
        if (t === 'dark' || t === 'light') return t;
      }
      n = n.parentElement;
    }
    var root = document.documentElement;
    if (root.getAttribute('data-theme') === 'dark') return 'dark';
    if (root.classList.contains('dark') || root.classList.contains('vscode-dark')) return 'dark';
    return 'light';
  }

  /** 官方小标题的纯文字（把我们注入的数值节点摘掉再取） */
  function labelTextOf(label) {
    if (!label) return '';
    var clone = label.cloneNode(true);
    var mine = clone.querySelectorAll('.wb-es-value');
    for (var i = 0; i < mine.length; i++) {
      if (mine[i].parentNode) mine[i].parentNode.removeChild(mine[i]);
    }
    return clone.textContent.replace(/[\s ]+/g, ' ').trim();
  }

  function offWord(sample) {
    return /[\u4e00-\u9fa5]/.test(sample || '') ? '关' : 'Off';
  }

  /* ------------------------------------------------------------------ */
  /* 纯函数：颜色 / 能量 / 速率（都由"位置"驱动，与档位数无关）             */
  /* ------------------------------------------------------------------ */
  var C_BLUE = [77, 147, 248];     // #4d93f8
  var C_VIOLET = [147, 51, 234];   // #9333ea
  var C_LIFT = [124, 58, 237];     // #7c3aed —— 末端提亮但保持饱和紫（对齐 Codex 真机）

  function lerp(a, b, t) {
    return [
      Math.round(a[0] + (b[0] - a[0]) * t),
      Math.round(a[1] + (b[1] - a[1]) * t),
      Math.round(a[2] + (b[2] - a[2]) * t)
    ];
  }
  function rgb(c) { return 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')'; }

  /** 填充末端颜色：0~1/3 恒为蓝，1/3~2/3 蓝→紫，2/3~1 紫→亮紫罗兰 */
  function fillColorFor(p) {
    if (p <= 1 / 3) return C_BLUE;
    if (p <= 2 / 3) return lerp(C_BLUE, C_VIOLET, (p - 1 / 3) / (1 / 3));
    return lerp(C_VIOLET, C_LIFT, (p - 2 / 3) / (1 / 3));
  }

  /** 能量：1/3 之前为 0（干净的蓝），之后线性点亮到 1 */
  function energyFor(p) {
    if (p <= 1 / 3) return 0;
    return clamp((p - 1 / 3) / (2 / 3), 0, 1);
  }

  function particleCountFor(p) {
    return Math.round(energyFor(p) * STAR_COUNT);
  }

  function speedFor(p) {
    if (p <= 1 / 3) return 0.35;
    if (p <= 2 / 3) return 0.35 + 0.65 * ((p - 1 / 3) / (1 / 3));
    return 1 + (SPEED_MAX - 1) * ((p - 2 / 3) / (1 / 3));
  }

  function starLayerOpacityFor(p) {
    var e = energyFor(p);
    if (e <= 0) return 0;
    return 0.55 + 0.45 * clamp((e - 0.15) / 0.85, 0, 1);
  }

  /** 数值文字颜色：蓝 → 亮紫罗兰（对比度算过，浅深都读得清） */
  function valueColorFor(p, theme) {
    var a = theme === 'dark' ? [122, 170, 255] : C_BLUE;
    var b = [139, 92, 246];      // #8b5cf6
    return rgb(lerp(a, b, clamp(p, 0, 1)));
  }

  function hash01(i, salt) {
    var x = Math.sin(i * 127.1 + salt * 311.7) * 43758.5453;
    return x - Math.floor(x);
  }

  /* ------------------------------------------------------------------ */
  /* 样式                                                                */
  /* ------------------------------------------------------------------ */
  var STYLE_ID = 'wb-es-style';

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var css = [
      '.wb-es{--p:0;--wb-es-energy:0;position:relative;display:block;padding:2px 8px 8px;box-sizing:border-box;',
      'user-select:none;-webkit-user-select:none;}',

      /* 关态下官方没有小标题，我们自己补一行（文字取自上次见过的官方文案） */
      '.wb-es-head{display:none;align-items:center;height:28px;padding:0 8px;margin:0 -8px;',
      'color:var(--cr-text-tertiary);font-size:12px;line-height:20px;}',
      '.wb-es[data-off="1"] .wb-es-head{display:flex;}',
      '.wb-es-head-label{white-space:nowrap;}',
      '.wb-es-head-value{margin-left:auto;padding-left:8px;font-weight:600;font-size:12px;',
      'color:var(--cr-text-tertiary);white-space:nowrap;}',

      /* 轨道：28px，管子。能量越高外面那圈紫光越明显 */
      '.wb-es-track{position:relative;height:30px;border-radius:999px;',
      'background:var(--cr-bg-tertiary,rgba(15,17,21,.08));cursor:pointer;touch-action:none;outline:none;',
      'box-shadow:inset 0 0 0 .5px var(--cr-border-faint,rgba(0,0,0,.05)),',
      '0 0 calc(var(--wb-es-energy,0) * 10px) rgba(168,85,247,.30);}',
      '.wb-es[data-off="1"] .wb-es-track{background:transparent;',
      'box-shadow:inset 0 0 0 1px var(--cr-popover-divider,rgba(0,0,0,.12));}',

      /* 填充：左圆角、右端是平口（压在旋钮下面，看不见） */
      '.wb-es-clip{position:absolute;top:0;bottom:0;left:0;',
      'width:calc(16px + (100% - 32px) * var(--p));border-radius:999px 0 0 999px;',
      'overflow:hidden;pointer-events:none;}',
      '.wb-es[data-off="1"] .wb-es-clip{display:none;}',

      '.wb-es-fill{position:absolute;top:0;bottom:0;left:0;right:0;',
      'background:linear-gradient(90deg,#4d93f8 0%,var(--wb-es-end,#4d93f8) 100%);}',

      /* 能量层（紫色星云）= 原版那条平滑水平渐变，opacity 由能量驱动 —— 没有接缝 */
      '.wb-es-nebula{position:absolute;inset:0;opacity:0;transition:opacity .2s ease;',
      'background:linear-gradient(90deg,rgba(147,51,234,0) 0%,rgba(147,51,234,.28) 42%,',
      'rgba(147,51,234,.52) 78%,rgba(168,85,247,.68) 100%);}',

      /* 扫光：一条亮带用位移横穿（不刷 background-position —— 刷位置才有接缝） */
      '.wb-es-sweep{position:absolute;inset:0;opacity:0;',
      'background:linear-gradient(100deg,transparent 18%,rgba(255,255,255,.30) 50%,transparent 82%);',
      'animation:wb-es-sweep 2.4s linear infinite;}',

      /* 星尘：每颗是一条整宽度的横排，右侧那个点连续横穿；两端淡出在可视区外 → 从不消失 */
      '.wb-es-stars{position:absolute;top:0;bottom:0;left:0;right:0;overflow:hidden;',
      'pointer-events:none;opacity:0;transition:opacity .2s ease;}',
      '.wb-es-star{position:absolute;left:0;right:0;height:3px;margin-top:-1.5px;pointer-events:none;',
      'animation-name:wb-es-star-sweep;animation-timing-function:linear;animation-iteration-count:infinite;',
      'will-change:transform;}',
      '.wb-es-star-dot{position:absolute;left:100%;top:0;width:3px;height:3px;margin-left:-1.5px;',
      'border-radius:50%;background:#fff;box-shadow:0 0 4px rgba(255,255,255,.85);',
      'opacity:var(--b,.8);transform:scale(var(--b,.8));}',

      /* 刻度点 */
      '.wb-es-ticks{position:absolute;inset:0;pointer-events:none;}',
      '.wb-es-tick{position:absolute;top:50%;width:3px;height:3px;margin:-1.5px 0 0 -1.5px;',
      'border-radius:50%;transition:background .18s linear;}',
      '.wb-es[data-off="1"] .wb-es-ticks{display:none;}',

      /* 旋钮直径 = 轨道高度（管子里的球，圆永远是完整的圆） */
      '.wb-es-knob{position:absolute;top:50%;left:calc(16px + (100% - 32px) * var(--p));',
      'width:32px;height:32px;margin:-16px 0 0 -16px;border-radius:50%;background:#fff;',
      'box-shadow:0 1px 5px rgba(0,0,0,.34),0 0 0 .5px rgba(0,0,0,.06);pointer-events:none;',
      'transition:left .09s cubic-bezier(.22,.8,.24,1),box-shadow .2s;}',
      '.wb-es[data-off="1"] .wb-es-knob{box-shadow:0 1px 3px rgba(0,0,0,.2),0 0 0 1px var(--cr-popover-border,rgba(0,0,0,.12));opacity:.85;}',
      '.wb-es[data-drag="1"] .wb-es-knob{box-shadow:0 1px 5px rgba(0,0,0,.34),0 0 0 .5px rgba(0,0,0,.06),0 0 0 6px rgba(168,85,247,.18);}',
      '.wb-es[data-anim="simple"] .wb-es-knob{transition:box-shadow .2s;}',
      /* 简洁 = 跟手 + 星尘，只把最"忙"的扫光关掉 */
      '.wb-es[data-anim="simple"] .wb-es-sweep{display:none!important;}',
      '.wb-es[data-anim="full"] .wb-es-knob{transition:box-shadow .2s;}',
      /* 填充宽度必须和旋钮用同一条曲线，否则"圆点在滑、色块瞬移" */
      '.wb-es[data-anim="fast"] .wb-es-clip{transition:width .13s cubic-bezier(.25,.8,.3,1);}',
      /* 完整 = 连续跟手 + 全部视觉，不再给 left/width 加延迟 */
      /* 松手归位：160ms 滑到位（只在这 220ms 内生效） */
      '.wb-es[data-snap="1"] .wb-es-knob{transition:left .16s cubic-bezier(.22,.8,.24,1)!important;}',
      '.wb-es[data-snap="1"] .wb-es-clip{transition:width .16s cubic-bezier(.22,.8,.24,1);}',

      '.wb-es:focus-visible .wb-es-track{box-shadow:inset 0 0 0 .5px var(--cr-border-faint,rgba(0,0,0,.05)),0 0 0 2px var(--cr-accent,#4d93f8);}',

      '@keyframes wb-es-sweep{0%{transform:translateX(100%);}100%{transform:translateX(-100%);}}',
      '@keyframes wb-es-star-sweep{0%{transform:translate3d(0,0,0);opacity:0;}6%{opacity:1;}94%{opacity:1;}100%{transform:translate3d(-100%,0,0);opacity:0;}}',

      /* 数值文字（挂在官方小标题里） */
      '.wb-es-value{margin-left:auto;padding-left:8px;font-size:12px;line-height:20px;font-weight:600;',
      'letter-spacing:.2px;white-space:nowrap;transition:color .18s linear;}',

      'box-shadow:0 1px 2px rgba(0,0,0,.3);transition:transform .16s;}',

      '.cr-model-selector__sub-panel[data-wb-es]{transition:box-shadow .2s ease-out;}',
      '.cr-model-selector__sub-panel[data-wb-es][data-wb-es-hide="1"] > [class*="model-selector__sub-panel-item"]{display:none!important;}',

      /* ---- 设置面板 ---- */
      /* 设置直接在面板里展开，指针不离开 hover 弹层 */
      '.wb-es-pop--inline{position:static!important;width:100%!important;margin-top:8px;box-shadow:none!important;',
      'padding:6px 8px;}',
      /* 搬进官方面板后会被它的后代选择器污染（字号/行高被放大），这里强制收回 */
      '.wb-es-pop--inline,.wb-es-pop--inline *{font-size:11px!important;line-height:1.35!important;',
      'font-weight:400!important;letter-spacing:normal!important;margin:0!important;',
      'box-sizing:border-box!important;text-transform:none!important;float:none!important;}',
      '.wb-es-pop--inline .wb-es-pop-title{font-weight:600!important;}',
      '.wb-es-pop--inline .wb-es-pop-row{min-height:0!important;height:auto!important;padding:4px 0!important;',
      'display:flex!important;flex-direction:column!important;align-items:stretch!important;gap:4px!important;}',
      '.wb-es-pop--inline .wb-es-pop-seg{display:flex!important;width:100%!important;gap:4px!important;}',
      '.wb-es-pop--inline .wb-es-pop-seg>*{flex:1 1 0!important;padding:3px 0!important;text-align:center!important;',
      'white-space:nowrap!important;font-size:10px!important;}',
      /* 卡片里空间紧张：标题和页脚都不显示，只留设置项 */
      '.wb-es-pop--inline .wb-es-pop-ft{display:none!important;}',
      /* 打开设置时，面板内容整体让位给设置页：总高度比原来还小，不会被窗口底边裁掉 */
      '[data-wb-es-settings="1"] .wb-es,',
      '[data-wb-es-settings="1"] .cr-model-selector__sub-menu-desc,',
      '[data-wb-es-settings="1"] .cr-model-selector__sub-panel-toggle,',
      '[data-wb-es-settings="1"] .cr-model-selector__sub-panel-divider,',
      '[data-wb-es-settings="1"] .cr-model-selector__sub-panel-section-label{display:none!important;}',
      '.wb-es-pop{position:fixed;z-index:2147483000;width:236px;box-sizing:border-box;',
      'padding:10px;border-radius:14px;font-family:var(--cr-font-family,-apple-system,"PingFang SC","Segoe UI",sans-serif);',
      'font-size:12px;line-height:18px;',
      'background:var(--wb-es-pop-bg,#fff);color:var(--wb-es-pop-fg,#1f2329);',
      'border:.5px solid var(--wb-es-pop-border,rgba(0,0,0,.1));',
      'box-shadow:0 12px 32px rgba(0,0,0,.18);animation:wb-es-pop-in .12s ease-out;}',
      '.wb-es-pop[data-theme="dark"]{--wb-es-pop-bg:#26272c;--wb-es-pop-fg:#e9e9ec;--wb-es-pop-border:rgba(255,255,255,.12);}',
      '@keyframes wb-es-pop-in{from{opacity:0;transform:translateY(4px);}to{opacity:1;transform:none;}}',
      '.wb-es-pop-hd{display:flex;align-items:center;justify-content:space-between;margin:0 2px 8px;}',
      '.wb-es-pop-hd b{font-size:12px;font-weight:600;}',
      '.wb-es-pop-hd span{opacity:.45;font-size:11px;}',
      '.wb-es-pop-row{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:5px 2px;}',
      '.wb-es-pop-row>span{opacity:.72;white-space:nowrap;}',
      '.wb-es-seg{display:flex;background:var(--wb-es-seg-bg,rgba(0,0,0,.06));border-radius:8px;padding:2px;}',
      '.wb-es-seg button{appearance:none;border:0;background:transparent;color:inherit;font:inherit;font-size:11px;',
      'padding:3px 7px;border-radius:6px;cursor:pointer;opacity:.7;}',
      '.wb-es-seg button[data-on="1"]{background:var(--wb-es-seg-on,#fff);opacity:1;',
      'box-shadow:0 1px 2px rgba(0,0,0,.14);font-weight:600;}',
      '.wb-es-pop[data-theme="dark"] .wb-es-seg{--wb-es-seg-bg:rgba(255,255,255,.09);--wb-es-seg-on:rgba(255,255,255,.18);}',
      '.wb-es-sw{position:relative;width:30px;height:17px;border-radius:999px;background:rgba(0,0,0,.18);',
      'cursor:pointer;transition:background .16s;flex:none;}',
      '.wb-es-sw[data-on="1"]{background:#4d93f8;}',
      '.wb-es-sw i{position:absolute;top:2px;left:2px;width:13px;height:13px;border-radius:50%;background:#fff;',
      'transition:transform .16s;box-shadow:0 1px 2px rgba(0,0,0,.2);}',
      '.wb-es-sw[data-on="1"] i{transform:translateX(13px);}',
      '.wb-es-pop-ft{display:flex;gap:6px;margin-top:8px;padding-top:8px;border-top:.5px solid var(--wb-es-pop-border,rgba(0,0,0,.1));}',
      '.wb-es-pop-ft button{flex:1;appearance:none;border:.5px solid var(--wb-es-pop-border,rgba(0,0,0,.12));',
      'background:transparent;color:inherit;font:inherit;font-size:11px;padding:5px 0;border-radius:8px;cursor:pointer;opacity:.85;}',
      '.wb-es-pop-ft button:hover{background:rgba(127,127,127,.12);opacity:1;}',
      '.wb-es-toast{position:fixed;z-index:2147483001;padding:6px 12px;border-radius:8px;font-size:12px;',
      'background:rgba(20,20,22,.92);color:#fff;pointer-events:none;opacity:0;transition:opacity .16s;}',

      '@media (prefers-reduced-motion:reduce){',
      '.wb-es-sweep{animation:none;}',
      '.wb-es-star{animation-duration:9s!important;}',
      '.wb-es-knob{transition-duration:.14s!important;}}'
    ].join('');

    var st = el('style', null, { id: STYLE_ID });
    st.textContent = css;
    (document.head || document.documentElement).appendChild(st);
  }

  /* ------------------------------------------------------------------ */
  /* 挂载                                                                */
  /* ------------------------------------------------------------------ */
  function mount(panel) {
    if (panel.__wbEs) { refresh(panel.__wbEs); return panel.__wbEs; }

    var items = childItems(panel);
    var toggleRow = findToggleRow(panel);
    var off = items.length === 0;

    /* 关态面板里没有任何档位可读 —— 不从零挂载。
       只有"本来有档位、随后被关掉"的同一个面板实例才切到关态（syncFromDom 处理） */
    if (off) return null;

    ensureStyle();

    var theme = panelTheme(panel);
    var st = {
      panel: panel,
      hasToggle: !!toggleRow,
      items: items,
      off: false,
      levelCount: items.length,
      levelLabels: items.map(itemLabel),
      labelText: '',
      stop: 0,
      pct: 0,
      dragging: false,
      pointerId: null,
      enabling: false,
      minStop: 0,
      dragPct: 0,
      snapTimer: 0,
      pendingStop: -1,
      applyTimer: null,
      lastApplyAt: 0,
      pendingLevel: null,
      theme: theme,
      stars: [],
      block: null,
      track: null,
      knob: null,
      ticks: [],
      ticksFor: -1,
      valueEl: null,
      headEl: null,
      headLabel: null,
      headValue: null,
      labelEl: null,
      obs: null
    };
    st.stop = activeStop(items);
    st.pct = pctOfStop(st, st.stop);

    panel.__wbEs = st;
    panel.setAttribute('data-wb-es', '1');
    panel.setAttribute('data-wb-es-hide', settings.showOfficial ? '0' : '1');

    /* ---- 结构 ---- */
    var block = el('div', 'wb-es');
    block.setAttribute('data-anim', settings.animation);
    block.setAttribute('data-theme', theme);
    block.setAttribute('data-off', '0');

    var head = el('div', 'wb-es-head');
    var headLabel = el('span', 'wb-es-head-label');
    var headValue = el('span', 'wb-es-head-value');
    head.appendChild(headLabel);
    head.appendChild(headValue);

    var track = el('div', 'wb-es-track', {
      role: 'slider',
      tabindex: '0',
      'aria-label': '思考强度',
      title: '拖动调整：最左 = 关闭思考 · 右键设置'
    });

    var clip = el('div', 'wb-es-clip');
    var fill = el('div', 'wb-es-fill');
    var nebula = el('div', 'wb-es-nebula');
    var sweep = el('div', 'wb-es-sweep');
    var starLayer = el('div', 'wb-es-stars');
    var ticks = el('div', 'wb-es-ticks');
    var knob = el('div', 'wb-es-knob');

    clip.appendChild(fill);
    clip.appendChild(nebula);
    clip.appendChild(sweep);
    clip.appendChild(starLayer);
    track.appendChild(clip);
    track.appendChild(ticks);
    track.appendChild(knob);
    block.appendChild(head);
    block.appendChild(track);

    /* 星尘：一次建满，按能量控制显隐（不重建 → 已挂载动画相位不跳） */
    for (var i = 0; i < STAR_COUNT; i++) {
      var star = el('span', 'wb-es-star');
      var dot = el('span', 'wb-es-star-dot');
      var slot = (i + 0.5) / STAR_COUNT;
      var jitter = (hash01(i, 7) - 0.5) * 0.55 / STAR_COUNT;
      var y = 8 + 84 * clamp(slot + jitter, 0, 1);
      var b = 0.5 + 0.5 * hash01(i, 29);
      star.style.top = y.toFixed(2) + '%';
      star.style.animationDelay = (-hash01(i, 13) * 10).toFixed(2) + 's';
      dot.style.setProperty('--b', b.toFixed(3));
      star.style.display = 'none';
      star.appendChild(dot);
      starLayer.appendChild(star);
      st.stars.push(star);
    }

    st.block = block;
    st.track = track;
    st.knob = knob;
    st.headEl = head;
    st.headLabel = headLabel;
    st.headValue = headValue;

    /* ---- 挂到官方面板 ---- */
    var label = findLabel(panel);
    st.labelEl = label;
    if (label) {
      st.labelText = labelTextOf(label);
      label.parentNode.insertBefore(block, label.nextSibling);
      var val = el('span', 'wb-es-value');
      label.appendChild(val);
      st.valueEl = val;
    } else if (toggleRow && toggleRow.parentNode) {
      toggleRow.parentNode.insertBefore(block, toggleRow.nextSibling);
    } else {
      panel.appendChild(block);
    }

    buildTicks(st);
    bind(st);

    try {
      st.obs = new MutationObserver(function (muts) {
        if (st.muted) return;
        /* 只由我们自己那块 DOM 引起的变动，直接忽略（否则 render 写文字会把观察器自己叫醒） */
        var selfOnly = true;
        for (var m = 0; m < muts.length; m++) {
          var tg = muts[m].target;
          if (!(tg === block || block.contains(tg))) { selfOnly = false; break; }
        }
        if (selfOnly) return;
        if (!panel.isConnected) { destroy(st); return; }
        if (st.dragging) { syncQuiet(st); return; }
        syncFromDom(st);
        if (!block.isConnected) { destroy(st); mount(panel); }
      });
      st.obs.observe(panel, { childList: true, attributes: true, attributeFilter: ['class'], subtree: true });
    } catch (e) { /* ignore */ }

    render(st, st.pct, true);
    log('mount', { n: st.levelCount, theme: theme });
    return st;
  }

  function destroy(st) {
    if (!st) return;
    try { if (st.obs) st.obs.disconnect(); } catch (e) { /* ignore */ }
    try {
      if (st.valueEl && st.valueEl.parentNode) st.valueEl.parentNode.removeChild(st.valueEl);
      if (st.block && st.block.parentNode) st.block.parentNode.removeChild(st.block);
      if (st.panel) {
        st.panel.removeAttribute('data-wb-es');
        st.panel.removeAttribute('data-wb-es-hide');
        st.panel.style.removeProperty('--wb-es-ring');
        st.panel.style.removeProperty('--wb-es-halo');
        delete st.panel.__wbEs;
      }
    } catch (e) { /* ignore */ }
    if (active === st) active = null;
    log('destroy', {});
  }

  /* ------------------------------------------------------------------ */
  /* 停止点映射：stop 0 = 关，stop i(1..n) = 第 i 个档位                   */
  /* ------------------------------------------------------------------ */
  function pctOfStop(st, stop) {
    var n = st.levelCount;
    if (st.off || !n) return 0;
    /* 滑条只覆盖档位本身：第 1 档贴左端、最后一档贴右端。
       "关"不在滑条上 —— 拉到最左就关思考会把面板内容抽掉、弹层跟着关闭。 */
    if (n <= 1) return 0;
    return clamp((stop - 1) / (n - 1), 0, 1);
  }

  function stopFromPct(st, pct) {
    var n = st.levelCount;
    if (!n) return 1;
    if (n <= 1) return 1;
    return clamp(Math.round(pct * (n - 1)) + 1, 1, n);
  }

  function activeStop(items) {
    for (var k = 0; k < items.length; k++) if (isActive(items[k])) return k + 1;
    return 0;
  }

  /* ------------------------------------------------------------------ */
  /* 渲染                                                                */
  /* ------------------------------------------------------------------ */
  function render(st, pct, force) {
    /* 官方每次重渲染都会换掉小标题节点，我们的数值节点会跟着被带走 —— 每次渲染前先自愈 */
    ensurePlacement(st);
    pct = clamp(pct, 0, 1);
    st.pct = pct;

    var stop = st.off ? 0 : stopFromPct(st, pct);
    /* 单档模型没有"区间"，pct 只有 0/1 —— 不能把唯一一档当成最高能量 */
    var intensity = pct;
    if (!st.off && st.levelCount <= 1) intensity = stop === 0 ? 0 : 1 / 3;
    var energy = st.off ? 0 : energyFor(intensity);
    var end = fillColorFor(intensity);

    st.block.setAttribute('data-off', st.off ? '1' : '0');
    st.block.style.setProperty('--p', pct.toFixed(4));
    st.block.style.setProperty('--wb-es-energy', (settings.glow ? energy : 0).toFixed(3));
    st.block.style.setProperty('--wb-es-end', rgb(end));

    var nebula = st.block.querySelector('.wb-es-nebula');
    var sweep = st.block.querySelector('.wb-es-sweep');
    var starHost = st.block.querySelector('.wb-es-stars');
    if (nebula) nebula.style.opacity = energy.toFixed(3);
    if (sweep) sweep.style.opacity = energy.toFixed(3);
    if (starHost) starHost.style.opacity = starLayerOpacityFor(intensity).toFixed(3);

    var count = particleCountFor(intensity);
    var dur = (STAR_MEAN_MS * SPEED_MAX) / speedFor(intensity);
    for (var i = 0; i < st.stars.length; i++) {
      var s = st.stars[i];
      var on = !st.off && i < count;
      s.style.display = on ? '' : 'none';
      if (on) {
        var spread = 1 + (hash01(i, 41) - 0.5) * 0.16;
        s.style.animationDuration = (dur * spread).toFixed(0) + 'ms';
      }
    }

    for (var k = 0; k < st.ticks.length; k++) {
      var t = st.ticks[k];
      var c;
      if (settings.ticks === 'hidden') c = 'transparent';
      else if (k <= stop) c = settings.ticks === 'bright' ? 'rgba(255,255,255,.5)' : 'color-mix(in srgb, var(--cr-text-primary,#0f1115) 26%, transparent)';
      else c = 'color-mix(in srgb, var(--cr-text-primary,#0f1115) 26%, transparent)';
      t.style.background = c;
    }

    var name;
    if (st.off) {
      name = offWord(st.labelText);
    } else if (stop === 0) {
      name = offWord(st.items.length ? itemLabel(st.items[0]) : '');
    } else {
      name = itemLabel(st.items[stop - 1]);
    }

    if (st.headLabel) {
      var hl = st.labelText || '思考强度';
      if (st.headLabel.textContent !== hl) st.headLabel.textContent = hl;
    }
    if (st.headValue) {
      if (st.headValue.textContent !== name) st.headValue.textContent = name;
      st.headValue.style.color = (st.off || stop === 0) ? '' : valueColorFor(intensity, st.theme);
    }

    if (st.valueEl) {
      if (st.valueEl.textContent !== name) st.valueEl.textContent = name;
      st.valueEl.style.color = (st.off || stop === 0) ? '' : valueColorFor(intensity, st.theme);
    }

    if (force) {
      st.track.setAttribute('aria-valuemin', '0');
      st.track.setAttribute('aria-valuemax', String(st.off ? 0 : st.levelCount));
    }
    st.track.setAttribute('aria-valuenow', String(stop));
    st.track.setAttribute('aria-valuetext', name);
  }

  function buildTicks(st) {
    if (st.ticksFor === st.levelCount) return;
    st.ticksFor = st.levelCount;
    var host = st.track.querySelector('.wb-es-ticks');
    while (st.ticks.length) {
      var t = st.ticks.pop();
      if (t.parentNode) t.parentNode.removeChild(t);
    }
    if (!st.levelCount) return;
    var n = st.levelCount;
    if (n <= 1) return;
    for (var i = 0; i < n; i++) {
      var tick = el('span', 'wb-es-tick');
      tick.style.left = 'calc(16px + (100% - 32px) * ' + (i / (n - 1)).toFixed(4) + ')';
      host.appendChild(tick);
      st.ticks.push(tick);
    }
  }

  /* ------------------------------------------------------------------ */
  /* 与官方状态同步                                                       */
  /* ------------------------------------------------------------------ */
  function readState(panel) {
    var items = childItems(panel);
    return { items: items, toggle: findToggleRow(panel), off: items.length === 0 };
  }

  /** 保证滑条永远紧跟在官方「思考强度」小标题后面；关态则跟在开关行后面 */
  function ensurePlacement(st) {
    var label = findLabel(st.panel);
    if (label) {
      st.labelEl = label;
      st.labelText = labelTextOf(label);
      /* 只有"滑条跑到小标题前面了"或"小标题被官方换掉了"才需要移动。
         仅仅因为中间插进了（被隐藏的）档位项就挪一次，会把整条星尘的 CSS 动画重启 —— 看起来就是闪一下。 */
      var beforeLabel = (st.block.compareDocumentPosition(label) & 4) !== 0;  /* 4 = label 在 block 之后 → 滑条跑到前面了 */
      if (st.labelEl !== label || beforeLabel) {
        label.parentNode.insertBefore(st.block, label.nextSibling);
      }
      if (!st.valueEl || !st.valueEl.isConnected) {
        var val = el('span', 'wb-es-value');
        label.appendChild(val);
        st.valueEl = val;
      }
      return;
    }
    st.valueEl = null;
    var row = findToggleRow(st.panel);
    if (row && row.parentNode && row.nextElementSibling !== st.block) {
      row.parentNode.insertBefore(st.block, row.nextSibling);
    }
  }

  function syncQuiet(st) {
    /* 拖拽途中点档位同样会让官方重刷小标题，这里也要把数值节点补回来 */
    ensurePlacement(st);
    var s = readState(st.panel);
    if (s.off !== st.off) {
      st.off = s.off;
      st.items = s.items;
      if (!s.off) {
        st.levelCount = s.items.length;
        buildTicks(st);
      }
      render(st, st.off ? 0 : pctOfStop(st, st.stop));
    }
  }

  function syncFromDom(st) {
    var s = readState(st.panel);
    var wasOff = st.off;
    st.items = s.items;
    st.off = s.off;

    if (st.off) {
      st.stop = 0;
    } else {
      st.levelCount = s.items.length;
      if (st.pendingLevel != null) {
        var lv = clamp(st.pendingLevel, 0, st.levelCount - 1);
        st.pendingLevel = null;
        var it = s.items[lv];
        if (it && !isActive(it)) {
          setTimeout(function () { try { it.click(); } catch (e) { /* ignore */ } }, 40);
        }
      }
      st.stop = activeStop(s.items);
    }

    buildTicks(st);
    var target = pctOfStop(st, st.stop);
    /* 以前这里在"没开关状态变化"时用 st.pct —— 结果点了官方档位，滑条不动。
       syncFromDom 只在非拖拽时调用，直接按目标位置渲染即可。 */
    render(st, target);
  }

  /* ------------------------------------------------------------------ */
  /* 写回官方                                                             */
  /* ------------------------------------------------------------------ */
  /* 每个滑条自己的待写入状态：以前是全局变量，两个面板同时存在时会互相踩 */
  function queueApply(st, stop) {
    st.pendingStop = stop;
    /* stop 0 = 关：拖拽途中只记下，松手才真正写，免得"路过最左"把思考关掉又开回来 */
    if (stop === 0) return;
    /* 防抖：拖拽途中不断重置计时器，只有"停住"或松手才真正写。
       以前是节流（每 120ms 写一次），一次快拖会连写 2~3 次，每写一次面板就重画一次，
       圆点看似被"抽"几下 —— 那才是动画不连贯的真正原因。 */
    if (st.applyTimer) clearTimeout(st.applyTimer);
    st.applyTimer = setTimeout(function () { st.applyTimer = null; flushApply(st); }, APPLY_INTERVAL);
  }

  function flushApply(st) {
    if (st.applyTimer) { clearTimeout(st.applyTimer); st.applyTimer = null; }
    if (st.pendingStop == null || st.pendingStop < 0) return;
    var stop = st.pendingStop;
    st.pendingStop = -1;
    applyStop(st, stop);
  }

  function applyStop(st, stop) {
    if (st.off) {
      if (stop <= 0) return;
      st.pendingLevel = stop - 1;
      if (!st.enabling) { st.enabling = true; clickToggle(st); }
      log('enable', { level: stop - 1 });
      return;
    }
    if (stop === 0) {
      clickToggle(st);          /* 最左 = 关 */
      log('disable', {});
      return;
    }
    var items = childItems(st.panel);
    var item = items[stop - 1];
    if (!item) { log('apply-miss', { stop: stop }); return; }
    if (isActive(item)) return;
    st.lastApplyAt = Date.now();
    log('apply', { stop: stop, text: itemLabel(item) });
    try { item.click(); } catch (e) { log('apply-error', String((e && e.message) || e)); }
  }

  function clickToggle(st) {
    var ctl = findToggleControl(st.panel);
    if (!ctl) { log('toggle-miss', {}); return; }
    try { ctl.click(); } catch (e) { log('toggle-error', String((e && e.message) || e)); }
  }

  /* ------------------------------------------------------------------ */
  /* 指针 / 键盘                                                         */
  /* ------------------------------------------------------------------ */
  function pctAt(st, clientX) {
    var r = st.track.getBoundingClientRect();
    if (!r.width) return st.pct;
    var inner = r.width - TRACK_H;
    if (inner <= 0) return 0;
    return clamp((clientX - r.left - INSET) / inner, 0, 1);
  }

  /** fast 模式：带滞回的档位吸附（越过 1/3 档距才切，退回 1/3 才回） */
  function steppedStop(pct, n, cur) {
    if (!n) return 1;
    if (n <= 1) return 1;
    var step = 1 / (n - 1);
    var idx = clamp(cur || 1, 1, n);
    /* 只朝一个方向走：先试向右，走不动才试向左。
       两个 while 都跑会让刚进的一格立刻被"后退"判断撤销（指针一直卡在半路）。 */
    while (idx < n && pct >= (idx - 1 + 1 / 3) * step) idx++;
    if (idx === cur) {
      while (idx > 1 && pct <= (idx - 1 - 1 / 3) * step) idx--;
    }
    return idx;
  }

  function setStop(st, stop) {
    stop = clamp(stop, st.minStop, st.levelCount);
    if (stop === st.stop) return;
    st.stop = stop;
    render(st, pctOfStop(st, stop));
    queueApply(st, stop);
  }

  /** 松手归位：临时打开 left/width 的过渡，滑过去而不是跳过去 */
  function snapTo(st, pct) {
    st.block.setAttribute('data-snap', '1');
    render(st, pct);
    clearTimeout(st.snapTimer);
    st.snapTimer = setTimeout(function () {
      if (st.block) st.block.removeAttribute('data-snap');
    }, 220);
  }

  function bind(st) {
    var track = st.track;

    function beginEnable() {
      if (!st.off || st.enabling) return;
      st.enabling = true;
      st.minStop = 1;              /* 本次拖拽不再回到"关"，避免来回闪 */
      st.pendingLevel = null;
      clickToggle(st);
      log('enable-gesture', {});
    }

    function onDown(e) {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      st.dragging = true;
      st.pointerId = e.pointerId;
      st.minStop = 0;
      st.block.setAttribute('data-drag', '1');
      try { track.focus({ preventScroll: true }); } catch (err) { /* ignore */ }
      try { track.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }

      var pct = pctAt(st, e.clientX);
      st.dragPct = pct;

      if (st.off) {
        if (pct > ENABLE_THRESHOLD) beginEnable();
      } else if (settings.animation === 'fast') {
        setStop(st, stopFromPct(st, pct));
      } else {
        st.stop = stopFromPct(st, pct);
        render(st, pct);
        queueApply(st, st.stop);
      }

      window.addEventListener('pointermove', onMove, true);
      window.addEventListener('pointerup', onUp, true);
      window.addEventListener('pointercancel', onUp, true);
      log('pointerdown', { pct: pct, off: st.off });
    }

    function onMove(e) {
      if (!st.dragging) return;
      e.preventDefault();
      e.stopPropagation();
      var pct = pctAt(st, e.clientX);
      st.dragPct = pct;

      if (st.off) {
        if (pct > ENABLE_THRESHOLD) beginEnable();
        return;
      }
      if (settings.animation === 'fast') {
        setStop(st, steppedStop(pct, st.levelCount, st.stop));
      } else {
        st.stop = stopFromPct(st, pct);
        render(st, pct);
        queueApply(st, st.stop);
      }
    }

    function onUp(e) {
      if (!st.dragging) return;
      st.dragging = false;
      st.enabling = false;
      st.minStop = 0;
      st.block.removeAttribute('data-drag');
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', onUp, true);
      window.removeEventListener('pointercancel', onUp, true);
      try { track.releasePointerCapture(st.pointerId); } catch (err) { /* ignore */ }

      if (st.off) {
        if (st.dragPct > ENABLE_THRESHOLD) { beginEnable(); return; }
        render(st, 0);
        st.pendingStop = 0;
        flushApply(st);
        return;
      }
      /* 快速模式：旋钮本来就停在档位格上，松手**不再按指针重算最近档** ——
         滞回边界和"最近档"不是同一个点，重算会让旋钮回跳一格（就是那个"明显变动"） */
      if (settings.animation === 'fast') {
        st.pendingStop = st.stop;
        flushApply(st);
        ensurePlacement(st);          /* 官方可能刚重刷过小标题，把数值节点补回来 */
        render(st, st.pct);           /* pct 没变 → 只是补文字/颜色，不会产生位移 */
        log('pointerup', { stop: st.stop, mode: 'fast' });
        return;
      }

      var pct = pctAt(st, e.clientX);
      var stop = stopFromPct(st, pct);
      st.stop = stop;
      /* 简洁/完整模式是连续跟手的，松手要归位 —— 用 160ms 滑过去，而不是硬跳 */
      snapTo(st, pctOfStop(st, stop));
      st.pendingStop = stop;
      flushApply(st);
      log('pointerup', { stop: stop, mode: settings.animation });
    }

    function onKey(e) {
      var n = st.levelCount;
      var idx = st.stop;
      if (e.key === 'ArrowRight' || e.key === 'ArrowUp') idx = clamp(idx + 1, 0, n);
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') idx = clamp(idx - 1, 0, n);
      else if (e.key === 'Home') idx = 0;
      else if (e.key === 'End') idx = n;
      else return;
      e.preventDefault();
      e.stopPropagation();
      st.stop = idx;
      render(st, pctOfStop(st, idx));
      st.pendingStop = idx;
      flushApply(st);
    }

    function onCtx(e) {
      e.preventDefault();
      e.stopPropagation();
      openSettings(st, e.clientX, e.clientY);
    }

    track.addEventListener('pointerdown', onDown, true);
    track.addEventListener('pointermove', function (e) { if (st.dragging) e.stopPropagation(); }, true);
    track.addEventListener('pointerup', function (e) { e.stopPropagation(); }, true);
    track.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); }, true);
    track.addEventListener('dblclick', function (e) { e.stopPropagation(); }, true);
    track.addEventListener('contextmenu', onCtx, true);
    track.addEventListener('keydown', onKey, true);
  }

  /* ------------------------------------------------------------------ */
  /* 设置面板                                                            */
  /* ------------------------------------------------------------------ */
  var pop = null;
  var toastEl = null;
  var toastTimer = 0;

  function clearSettingsMarkers() {
    var a = document.querySelectorAll('[data-wb-es-settings="1"]');
    for (var i = 0; i < a.length; i++) a[i].removeAttribute('data-wb-es-settings');
  }

  function closeSettings() {
    clearSettingsMarkers();
    if (pop && pop.parentNode) pop.parentNode.removeChild(pop);
    pop = null;
    document.removeEventListener('pointerdown', onPopOutside, true);
    document.removeEventListener('keydown', onPopKey, true);
  }

  function onPopOutside(e) {
    if (pop && !pop.contains(e.target)) closeSettings();
  }

  function onPopKey(e) {
    if (e.key === 'Escape') { e.stopPropagation(); closeSettings(); }
  }

  function seg(key, options, current) {
    var wrap = el('div', 'wb-es-seg');
    options.forEach(function (o) {
      var b = el('button', null, { type: 'button', 'data-v': o.v });
      b.textContent = o.t;
      if (o.v === current) b.setAttribute('data-on', '1');
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        settings[key] = o.v;
        saveSettings();
        applySettings();
        var kids = wrap.children;
        for (var i = 0; i < kids.length; i++) kids[i].removeAttribute('data-on');
        b.setAttribute('data-on', '1');
      });
      wrap.appendChild(b);
    });
    return wrap;
  }

  function switchEl(key, current) {
    var w = el('div', 'wb-es-sw', { role: 'switch' });
    if (current) w.setAttribute('data-on', '1');
    w.appendChild(el('i'));
    w.addEventListener('click', function (e) {
      e.stopPropagation();
      settings[key] = !settings[key];
      saveSettings();
      applySettings();
      if (settings[key]) w.setAttribute('data-on', '1'); else w.removeAttribute('data-on');
    });
    return w;
  }

  function openSettings(st, x, y) {
    closeSettings();
    pop = el('div', 'wb-es-pop');
    pop.setAttribute('data-theme', st.theme);

    var hd = el('div', 'wb-es-pop-hd');
    var b = el('b'); b.textContent = '思考强度滑条';
    var v = el('span'); v.textContent = 'v' + VERSION;
    hd.appendChild(b); hd.appendChild(v);
    pop.appendChild(hd);

    function row(label, ctrl) {
      var r = el('div', 'wb-es-pop-row');
      var s = el('span'); s.textContent = label;
      r.appendChild(s); r.appendChild(ctrl);
      pop.appendChild(r);
      return r;
    }

    row('动画效果', seg('animation', [
      { v: 'simple', t: '简洁' }, { v: 'full', t: '完整' }
    ], settings.animation === 'fast' ? 'simple' : settings.animation));

    row('刻度点', seg('ticks', [
      { v: 'bright', t: '亮白' }, { v: 'same', t: '同色' }, { v: 'hidden', t: '隐藏' }
    ], settings.ticks));

    row('官方档位列表', switchEl('showOfficial', settings.showOfficial));
    row('面板紫边', switchEl('glow', settings.glow));

    var ft = el('div', 'wb-es-pop-ft');
    var diagBtn = el('button', null, { type: 'button' });
    diagBtn.textContent = '复制诊断';
    diagBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      copyDiag(st);
    });
    var resetBtn = el('button', null, { type: 'button' });
    resetBtn.textContent = '恢复默认';
    resetBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      settings = { animation: DEFAULTS.animation, ticks: DEFAULTS.ticks, showOfficial: DEFAULTS.showOfficial, glow: DEFAULTS.glow };
      saveSettings();
      applySettings();
      closeSettings();
      toast('已恢复默认');
    });
    ft.appendChild(diagBtn);
    ft.appendChild(resetBtn);
    pop.appendChild(ft);

    /* 挂到滑条所在的那层浮动容器里：官方判断"点了外面"是按菜单本体算的，
       挂在 popover 的兄弟位置照样会被判成外面 → 菜单被关掉。 */
    /* 内联模式下：直接插在滑条后面、卡片自己变高。
       子菜单是 hover 弹层，浮在外面的面板会把指针带出弹层 → 菜单被关掉。 */
    /* 两种模式都走"在容器里展开"：内联是子菜单，独立面板是那个小卡片。
       两者都是 hover 弹层，浮在 body 上的面板会把指针带出弹层 → 菜单被关。 */
    var parentCls = (st.block && st.block.parentNode && String(st.block.parentNode.className)) || '';
    var inlineHost = parentCls.indexOf('cr-model-selector__sub-panel') >= 0;
    if (inlineHost && st.block.parentNode) {
      pop.classList.add('wb-es-pop--inline');
      st.block.parentNode.appendChild(pop);
      /* 打开设置时收起占地方的行：卡片是从菜单项向下长的，展开太多会被窗口底边裁掉 */
      var panelEl = st.block.parentNode;
      panelEl.setAttribute('data-wb-es-settings', '1');
      var smEl = panelEl.closest('[class*="model-selector__sub-menu"]');
      if (smEl) smEl.setAttribute('data-wb-es-settings', '1');
    } else {
      document.body.appendChild(pop);
      var r = pop.getBoundingClientRect();
      var left = clamp(x - r.width / 2, 8, window.innerWidth - r.width - 8);
      var top = y + 8;
      if (top + r.height > window.innerHeight - 8) top = Math.max(8, y - r.height - 8);
      pop.style.left = Math.round(left) + 'px';
      pop.style.top = Math.round(top) + 'px';
    }

    setTimeout(function () {
      document.addEventListener('pointerdown', onPopOutside, true);
      document.addEventListener('keydown', onPopKey, true);
    }, 0);

    pop.addEventListener('pointerdown', function (e) { e.stopPropagation(); }, false);
    pop.addEventListener('contextmenu', function (e) { e.preventDefault(); e.stopPropagation(); }, true);
    log('settings-open', {});
  }

  function applySettings() {
    var list = document.querySelectorAll('.wb-es');
    for (var i = 0; i < list.length; i++) list[i].setAttribute('data-anim', settings.animation);
    var panels = document.querySelectorAll('.cr-model-selector__sub-panel[data-wb-es]');
    for (var j = 0; j < panels.length; j++) {
      panels[j].setAttribute('data-wb-es-hide', settings.showOfficial ? '0' : '1');
      var s = panels[j].__wbEs;
      if (s) render(s, s.pct, false);
    }
  }

  function toast(msg) {
    if (!toastEl) {
      toastEl = el('div', 'wb-es-toast');
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.style.left = '50%';
    toastEl.style.top = '18%';
    toastEl.style.transform = 'translateX(-50%)';
    toastEl.style.opacity = '1';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.style.opacity = '0'; }, 1300);
  }

  function copyDiag(st) {
    var payload = {
      version: VERSION,
      theme: st ? st.theme : '?',
      settings: settings,
      off: st ? st.off : null,
      levels: st ? st.items.map(itemLabel) : [],
      stop: st ? st.stop : -1,
      events: diag.slice(-120)
    };
    var text = JSON.stringify(payload, null, 2);
    var done = function () { toast('诊断已复制'); };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text); done(); });
      } else { fallbackCopy(text); done(); }
    } catch (e) { fallbackCopy(text); done(); }
  }

  function fallbackCopy(text) {
    try {
      var ta = el('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    } catch (e) { /* ignore */ }
  }

  /* ------------------------------------------------------------------ */
  /* 发现官方面板（只看新增节点，不做全量扫描）                            */
  /* ------------------------------------------------------------------ */
  var active = null;

  function looksLikeEffortPanel(panel) {
    var items = childItems(panel);
    var toggle = findToggleRow(panel);
    /* 思考模式开关只出现在思考强度面板 —— 最强的结构锚点，且与语言无关 */
    if (toggle) return true;
    if (items.length < 2 || items.length > 8) return false;
    var hits = 0;
    for (var i = 0; i < items.length; i++) {
      if (NAME_TO_ID[norm(itemLabel(items[i]))]) hits++;
    }
    return hits >= Math.min(items.length, Math.max(2, Math.ceil(items.length * 0.6)));
  }

  function tryMount(panel) {
    if (!panel || !panel.isConnected) return;
    try {
      if (panel.__wbEs) { refresh(panel.__wbEs); return; }
      if (!looksLikeEffortPanel(panel)) return;
      var st = mount(panel);
      if (st) active = st;
    } catch (e) {
      log('mount-error', String((e && e.message) || e));
    }
  }

  function refresh(st) {
    if (!st || !st.panel || !st.panel.isConnected) return;
    if (st.block && !st.block.isConnected) { destroy(st); mount(st.panel); return; }
    if (st.dragging) { syncQuiet(st); return; }
    syncFromDom(st);
  }

  function consider(node) {
    if (!node || node.nodeType !== 1) return;
    var panel = null;
    if (hasToken(node, 'model-selector__sub-panel')) panel = node;
    else if (node.closest && (panel = node.closest(SEL_PANEL))) { /* noop */ }
    else if (node.querySelector) panel = node.querySelector(SEL_PANEL);

    if (panel && hasToken(panel, 'model-selector__sub-panel')) { tryMount(panel); return; }

    var up = node.parentElement;
    for (var i = 0; i < 2 && up; i++, up = up.parentElement) {
      if (hasToken(up, 'model-selector__sub-panel')) { tryMount(up); return; }
    }
  }

  function onMutations(muts) {
    for (var i = 0; i < muts.length; i++) {
      var added = muts[i].addedNodes;
      for (var j = 0; j < added.length; j++) consider(added[j]);
    }
    if (active && (!active.panel || !active.panel.isConnected)) active = null;
  }

  function start() {
    if (!document.body) { setTimeout(start, 30); return; }
    ensureStyle();
    var obs = new MutationObserver(onMutations);
    obs.observe(document.body, { childList: true, subtree: true });

    var existing = document.querySelectorAll(SEL_PANEL);
    for (var i = 0; i < existing.length; i++) {
      if (hasToken(existing[i], 'model-selector__sub-panel')) tryMount(existing[i]);
    }
    try { window.__WB_EFFORT_SLIDER_DIAG__ = diag; } catch (e) { /* ignore */ }

    /* 状态快照：写进 localStorage，出问题时不用开 devtools 也能看出来 */
    var lastSnap = '';
    function publishState() {
      try {
        var blocks = document.querySelectorAll('.wb-es');
        var info = [];
        for (var i = 0; i < blocks.length; i++) {
          var b = blocks[i], panel = b.parentNode && b.parentNode.__wbEs;
          info.push({
            p: b.style.getPropertyValue('--p'),
            off: b.getAttribute('data-off'),
            stop: panel ? panel.stop : null,
            lv: panel ? panel.levelCount : null,
            items: panel ? panel.items.length : null
          });
        }
        var snap = JSON.stringify({
          v: VERSION,
          cur: curInfo,
          panels: document.querySelectorAll('[class*="model-selector__sub-panel"]').length,
          sliders: blocks.length,
          blocks: info,
          last: diag.slice(-6).map(function (d) { return d.k; }).join(',')
        });
        if (snap !== lastSnap) { lastSnap = snap; localStorage.setItem('wb-es-state', snap); }
      } catch (e) { /* ignore */ }
    }
    setInterval(publishState, 2500);
    publishState();
    log('start', { v: VERSION });
  }

  function boot() {
    try {
      start();
    } catch (e) {
      log('boot-error', String((e && e.message) || e));
    }
  }

  try {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', boot, { once: true });
    } else {
      boot();
    }
  } catch (e) { /* 连注册失败都不影响页面 */ }
})();
