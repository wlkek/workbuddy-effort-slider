param(
  [string]$AppRoot,
  [switch]$Uninstall,
  [switch]$Status,
  [switch]$KeepOfficialIcon,
  [switch]$AutoStart
)

# WorkBuddy 思考强度滑条 —— 安装 / 卸载（5.9.2+ 新版通道）
# ------------------------------------------------------------------
# 不修改客户端任何文件。做法：
#   1. 把 loader 与 mod 复制到 %LOCALAPPDATA%\WbMods
#   2. 把客户端自带的 node.exe 硬链成 WbMods\node.exe（固定入口，不怕升级换目录）
#   3. 生成 launch.vbs 作为回退，建快捷方式指向 node.exe
#   4. 接管官方快捷方式（图标保留），点原来的图标也能带 mod
# 卸载只删自己这一份，不影响其它 mod。

$ErrorActionPreference = 'Stop'
$ModId   = 'effort-slider'
$ModName = '思考强度滑条'
$here    = Split-Path -Parent $MyInvocation.MyCommand.Path
$dest    = Join-Path $env:LOCALAPPDATA 'WbMods'
$launch  = Join-Path $dest 'launch.vbs'
$cfgFile = Join-Path $dest 'config.json'
$stableNode = Join-Path $dest 'node.exe'
$shortcutName = 'WorkBuddy (mods).lnk'

