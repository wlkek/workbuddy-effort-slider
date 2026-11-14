# WorkBuddy 思考强度滑条

把 WorkBuddy 模型菜单里的「思考强度」列表换成一条 Codex 风格的连续滑条。

非官方 mod，和 WorkBuddy、腾讯都没关系。它通过运行时注入改界面，可能违反服务条款，
用不用自己判断。

![效果](docs/screenshot.png)

## 它做了什么

官方菜单里，思考强度是「低 / 中 / 高 / 超高 / 极致」几项列表。这个项目把那些项原地换成滑条：

- 拖动就换档，档位名显示在标题右侧
- 颜色随强度从蓝到紫渐变，越往右星尘越密
- 拖到最左是「关」，和 Codex 一致

**写入走官方路径**：松手时它去点对应的官方档位项（或官方开关）。
所以档位状态、持久化、后端请求全是官方逻辑，没有自己维护一份状态。

档位数量也跟模型走：客户端会按每个模型的能力把不支持的档位从列表里去掉，
滑条就跟着有几档。所以「拉满」= 这个模型支持的最高档，不会出现拉到最右却还是低档的情况。

## 安装

需要 WorkBuddy 5.9.2 或更新。

1. 下载 Release 的 zip，解压到随便哪个目录
2. 双击 `install.cmd`
3. 托盘右键完全退出 WorkBuddy
4. 用原来的图标启动
5. 点开模型菜单 → 悬停某个模型 → 悬停「思考强度」

安装器会**接管官方快捷方式**：把 `WorkBuddy.lnk` 改成先跑注入器再启动客户端。
原文件备份成 `WorkBuddy.lnk.wbmods.bak`，图标和名字都不变。

不想被接管就加 `-KeepOfficialIcon`，那样只能从新出现的「WorkBuddy (mods)」启动。

启动时可能闪过一个最小化的窗口，那是注入器。

### 路径不用自己填

装在哪个盘、目录叫什么、有没有中文和空格都不影响。安装器会依次试：

- 上次安装时记下的路径
- 正在运行的进程
- 注册表卸载项（`DisplayIcon`、`InstallLocation`、`UninstallString`）
- App Paths
- 桌面、公共桌面、开始菜单、任务栏固定项的快捷方式
- 默认安装位置

只要目录里有 `resources\app.asar` 就当作客户端。快捷方式不看文件名，
看目标或图标是不是指向 `WorkBuddy.exe`。

全落空会报错，用 `install.cmd -AppRoot "D:\你的路径\WorkBuddy"` 指定一次即可。

### 升级或移动之后

- 快捷方式指向 `%LOCALAPPDATA%\WbMods\node.exe`，这是客户端自带 node 的硬链接，
  不额外占空间。客户端升级换掉版本目录，图标也不会失效。
- 注入器找不到客户端时，会按 `config.json` 里存的候选路径逐个试。

## 设置

右键滑条：

| 项 | 说明 |
|---|---|
| 动画效果 | `简洁` = 跟手 + 星尘；`完整` = 跟手 + 扫光 + 星尘 |
| 刻度点 | 轨道上的小圆点：亮白 / 同色 / 隐藏 |
| 官方档位列表 | 保留官方那几个列表项（默认关闭）。打开后可以对照滑条位置和官方高亮项 |
| 面板紫边 | 面板外圈紫光 |

## 卸载

双击 `uninstall.cmd`。会删掉自己这份 mod，并把接管过的快捷方式还原。

`install.cmd -Status` 可以看当前状态。

## 工作原理

```
快捷方式 → node.exe injector.js
             ├─ 带 --inspect=<随机端口> 启动 WorkBuddy
             ├─ 连上主进程 inspector，注入一段 bootstrap
             ├─ bootstrap 挂 web-contents-created，页面 dom-ready 后执行 mod
             └─ 注入完 1.2 秒后关掉 inspector，不留调试端口
```

只注入 `app.asar/renderer/index.html`，guest 页面跳过。启动客户端时会清掉
`ELECTRON_RUN_AS_NODE`，免得跑成 node 模式。

之所以不用 `NODE_OPTIONS --require`：Electron 对打包应用只放行 NODE_OPTIONS 的一个
白名单，`--require` 不在里面。

## 兼容性

- Windows 10 / 11 x64，用 PowerShell 5.1，不用装别的东西
- 客户端 5.9.2 / 5.9.3 已验证，5.8.3 及更早用 v2.x
- 装在 Program Files 也行，不需要管理员权限。公共桌面的快捷方式没权限时会跳过
- 绿色解压版、包管理器装的版本可能没有注册表项也没有自带 node，自动识别会失败，
  用 `-AppRoot` 指定一次就行
- 失效时滑条不出现，官方列表照常工作

面板识别靠结构锚点（思考模式开关 + 档位文案），不依赖语言。5.9.2 新增的
「自定义模型」入口如果带独立的档位面板，滑条可能不出现。

## 排查

日志在 `%LOCALAPPDATA%\WbMods\loader.log`。正常一次长这样：

```
injector spawn app with --inspect=1999
main bootstrap ok, mods=2
injector evaluate => OK:2
main injected effort-slider@3.0.0
main inspector closed
```

| 现象 | 处理 |
|---|---|
| 日志没有新增 | 快捷方式没被接管，重跑一次 `install.cmd` |
| 有 `spawn app` 没有 `bootstrap ok` | 客户端已经在跑，先完全退出 |
| 有 `bootstrap ok` 没有 `injected` | 页面 URL 不匹配，客户端改版了 |
| `app exe not found` | 客户端被移动过，候选也失效了，重跑 `install.cmd` |

想确认注入器能不能找到客户端、有没有读到 mod，不用启动客户端：

```powershell
$env:WB_DRY_RUN=1
& "$env:LOCALAPPDATA\WbMods\node.exe" "$env:LOCALAPPDATA\WbMods\injector.js"
```

日志里会多一行 `dry-run app=<实际用到的路径> mods=[...]`。

任务栏固定项点了还是原版的话，右键取消固定，再从开始菜单重新固定。
Windows 有时会缓存旧的固定项。

## 安全

- 不联网、不读对话内容、不采集数据，只动模型菜单的 DOM
- 不改客户端任何文件，所有东西都在 `%LOCALAPPDATA%\WbMods`
- 会改快捷方式，但有备份，卸载会还原
- 调试端口启动后约 1 秒就关

## 测试

`tools/verify-apply.html` 是档位落点的回归测试：三个面板分别模拟 3 / 4 / 6 档的模型，
把滑条拖到最右，检查实际点击的是不是最后一项。用无头浏览器打开就能跑。

## 和「模型图标」一起用

两个 mod 共用同一个注入器和快捷方式，各自装在 `mods/<id>/` 下。
先装哪个都行，卸载任意一个不影响另一个。

## License

MIT
