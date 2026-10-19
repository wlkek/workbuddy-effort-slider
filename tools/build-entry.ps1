param(
  [Parameter(Mandatory=$true)][string]$Source,
  [Parameter(Mandatory=$true)][string]$Dest,
  [string]$ScriptName = 'wb-effort-slider'
)

# 从用户自己的 index.html 生成"打过补丁"的入口文件。
# 约束：产物字节数必须 <= 原始文件。
# 原因：Electron 按 asar 头里记录的 size 返回内容，超出的部分会被截断，
#      追加在文件末尾的加载器正好会被切掉（已实测）。

$ErrorActionPreference = 'Stop'
$enc = New-Object System.Text.UTF8Encoding($false)

$origText = $enc.GetString([IO.File]::ReadAllBytes($Source))
$origLen  = (Get-Item $Source).Length

if ($origText -match [regex]::Escape($ScriptName + '/' + $ScriptName + '.js')) {
  throw "源文件里已经含有加载器，请改用原始备份（index.html.wb-es.bak）作为 Source"
}

$loader = '<script>!function(){try{var m=/^(.*)\/app\.asar\/renderer\/index\.html/.exec(location.href),s=document.createElement("script");s.src=m?m[1]+"/' + $ScriptName + '/' + $ScriptName + '.js":"../../' + $ScriptName + '/' + $ScriptName + '.js";(document.head||document.documentElement).appendChild(s)}catch(e){}}()</script>'

# 只清理 <script> 之外的内容：HTML 注释 + 纯空行（都是惰性的，删掉不影响功能）
$parts = [regex]::Split($origText, '(?is)(<script\b[^>]*>.*?</script>)')
for ($i = 0; $i -lt $parts.Count; $i++) {
  if ($i % 2 -eq 1) { continue }        # 奇数位是 script 块本身，原样保留
  $p = [regex]::Replace($parts[$i], '(?s)<!--.*?-->', '')
  $p = [regex]::Replace($p, '(?m)^[ \t]*\r?\n', '')
  $parts[$i] = $p
}
$text = -join $parts

# 加载器插在 charset 之后（避免解析器还在猜编码时读到脚本）
$anchor = '<meta charset="UTF-8" />'
if ($text.IndexOf($anchor) -lt 0) {
  $anchor = '<head>'
  if ($text.IndexOf($anchor) -lt 0) { throw '在 index.html 里找不到 <head>，无法插入加载器' }
}
$at = $text.IndexOf($anchor) + $anchor.Length
$text = $text.Insert($at, "`r`n" + $loader)

$bytes = $enc.GetBytes($text)
if ($bytes.Length -gt $origLen) {
  throw ("生成结果 " + $bytes.Length + " 字节 > 原始 " + $origLen + " 字节，会被 Electron 截断。" +
         "请把加载器改短，或换一个含更多注释/空行的版本重试。")
}

[IO.File]::WriteAllBytes($Dest, $bytes)
Write-Host ("[OK] 入口文件 " + $bytes.Length + " / " + $origLen + " 字节 -> " + $Dest)