# 官方快捷方式可能出现的位置：桌面、公共桌面、开始菜单（含子目录）、任务栏固定项
$lnkDirs = @(
  ([Environment]::GetFolderPath('Desktop')),
  (Join-Path $env:PUBLIC 'Desktop'),
  (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'),
  (Join-Path $env:PROGRAMDATA 'Microsoft\Windows\Start Menu\Programs'),
  (Join-Path $env:APPDATA 'Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar')
)

function Say($msg, $color = 'Gray') { Write-Host $msg -ForegroundColor $color }

# ---------------------------------------------------------------- 路径探测
# 只看目录里有没有 resources\app.asar —— 这是客户端的可靠特征，
# 比记目录名靠谱（用户可以装到任意目录、任意盘）。
function Test-AppRoot([string]$p) {
  if (-not $p) { return $false }
  $p = $p.Trim().Trim('"').TrimEnd('\')
  if (-not $p -or -not (Test-Path $p)) { return $false }
  return (Test-Path (Join-Path $p 'resources\app.asar'))
}

# 读快捷方式的目标与图标（对已存在的 lnk 只读不写）
function Get-LnkInfo([string]$lnk) {
  $r = @{ target = ''; icon = '' }
  try {
    $wsh = New-Object -ComObject WScript.Shell
    $sc = $wsh.CreateShortcut($lnk)
    $r.target = $sc.TargetPath
    $r.icon = $sc.IconLocation
  } catch { }
  return $r
}

# 从带引号/参数的字符串里抠出 exe 路径
function Split-ExePath([string]$s) {
  if (-not $s) { return '' }
  $s = $s.Trim()
  if ($s.StartsWith('"')) {
    $j = $s.IndexOf('"', 1)
    if ($j -gt 1) { return $s.Substring(1, $j - 1) }
  }
  $m = [regex]::Match($s, '^(.+?\.exe)')
  if ($m.Success) { return $m.Groups[1].Value }
  return ''
}

$script:appCands = New-Object System.Collections.ArrayList
function Add-Cand($p) {
  if (-not $p) { return }
  $p = $p.Trim().Trim('"').TrimEnd('\')
  if (-not $p) { return }
  # 先确认目录真实存在：残留的失效路径（移走的盘符、卸载后的目录）会让
  # 后面的 Join-Path 直接抛「找不到驱动器」，$ErrorActionPreference=Stop 下整个安装会中断
  try {
    if (-not (Test-Path -LiteralPath $p)) { return }
  } catch { return }
  if (-not ($script:appCands -contains $p)) { [void]$script:appCands.Add($p) }
}

function Find-AppRoot {
  $script:appCands = New-Object System.Collections.ArrayList

  # 1. 上次装成功时记下的路径（最可信，改过目录也能接着用）
  if (Test-Path $cfgFile) {
    try {
      $cfg = Get-Content $cfgFile -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($cfg.app) { Add-Cand (Split-Path -Parent $cfg.app) }
      if ($cfg.candidates) {
        foreach ($c in $cfg.candidates) { Add-Cand (Split-Path -Parent $c) }
      }
    } catch { }
  }

  # 2. 正在运行的客户端
  try {
    Get-Process -Name 'WorkBuddy' -ErrorAction SilentlyContinue |
      ForEach-Object { if ($_.Path) { Add-Cand (Split-Path -Parent $_.Path) } }
  } catch { }

  # 3. 注册表卸载项：InstallLocation 经常是空的，DisplayIcon 反而一直有值
  $keys = @(
    'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*'
  )
  foreach ($k in $keys) {
    try {
      Get-ItemProperty $k -ErrorAction SilentlyContinue |
        Where-Object { $_.DisplayName -like '*WorkBuddy*' } |
        ForEach-Object {
          if ($_.InstallLocation) { Add-Cand $_.InstallLocation }
          if ($_.DisplayIcon) {
            $ic = ($_.DisplayIcon -replace ',\s*-?\d+$', '').Trim('"')
            if ($ic -like '*.exe') { Add-Cand (Split-Path -Parent $ic) }
          }
          foreach ($u in @($_.UninstallString, $_.QuietUninstallString)) {
            $exePath = Split-ExePath $u
            if ($exePath) { Add-Cand (Split-Path -Parent $exePath) }
          }
        }
    } catch { }
  }

  # 4. App Paths
  $appPathKeys = @(
    'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\WorkBuddy.exe',
    'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths\WorkBuddy.exe',
    'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\WorkBuddy.exe'
  )
  foreach ($apk in $appPathKeys) {
    try {
      $v = Get-ItemProperty $apk -ErrorAction SilentlyContinue
      if ($v -and $v.Path) { Add-Cand $v.Path }
      if ($v) {
        $def = $v.PSObject.Properties['(default)']
        if ($def -and $def.Value) {
          Add-Cand (Split-Path -Parent (Split-ExePath $def.Value))
        }
      }
    } catch { }
  }

  # 5. 快捷方式：全新安装靠它，重装靠接管后仍保留的 IconLocation 反查
  $scanDirs = $lnkDirs
  foreach ($d in $scanDirs) {
    if (-not $d -or -not (Test-Path $d)) { continue }
    try {
      Get-ChildItem $d -Recurse -Filter '*WorkBuddy*.lnk' -ErrorAction SilentlyContinue |
        ForEach-Object {
          $info = Get-LnkInfo $_.FullName
          foreach ($x in @($info.target, ($info.icon -replace ',\s*-?\d+$', ''))) {
            if ($x -and $x -like '*WorkBuddy.exe') { Add-Cand (Split-Path -Parent $x) }
          }
        }
    } catch { }
  }

  # 6. 默认安装位置
  if ($env:LOCALAPPDATA) { Add-Cand (Join-Path $env:LOCALAPPDATA 'Programs\WorkBuddy') }
  if ($env:ProgramFiles) { Add-Cand (Join-Path $env:ProgramFiles 'WorkBuddy') }
  if (${env:ProgramFiles(x86)}) { Add-Cand (Join-Path ${env:ProgramFiles(x86)} 'WorkBuddy') }

  foreach ($c in $script:appCands) {
    if (Test-AppRoot $c) { return $c }
  }
  return $null
}

# 找出真正指向客户端的快捷方式。
# 不靠文件名（官方可能改名、用户可能在开始菜单建在子目录里），
# 只看目标或图标是不是 WorkBuddy.exe —— 接管后图标仍保留原 exe，所以重装也能再次命中。
function Get-OfficialLnks {
  $found = New-Object System.Collections.ArrayList
  foreach ($d in $lnkDirs) {
    if (-not $d -or -not (Test-Path $d)) { continue }
    try {
      Get-ChildItem $d -Recurse -Filter '*WorkBuddy*.lnk' -ErrorAction SilentlyContinue | ForEach-Object {
        if ($_.Name -eq $shortcutName) { return }
        $info = Get-LnkInfo $_.FullName
        $iconExe = ($info.icon -replace ',\s*-?\d+$', '').Trim('"')
        if (($info.target -like '*WorkBuddy.exe') -or ($iconExe -like '*WorkBuddy.exe')) {
          if (-not ($found -contains $_.FullName)) { [void]$found.Add($_.FullName) }
        }
      }
    } catch { }
  }
  return $found
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

# 找客户端自带的 node 运行时（在用户目录下，与安装目录无关）
function Find-Node {
  $roots = @(
    (Join-Path $env:USERPROFILE '.workbuddy\binaries\node\versions'),
    (Join-Path $env:LOCALAPPDATA 'workbuddy\binaries\node\versions')
  )
  $all = @()
  foreach ($r in $roots) {
    if ($r -and (Test-Path $r)) {
      $all += @(Get-ChildItem (Join-Path $r '*\node.exe') -ErrorAction SilentlyContinue)
    }
  }
  if (-not $all.Count) { return $null }
  return ($all | Sort-Object LastWriteTime -Descending | Select-Object -First 1)
}

# ---------------------------------------------------------------- 定位
if (-not $AppRoot) { $AppRoot = Find-AppRoot }
if (-not $AppRoot) {
  Say '[X] 找不到 WorkBuddy 安装目录。' 'Red'
  Say '    已尝试：上次安装记录、运行中的进程、注册表、快捷方式、默认路径。' 'DarkGray'
  Say '    请手动指定，例如：' 'Yellow'
  Say '      install.cmd -AppRoot "D:\你的路径\WorkBuddy"' 'Yellow'
  exit 1
}
# 用 [IO.Path]::Combine 而不是 Join-Path：后者在盘符不存在时会抛异常，
# 而用户手打路径（照着文档抄、盘符不对）是最常见的出错方式，应该给提示而不是堆栈
$exe = [IO.Path]::Combine($AppRoot, 'WorkBuddy.exe')
if (-not (Test-Path -LiteralPath $AppRoot)) {
  Say "[X] 指定的目录不存在：$AppRoot" 'Red'
  Say '    检查盘符和路径是否正确；路径含空格时要用引号包起来' 'DarkGray'
  exit 1
}
if (-not (Test-Path -LiteralPath $exe)) {
  Say "[X] 目录里没有 WorkBuddy.exe：$AppRoot" 'Red'
  Say '    请指向 WorkBuddy 安装目录（和 resources 文件夹同一层）' 'DarkGray'
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
        # 必须指定 UTF8：PS 5.1 默认按 GBK 读无 BOM 的 UTF-8，中文描述会被吃掉引号
        try { $v = (Get-Content $mf -Raw -Encoding UTF8 | ConvertFrom-Json).version } catch { }
      }
      Say ("  Mod      : " + $_.Name + " v" + $v)
    }
  } else { Say '  Mod      : 未安装' }
  if (Test-Path $stableNode) {
    Say ("  Node 入口: " + $stableNode + "（固定路径，不随客户端升级失效）")
  } else {
    Say '  Node 入口: 缺失，下次安装会重建'
  }
  Say ('  快捷方式 : ' + $(if (Test-Path (Join-Path ([Environment]::GetFolderPath('Desktop')) $shortcutName)) { '已创建' } else { '缺失' }))
  $fuseStr = Get-FuseString $exe
  if ($fuseStr) { Say ('  Fuse     : ' + $fuseStr + $(if ($fuseStr.Length -gt 3 -and $fuseStr[3] -eq '1') { '（--inspect 可用）' } else { '（--inspect 已被关闭，注入不可用）' })) }
  $log = Join-Path $dest 'loader.log'
  if (Test-Path $log) {
    Say '  最近日志 :'
    Get-Content $log -Tail 6 -Encoding UTF8 | ForEach-Object { Say ('    ' + $_) 'DarkGray' }
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
    # 没有其它 mod 了，把所有被接管的官方快捷方式还原。
    # 直接扫 *.wbmods.bak 比按文件名找更可靠：不管官方叫什么、被挪到哪都能还原。
    $restored = 0
    foreach ($d in $lnkDirs) {
      if (-not $d -or -not (Test-Path $d)) { continue }
      try {
        Get-ChildItem $d -Recurse -Filter '*.wbmods.bak' -File -ErrorAction SilentlyContinue | ForEach-Object {
          $orig = $_.FullName -replace '\.wbmods\.bak$', ''
          try {
            Copy-Item $_.FullName $orig -Force
            Remove-Item $_.FullName -Force
            $restored++
            Say "[OK] 已还原：$orig" 'Green'
          } catch {
            Say "[!] 还原失败（可能没有权限）：$orig" 'Yellow'
            Say "    手动把 $($_.FullName) 改回 $orig 即可" 'DarkGray'
          }
        }
      } catch { }
    }
    if ($restored -eq 0) { Say '[--] 没有需要还原的快捷方式' 'DarkGray' }

    # 开机自启还原成原版 exe
    $autostartFile = Join-Path $dest 'autostart.json'
    if (Test-Path $autostartFile) {
      try {
        $backups = @(Get-Content $autostartFile -Raw -Encoding UTF8 | ConvertFrom-Json)
        foreach ($b in $backups) {
          if (-not $b.name) { continue }
          Set-ItemProperty -Path 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run' -Name $b.name -Value $b.value
          Say "[OK] 已还原开机自启：$($b.name)" 'Green'
        }
      } catch {
        Say "[!] 还原开机自启失败：$($_.Exception.Message)" 'Yellow'
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
  version     = (Get-Content (Join-Path $here 'VERSION') -Raw -Encoding UTF8).Trim()
  description = '把思考强度列表换成连续滑条'
  main        = 'mod.js'
} | ConvertTo-Json -Depth 4
[IO.File]::WriteAllText((Join-Path $modDir 'manifest.json'), $manifest, (New-Object System.Text.UTF8Encoding($false)))

# launch.vbs：无窗口，先用 Node 模式跑 injector，再由它带 --inspect 拉起客户端
$injector = Join-Path $dest 'injector.js'
$tpl = Get-Content (Join-Path $here 'loader\launch.vbs.template') -Raw -Encoding UTF8
$tpl = $tpl -replace "`r?`n", "`r`n"
$tpl = $tpl.Replace('{{LOG}}', (Join-Path $dest 'launch.log')).Replace('{{EXE}}', $exe).Replace('{{INJECTOR}}', $injector)
[IO.File]::WriteAllText($launch, $tpl, [Text.Encoding]::Unicode)

# 稳定入口：把客户端自带的 node.exe 硬链成 WbMods\node.exe
# 因为 versions\<版本号>\ 目录会在升级时被换掉，快捷方式不能直接指过去
$nodeSrc = Find-Node
$nodeRunner = $null
if ($nodeSrc) {
  $needBuild = $true
  if (Test-Path $stableNode) {
    try {
      $cur = Get-Item $stableNode
      if ($cur.Length -eq $nodeSrc.Length) { $needBuild = $false }
    } catch { }
  }
  if ($needBuild) {
    Remove-Item $stableNode -Force -ErrorAction SilentlyContinue
    try {
      New-Item -ItemType HardLink -Path $stableNode -Target $nodeSrc.FullName -ErrorAction Stop | Out-Null
      Say '[OK] node 入口：硬链接（不额外占空间，客户端升级后仍可用）' 'Green'
    } catch {
      try {
        Copy-Item $nodeSrc.FullName $stableNode -Force -ErrorAction Stop
        Say '[OK] node 入口：文件副本（硬链接不可用，约占 80MB）' 'Yellow'
      } catch {
        Say '[!] 无法建立 node 入口，将回退到 .vbs 启动' 'Yellow'
      }
    }
  } else {
    Say '[OK] node 入口：已存在' 'Green'
  }
  if (Test-Path $stableNode) { $nodeRunner = $stableNode }
} else {
  Say '[!] 没找到客户端自带的 node 运行时，将回退到 .vbs 启动' 'Yellow'
  Say '    查找位置：~\.workbuddy\binaries\node\versions\*\node.exe' 'DarkGray'
}

# 注入器需要的客户端路径写进 config.json（含候选，客户端换目录也能自愈）
$candExes = @()
foreach ($c in $script:appCands) {
  $p = Join-Path $c 'WorkBuddy.exe'
  if (Test-Path $p) { $candExes += $p }
}
$cfgObj = @{ app = $exe; candidates = $candExes }
[IO.File]::WriteAllText($cfgFile, ($cfgObj | ConvertTo-Json -Depth 4), (New-Object System.Text.UTF8Encoding($false)))

# 快捷方式
$wsh = New-Object -ComObject WScript.Shell
$targets = @(
  [Environment]::GetFolderPath('Desktop'),
  (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs')
)
foreach ($dir in $targets) {
  if (-not (Test-Path $dir)) { continue }
  $lnkPath = Join-Path $dir $shortcutName
  try {
    $sc = $wsh.CreateShortcut($lnkPath)
    if ($nodeRunner) {
      $sc.TargetPath = $nodeRunner
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
    Say ("[OK] 快捷方式：$lnkPath  (" + $(if ($nodeRunner) { 'node 直启' } else { 'vbs 回退' }) + ")") 'Green'
  } catch {
    Say "[!] 建快捷方式失败：$lnkPath" 'Yellow'
  }
}

# 接管官方快捷方式：点原来那个图标也走注入器（原文件备份为 .wbmods.bak）
if ($nodeRunner -and -not $KeepOfficialIcon) {
  $targetsFound = @(Get-OfficialLnks)
  if (-not $targetsFound.Count) {
    Say '[--] 没找到指向客户端的官方快捷方式，只保留了「WorkBuddy (mods)」' 'DarkGray'
  }
  foreach ($lnk in $targetsFound) {
    try {
      $bak = $lnk + '.wbmods.bak'
      if (-not (Test-Path $bak)) { Copy-Item $lnk $bak -Force }
      $sc = $wsh.CreateShortcut($lnk)
      $sc.TargetPath = $nodeRunner
      $sc.Arguments = '"' + $injector + '"'
      $sc.WorkingDirectory = $AppRoot
      $sc.IconLocation = $exe + ',0'
      $sc.WindowStyle = 7
      $sc.Save()
      Say "[OK] 已接管官方图标：$lnk" 'Green'
    } catch {
      Say "[!] 跳过（无权限或被占用）：$lnk" 'Yellow'
      Say '    这个图标仍用官方原版启动，其它图标不受影响' 'DarkGray'
    }
  }
} elseif ($KeepOfficialIcon) {
  Say '[--] 按 -KeepOfficialIcon 要求，保留官方图标' 'DarkGray'
} elseif (-not $nodeRunner) {
  Say '[--] 没有 node 入口，不改官方图标（回退模式只提供「WorkBuddy (mods)」）' 'DarkGray'
}

# 开机自启：默认不改动。
#
# 早先这里会把客户端的 Run 项改成注入器，理由是想让「开机那一次也带 mod」。
# 但客户端自己关掉自启时不会认得这个值，于是变成了我们替它开了自启——
# 用户没有开自启，开机还是会被拉起来。
#
# 现在的规则：
#   - 默认：只清理指向注入器的项，不新建、不改客户端自己的自启项
#   - 想让开机那一次也带 mod，显式加 -AutoStart，才会接管官方项并备份原值
$autostartFile = Join-Path $dest 'autostart.json'
$runKey = 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run'
$runLauncher = if ($nodeRunner) { '"' + $nodeRunner + '" "' + $injector + '"' } else { '' }

if ($AutoStart -and $nodeRunner) {
  try {
    $props = Get-ItemProperty $runKey -ErrorAction SilentlyContinue
    $backups = @()
    if (Test-Path $autostartFile) {
      try { $backups = @(Get-Content $autostartFile -Raw -Encoding UTF8 | ConvertFrom-Json) } catch { }
    }
    $hit = 0
    if ($props) {
      $props.PSObject.Properties |
        Where-Object { $_.Name -notlike 'PS*' -and "$($_.Value)" -like '*WorkBuddy.exe*' } |
        ForEach-Object {
          $name = $_.Name
          if (-not @($backups | Where-Object { $_.name -eq $name }).Count) {
            $backups += [pscustomobject]@{ name = $name; value = "$($_.Value)" }
          }
          Set-ItemProperty -Path $runKey -Name $name -Value $runLauncher
          $hit++
          Say "[OK] 已接管开机自启：$name" 'Green'
        }
    }
    if ($hit -eq 0) {
      Say '[--] 没有找到客户端自己的自启项' 'DarkGray'
    }
    if ($backups.Count) {
      [IO.File]::WriteAllText($autostartFile, ($backups | ConvertTo-Json -Depth 4), (New-Object System.Text.UTF8Encoding($false)))
    }
  } catch {
    Say "[!] 开机自启接管失败：$($_.Exception.Message)" 'Yellow'
  }
} else {
  try {
    $props = Get-ItemProperty $runKey -ErrorAction SilentlyContinue
    $removed = 0
    if ($props -and $runLauncher) {
      $props.PSObject.Properties |
        Where-Object { $_.Name -notlike 'PS*' -and "$($_.Value)" -eq $runLauncher } |
        ForEach-Object {
          Remove-ItemProperty -Path $runKey -Name $_.Name -ErrorAction SilentlyContinue
          $removed++
          Say "[OK] 已移除开机自启：$($_.Name)" 'Green'
        }
    }
    if (Test-Path $autostartFile) { Remove-Item $autostartFile -Force }
    if ($removed -eq 0) {
      Say '[OK] 开机自启保持原样（不新建）' 'DarkGray'
    }
  } catch {
    Say "[!] 清理开机自启失败：$($_.Exception.Message)" 'Yellow'
  }
}


Say ''
Say '[OK] 安装完成' 'Green'
Say '     1. 托盘右键，完全退出 WorkBuddy'
Say '     2. 点平时的 WorkBuddy 图标（或「WorkBuddy (mods)」）'
Say '     3. 点开模型菜单 → 悬停模型 → 悬停「思考强度」'
Say ''
Say '     排查：%LOCALAPPDATA%\WbMods\loader.log' 'DarkGray'
Say '     回滚：双击 uninstall.cmd' 'DarkGray'
