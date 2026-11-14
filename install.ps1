param(
  [string]$AppRoot,
  [switch]$Uninstall,
  [switch]$Status,
  [switch]$KeepOfficialIcon
)

# WorkBuddy 思考强度滑条 —— 安装 / 卸载（5.9.2+ 新版通道）
# ------------------------------------------------------------------
# 不再改客户端任何文件。做法：
#   1. 把 loader 与 mod 复制到 %LOCALAPPDATA%\WbMods
#   2. 生成 launch.vbs（Node 模式跑 injector.js，由它带 --inspect 拉起客户端）
#   3. 在桌面 / 开始菜单建快捷方式指向 launch.vbs
# 卸载只删自己这一份，不影响其它 mod。

$ErrorActionPreference = 'Stop'
$ModId   = 'effort-slider'
$ModName = '思考强度滑条'
$here    = Split-Path -Parent $MyInvocation.MyCommand.Path
$dest    = Join-Path $env:LOCALAPPDATA 'WbMods'
$launch  = Join-Path $dest 'launch.vbs'
$shortcutName = 'WorkBuddy (mods).lnk'

# 官方用来启动客户端的快捷方式：接管它们，点原来的图标也能带 mod
$officialLnks = @(
  (Join-Path ([Environment]::GetFolderPath('Desktop')) 'WorkBuddy.lnk'),
  (Join-Path $env:PUBLIC 'Desktop\WorkBuddy.lnk'),
  (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\WorkBuddy.lnk'),
  (Join-Path $env:APPDATA 'Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar\WorkBuddy.lnk')
)

function Say($msg, $color = 'Gray') { Write-Host $msg -ForegroundColor $color }

function Find-AppRoot {
  $cands = @()
  Get-Process -Name 'WorkBuddy' -ErrorAction SilentlyContinue |
    ForEach-Object { if ($_.Path) { $cands += (Split-Path -Parent $_.Path) } }
  if ($env:LOCALAPPDATA) { $cands += (Join-Path $env:LOCALAPPDATA 'Programs\WorkBuddy') }
  if ($env:ProgramFiles)  { $cands += (Join-Path $env:ProgramFiles 'WorkBuddy') }
  if (${env:ProgramFiles(x86)}) { $cands += (Join-Path ${env:ProgramFiles(x86)} 'WorkBuddy') }
  $keys = @(
    'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*'
  )
  foreach ($k in $keys) {
    Get-ItemProperty $k -ErrorAction SilentlyContinue |
      Where-Object { $_.DisplayName -like '*WorkBuddy*' -and $_.InstallLocation } |
      ForEach-Object { $cands += $_.InstallLocation }
  }
  foreach ($c in $cands) {
    if ($c -and (Test-Path (Join-Path $c 'resources\app.asar'))) { return $c }
  }
  return $null
}

# 读 exe 里的 Electron fuse 串（sentinel + version + len + '0'/'1'）
function Get-FuseString([string]$exe) {
  $marker = 'dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX'
  $enc = [Text.Encoding]::GetEncoding(28591)
  $fs = [IO.File]::OpenRead($exe)
  try {
    $size = 8MB
    $overlap = 64
    $buf = New-Object byte[] $size
    $carry = ''
    while (($n = $fs.Read($buf, 0, $size)) -gt 0) {
      $s = $carry + $enc.GetString($buf, 0, $n)
      $i = $s.IndexOf($marker, [StringComparison]::Ordinal)
      if ($i -ge 0) {
        $p = $i + $marker.Length
        if ($s.Length -lt $p + 2) { return '' }
        $len = [int][char]$s[$p + 1]
        if ($s.Length -lt $p + 2 + $len) { return '' }
        return $s.Substring($p + 2, $len)
      }
      $carry = $s.Substring([Math]::Max(0, $s.Length - $overlap))
    }
  } finally { $fs.Dispose() }
  return $null
}

# ---------------------------------------------------------------- 定位
if (-not $AppRoot) { $AppRoot = Find-AppRoot }
if (-not $AppRoot) {
  Say '找不到 WorkBuddy 安装目录。请用 -AppRoot "D:\你的\WorkBuddy" 指定。' 'Red'
  exit 1
}
$exe = Join-Path $AppRoot 'WorkBuddy.exe'
if (-not (Test-Path $exe)) {
  Say "目录里没有 WorkBuddy.exe：$AppRoot" 'Red'
  exit 1
}

# ---------------------------------------------------------------- 状态
if ($Status) {
  Say ''
  Say "  安装目录 : $AppRoot"
  Say "  Mod 目录 : $dest"
  if (Test-Path (Join-Path $dest 'mods')) {
    Get-ChildItem (Join-Path $dest 'mods') -Directory | ForEach-Object {
      $mf = Join-Path $_.FullName 'manifest.json'
      $v = ''
      if (Test-Path $mf) {
        try { $v = (Get-Content $mf -Raw | ConvertFrom-Json).version } catch { }
      }
      Say ("  Mod      : " + $_.Name + " v" + $v)
    }
  } else { Say '  Mod      : 未安装' }
  Say ('  快捷方式 : ' + $(if (Test-Path (Join-Path ([Environment]::GetFolderPath('Desktop')) $shortcutName)) { '已创建' } else { '缺失' }))
  $fuseStr = Get-FuseString $exe
  if ($fuseStr) { Say ('  Fuse     : ' + $fuseStr + $(if ($fuseStr.Length -gt 2 -and $fuseStr[3] -eq '1') { '（--inspect 可用）' } else { '（--inspect 已被关闭，注入不可用）' })) }
  $log = Join-Path $dest 'loader.log'
  if (Test-Path $log) {
    Say '  最近日志 :'
    Get-Content $log -Tail 6 | ForEach-Object { Say ('    ' + $_) 'DarkGray' }
  }
  Say ''
  exit 0
}

# ---------------------------------------------------------------- 卸载
if ($Uninstall) {
  $mine = Join-Path $dest ('mods\' + $ModId)
  if (Test-Path $mine) { Remove-Item $mine -Recurse -Force; Say "[OK] 已删除 $ModName" 'Green' }
  else { Say '[--] 没有安装记录' 'Yellow' }

  $others = @()
  if (Test-Path (Join-Path $dest 'mods')) {
    $others = @(Get-ChildItem (Join-Path $dest 'mods') -Directory)
  }
  if ($others.Count -eq 0) {
    # 没有其它 mod 了，把被接管的官方快捷方式还原
    foreach ($lnk in $officialLnks) {
      $bak = $lnk + '.wbmods.bak'
      if (Test-Path $bak) {
        Copy-Item $bak $lnk -Force
        Remove-Item $bak -Force
        Say "[OK] 已还原：$lnk" 'Green'
      }
    }
    foreach ($p in @([Environment]::GetFolderPath('Desktop'),
                     (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'))) {
      $lnk = Join-Path $p $shortcutName
      if (Test-Path $lnk) { Remove-Item $lnk -Force; Say "[OK] 已删除快捷方式：$lnk" 'Green' }
    }
    if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
    Say '     已清理干净，用原图标启动即为官方版本' 'Gray'
  } else {
    Say '     还有其它 mod 在用 loader，快捷方式保留' 'Gray'
  }
  exit 0
}

# ---------------------------------------------------------------- 安装
$fuseStr = Get-FuseString $exe
if ($fuseStr -eq $null) {
  Say '[!] 读不到 Electron fuse，无法确认注入通道是否可用，仍继续安装' 'Yellow'
} elseif ($fuseStr.Length -le 3 -or $fuseStr[3] -ne '1') {
  Say '[!] 这个版本的 WorkBuddy 关闭了 --inspect fuse（' + $fuseStr + '），本 mod 无法生效。' 'Yellow'
  Say '    可以继续安装，但客户端启动后不会有任何变化。' 'Yellow'
} else {
  Say ('[OK] 注入通道可用（fuse ' + $fuseStr + '）') 'Green'
}

$modDir = Join-Path $dest ('mods\' + $ModId)
New-Item -ItemType Directory -Force -Path $modDir | Out-Null
Copy-Item (Join-Path $here 'loader\injector.js') (Join-Path $dest 'injector.js') -Force
Copy-Item (Join-Path $here ('src\wb-' + $ModId + '.js')) (Join-Path $modDir 'mod.js') -Force

$manifest = @{
  name        = $ModName
  version     = (Get-Content (Join-Path $here 'VERSION') -Raw).Trim()
  description = '把思考强度列表换成连续滑条'
  main        = 'mod.js'
} | ConvertTo-Json -Depth 4
[IO.File]::WriteAllText((Join-Path $modDir 'manifest.json'), $manifest, (New-Object System.Text.UTF8Encoding($false)))

# launch.vbs：无窗口，先用 Node 模式跑 injector，再由它带 --inspect 拉起客户端
$injector = Join-Path $dest 'injector.js'
$tpl = Get-Content (Join-Path $here 'loader\launch.vbs.template') -Raw
$tpl = $tpl -replace "`r?`n", "`r`n"
$tpl = $tpl.Replace('{{LOG}}', (Join-Path $dest 'launch.log')).Replace('{{EXE}}', $exe).Replace('{{INJECTOR}}', $injector)
[IO.File]::WriteAllText($launch, $tpl, [Text.Encoding]::Unicode)

# 注入器需要的客户端路径写进 config.json（不依赖环境变量）
@{ app = $exe } | ConvertTo-Json -Compress | ForEach-Object {
  [IO.File]::WriteAllText((Join-Path $dest 'config.json'), $_, (New-Object System.Text.UTF8Encoding($false)))
}

# 首选客户端自带的 node.exe 直接跑注入器，绕开脚本宿主
$nodeExe = @(Get-ChildItem (Join-Path $env:USERPROFILE '.workbuddy\binaries\node\versions\*\node.exe') -ErrorAction SilentlyContinue) |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1

# 快捷方式
$wsh = New-Object -ComObject WScript.Shell
$targets = @(
  [Environment]::GetFolderPath('Desktop'),
  (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs')
)
foreach ($dir in $targets) {
  if (-not (Test-Path $dir)) { continue }
  $lnkPath = Join-Path $dir $shortcutName
  $sc = $wsh.CreateShortcut($lnkPath)
  if ($nodeExe) {
    $sc.TargetPath = $nodeExe.FullName
    $sc.Arguments = '"' + $injector + '"'
    $sc.WindowStyle = 7
  } else {
    $sc.TargetPath = (Join-Path $env:SystemRoot 'System32\wscript.exe')
    $sc.Arguments = '"' + $launch + '"'
  }
  $sc.WorkingDirectory = $AppRoot
  $sc.IconLocation = $exe + ',0'
  $sc.Description = 'WorkBuddy（已加载 mod）'
  $sc.Save()
  Say "[OK] 快捷方式：$lnkPath" 'Green'
}

# 接管官方快捷方式：点原来那个图标也走注入器（原文件备份为 .wbmods.bak）
if ($nodeExe -and -not $KeepOfficialIcon) {
  foreach ($lnk in $officialLnks) {
    if (-not (Test-Path $lnk)) { continue }
    $bak = $lnk + '.wbmods.bak'
    if (-not (Test-Path $bak)) { Copy-Item $lnk $bak -Force }
    $sc = $wsh.CreateShortcut($lnk)
    $sc.TargetPath = $nodeExe.FullName
    $sc.Arguments = '"' + $injector + '"'
    $sc.WorkingDirectory = $AppRoot
    $sc.IconLocation = $exe + ',0'
    $sc.WindowStyle = 7
    $sc.Save()
    Say "[OK] 已接管官方图标：$lnk" 'Green'
  }
} elseif ($KeepOfficialIcon) {
  Say '[--] 按 -KeepOfficialIcon 要求，保留官方图标' 'DarkGray'
}

Say ''
Say '[OK] 安装完成' 'Green'
Say '     1. 托盘右键，完全退出 WorkBuddy'
Say '     2. 用「WorkBuddy (mods)」快捷方式启动'
Say '     3. 打开模型菜单看图标是否生效'
Say ''
Say '     排查：%LOCALAPPDATA%\WbMods\loader.log' 'DarkGray'
Say '     回滚：双击 uninstall.cmd' 'DarkGray'
