# 確保專案內有可用的 Node.js（只用來建置前端），給 setup_easytasks.bat / update_easytasks.bat 呼叫。
# - 下載官方「免安裝版」Node.js 22（最新的 v22.x）到 <專案>\.tools\node，不跑安裝程式、不改系統 PATH
# - 以 nodejs.org 公布的 SHA256 驗證下載檔，不符就中止
# - 已經存在就什麼都不做
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File ensure-node.ps1 -ProjectDir C:\EasyTasksSheet
param([Parameter(Mandatory = $true)][string]$ProjectDir)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # 關掉進度條，否則 Windows PowerShell 下載非常慢
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$tools = Join-Path $ProjectDir '.tools'
$nodeDir = Join-Path $tools 'node'
if (Test-Path (Join-Path $nodeDir 'npm.cmd')) {
    Write-Output "  已有 Node.js：$nodeDir"
    exit 0
}

$index = Invoke-RestMethod -UseBasicParsing 'https://nodejs.org/dist/index.json'
$rel = $index | Where-Object { $_.version -like 'v22.*' } | Select-Object -First 1
if (-not $rel) { throw '在 nodejs.org 找不到 v22 版本' }
$ver = $rel.version
$name = "node-$ver-win-x64"
Write-Output "  下載 Node.js $ver（免安裝版，約 35 MB）..."

$tmp = Join-Path $tools 'download'
if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
New-Item -ItemType Directory -Force $tmp | Out-Null
$zip = Join-Path $tmp "$name.zip"
Invoke-WebRequest -UseBasicParsing "https://nodejs.org/dist/$ver/$name.zip" -OutFile $zip

$sums = (Invoke-WebRequest -UseBasicParsing "https://nodejs.org/dist/$ver/SHASUMS256.txt").Content
$pattern = '\s' + [regex]::Escape("$name.zip") + '$'
$line = ($sums -split "`n") | Where-Object { $_.Trim() -match $pattern } | Select-Object -First 1
if (-not $line) { throw "SHASUMS256.txt 裡找不到 $name.zip" }
$expected = ($line.Trim() -split '\s+')[0].ToLower()
$actual = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
if ($expected -ne $actual) { throw "SHA256 不符，下載檔可能損壞：預期 $expected，實際 $actual" }
Write-Output '  SHA256 驗證通過，解壓縮...'

Expand-Archive -Path $zip -DestinationPath $tmp -Force
if (Test-Path $nodeDir) { Remove-Item $nodeDir -Recurse -Force }
Move-Item (Join-Path $tmp $name) $nodeDir
Remove-Item $tmp -Recurse -Force
Write-Output "  完成：$nodeDir"
