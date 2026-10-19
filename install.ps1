param(
  [string]$AppRoot,
  [switch]$Uninstall,
  [switch]$Status,
  [switch]$Quiet
)

# WorkBuddy 思考强度滑条 —— 安装 / 卸载
# 只做三件事：备份入口文件 -> 生成带加载器的入口 -> 复制脚本
# 卸载 = 用备份还原，不留残留。

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$enc  = New-Object System.Text.UTF8Encoding($false)

function Say($msg, $color = 'Gray') { if (-not $Quiet) { Write-Host $msg -ForegroundColor $color } }

function Read-Utf8($p) { $enc.GetString([IO.File]::ReadAllBytes($p)) }

# ---------------------------------------------------------------- 定位安装目录
if (-not $AppRoot) {
  $candidates = @()
  $proc = Get-Process -Name 'WorkBuddy' -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($proc -and $proc.Path) { $candidates += (Split-Path -Parent $proc.Path) }
  $candidates += (Join-Path $env:LOCALAPPDATA 'Programs\WorkBuddy')
  $candidates += (Join-Path $env:ProgramFiles 'WorkBuddy')
  $candidates += 'D:\应用\wookbuddy\WorkBuddy'
  foreach ($c in $candidates) {
    if ($c -and (Test-Path (Join-Path $c 'resources\app.asar'))) { $AppRoot = $c; break }
  }
}
if (-not $AppRoot) { throw '找不到 WorkBuddy 安装目录，请用 -AppRoot 指定' }

$html   = Join-Path $AppRoot 'resources\app.asar.unpacked\renderer\index.html'
$bak    = "$html.wb-es.bak"
$dstDir = Join-Path $AppRoot 'resources\wb-effort-slider'
$dst    = Join-Path $dstDir 'wb-effort-slider.js'
$src    = Join-Path $here 'src\wb-effort-slider.js'
$build  = Join-Path $here 'tools\build-entry.ps1'

if (-not (Test-Path $html)) { throw "找不到入口文件：$html（用 -AppRoot 指定安装目录）" }

# ---------------------------------------------------------------- 状态
if ($Status) {
  $patched = (Read-Utf8 $html).Contains('wb-effort-slider/wb-effort-slider.js')
  Say ''
  Say ('  安装目录   : ' + $AppRoot)
  Say ('  index.html : ' + $(if ($patched) { '已注入' } else { '未注入' }))
  Say ('  备份       : ' + $(if (Test-Path $bak) { '有（index.html.wb-es.bak）' } else { '无' }))
  if (Test-Path $dst) {
    $ver = ([regex]::Match((Read-Utf8 $dst), "VERSION = '([0-9.]+)'")).Groups[1].Value
    Say ('  注入脚本   : v' + $ver + '  ' + $dst)
  } else {
    Say '  注入脚本   : 未安装'
  }
  Say ''
  exit 0
}

# ---------------------------------------------------------------- 卸载
if ($Uninstall) {
  if (Test-Path $bak) {
    Copy-Item $bak $html -Force
    Say '[OK] 已用备份还原 index.html' 'Green'
  } else {
    Say '[WARN] 没有备份，无法自动还原' 'Yellow'
  }
  if (Test-Path $dstDir) { Remove-Item $dstDir -Recurse -Force }
  Say '[OK] 已删除注入脚本目录'
  Say '     完全退出 WorkBuddy 再打开即可恢复原样'
  exit 0
}

# ---------------------------------------------------------------- 安装
if (-not (Test-Path $src)) { throw "找不到脚本：$src" }

$cur = Read-Utf8 $html
if (-not $cur.Contains('wb-effort-slider/wb-effort-slider.js')) {
  # 当前是干净的原版（首次安装，或客户端刚更新过）-> 刷新备份
  Copy-Item $html $bak -Force
  Say '[OK] 已备份 index.html -> index.html.wb-es.bak' 'Green'
} elseif (-not (Test-Path $bak)) {
  throw '入口已被改过但没有备份，请先手动还原 index.html 再安装'
}

$tmp = Join-Path $env:TEMP ('wb-es-entry-' + [guid]::NewGuid().ToString('N') + '.html')
& $build -Source $bak -Dest $tmp | Out-Null
Copy-Item $tmp $html -Force
Remove-Item $tmp -Force -ErrorAction SilentlyContinue

New-Item -ItemType Directory -Force -Path $dstDir | Out-Null
Copy-Item $src $dst -Force

$check = Read-Utf8 $html
if (-not $check.Contains('wb-effort-slider/wb-effort-slider.js')) { throw '写入后校验失败' }
if (-not (Test-Path $dst)) { throw '写入后校验失败：脚本没复制成功' }

Say ''
Say '[OK] 安装完成' 'Green'
Say '     请**完全退出 WorkBuddy 再重新打开**（托盘退出，只关窗口不够）'
Say '     入口：输入框的模型按钮 -> 悬停某个模型 -> 悬停「思考强度」'
Say '     右键滑条可调设置；卸载用  .\install.cmd -Uninstall'
