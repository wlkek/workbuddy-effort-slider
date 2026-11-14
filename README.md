# WorkBuddy 思考强度滑条

把 WorkBuddy 模型菜单里的「思考强度」列表换成一条 **Codex 风格的连续滑条**。

> [!IMPORTANT]
> **2026-11-14：v3.0.0 复活，换了一套注入通道。**
>
> 5.9.2 起客户端把 renderer 打进 `app.asar` 并加了 SHA256 完整性校验，老的
> 「往 `app.asar.unpacked/renderer/index.html` 插 loader」彻底没有落点。
>
> v3 改成 **运行时注入**：用 Electron 的 `NODE_OPTIONS` fuse（当前 5.9.3 里是开着的）
> 在主进程启动时加载一个 hook，等主界面 `dom-ready` 后把 mod 脚本注入页面。
> **不再修改客户端任何文件**，卸载就是删快捷方式。

> **非官方项目**。与 WorkBuddy / 腾讯无任何关系。它通过运行时注入改动界面，
> 可能违反其服务条款，请自行判断是否使用。

> ⚡ **Vibe Coding 产物**：本项目为 100% Vibe Coding 协同产物——人类开发者提出架构与业务意图，AI 助手端到端完成逆向分析、DOM 结构测绘、注入方案设计与界面代码编写。

![效果](docs/screenshot.png)

## 它做了什么

官方菜单里，思考强度是「低 / 中 / 高 / 超高 / 极致」几项列表。这个项目把那些项**原地**换成一条滑条：

- 拖动 → 档位跟着变，档位名显示在标题右侧
- 颜色随强度从蓝到紫渐变，越往右星尘越密
- 滑条可以含「关」：拖到最左即关闭思考，和 Codex 一致

**写入仍然走官方路径**：你在滑条上松手时，它去点对应的官方档位项（或官方开关）。
所以档位状态、持久化、后端请求全是官方逻辑，不存在"自己维护一份状态"的问题。

## 安装（5.9.2 及以上）

1. 下载 Release 里的 zip，解压到任意目录
2. 双击 `install.cmd`
3. **托盘右键，完全退出 WorkBuddy**
4. 用桌面上的 **「WorkBuddy (mods)」** 快捷方式启动
5. 点开模型菜单 → 悬停某个模型 → 悬停「思考强度」

`install.cmd -Status` 看状态，`uninstall.cmd` 一键还原。

> [!WARNING]
> **必须用新快捷方式启动。** Windows 快捷方式不能带环境变量，所以 mod 靠 `launch.vbs`
> 注入。点原来的图标、或任务栏上固定的那个，启动的是没有 mod 的原版。

## 设置

右键滑条：

| 项 | 说明 |
|---|---|
| 动画效果 | `简洁` = 跟手 + 星尘；`完整` = 跟手 + 扫光 + 星尘 |
| 刻度点 | 轨道上的小圆点：亮白 / 同色 / 隐藏 |
| 官方档位列表 | 保留官方那几个列表项（默认关闭） |
| 面板紫边 | 面板外圈紫光 |

## 工作原理

```
WorkBuddy.exe
  └─ NODE_OPTIONS=--require "...\WbMods\hook.js"
       └─ main 进程启动，监听 web-contents-created
            └─ 主界面 dom-ready → executeJavaScript(mod.js)
                 └─ MutationObserver 发现档位面板 → 原地替换成滑条
```

`hook.js` 的三条硬约束：

1. 只处理 `process.type === 'browser'`，不碰渲染进程
2. 启动后立刻把 `--require` 从 `NODE_OPTIONS` 里摘掉，避免被 agent 的 node 子进程继承
3. 只在 `app.asar/renderer/index.html` 这个页面上注入，guest 页面一律跳过

## 兼容性

- 只测过 Windows 版；v2.x 对应 5.8.3，v3 对应 **5.9.2 / 5.9.3**
- 依赖官方 DOM 类名（`.cr-model-selector__sub-panel*`、`__item--active`），**官方改版可能失效**
- 5.9.2 起模型选择器多了「自定义模型」入口，档位面板可能是另一套节点；v3 用结构锚点（思考模式开关 + 档位文案）识别面板，语言无关
- 失效表现：滑条不出现，官方列表照常工作（fail-open，不会弄坏菜单）

## 排查

注入日志：`%LOCALAPPDATA%\WbMods\loader.log`

```
[..] loader start | pid=1234 | mods=effort-slider@3.0.0
[..] injected effort-slider@3.0.0
```

有 `loader start` 没有 `injected` → fuse 或启动方式不对；两行都没有 → 没用新快捷方式启动。

## 安全边界

- **不联网**、不读对话内容、不采集数据，只操作模型菜单 DOM
- **不修改客户端任何文件**，只往 `%LOCALAPPDATA%\WbMods` 写自己的东西 + 建一个快捷方式
- **fail-open**：脚本出错时菜单照常显示，只是没有滑条
- 但注入本身有风险：`NODE_OPTIONS=--require` 是常见注入手法，部分杀软会拦；介意就别用

## 和「模型图标」共存

两个 mod 共用同一个 loader、同一个快捷方式，各自在 `mods/<id>/` 下独立安装。
先装哪个都行，卸载任意一个不影响另一个。

## 版本与提交记录

每个版本做了什么、为什么这么改，写在 [CHANGELOG.md](CHANGELOG.md) 里。

## License

MIT
