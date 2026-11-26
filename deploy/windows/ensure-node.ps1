# Make sure the project has a usable Node.js (only used to build the frontend).
# Called by setup_easytasks.bat / update_easytasks.bat.
# - Downloads the official portable Node.js 22 (latest v22.x) into <project>\.tools\node.
#   No installer, no change to the system PATH.
# - Verifies the download against the SHA256 published by nodejs.org; aborts on mismatch.
# - Does nothing if it is already there.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File ensure-node.ps1 -ProjectDir C:\EasyTasksSheet
# KEEP THIS FILE ASCII-ONLY (Windows PowerShell 5.1 misreads UTF-8 files without a BOM).
param([Parameter(Mandatory = $true)][string]$ProjectDir)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # the progress bar makes downloads very slow in PowerShell 5.1
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$tools = Join-Path $ProjectDir '.tools'
$nodeDir = Join-Path $tools 'node'
if (Test-Path (Join-Path $nodeDir 'npm.cmd')) {
    Write-Output "  Node.js already present: $nodeDir"
    exit 0
}

$index = Invoke-RestMethod -UseBasicParsing 'https://nodejs.org/dist/index.json'
$rel = $index | Where-Object { $_.version -like 'v22.*' } | Select-Object -First 1
if (-not $rel) { throw 'No v22 release found on nodejs.org' }
$ver = $rel.version
$name = "node-$ver-win-x64"
Write-Output "  Downloading Node.js $ver (portable, about 35 MB)..."

$tmp = Join-Path $tools 'download'
if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
New-Item -ItemType Directory -Force $tmp | Out-Null
$zip = Join-Path $tmp "$name.zip"
Invoke-WebRequest -UseBasicParsing "https://nodejs.org/dist/$ver/$name.zip" -OutFile $zip

$sums = [string](Invoke-RestMethod -UseBasicParsing "https://nodejs.org/dist/$ver/SHASUMS256.txt")
$pattern = '\s' + [regex]::Escape("$name.zip") + '$'
$line = ($sums -split "`n") | Where-Object { $_.Trim() -match $pattern } | Select-Object -First 1
if (-not $line) { throw "$name.zip not found in SHASUMS256.txt" }
$expected = ($line.Trim() -split '\s+')[0].ToLower()
$actual = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
if ($expected -ne $actual) { throw "SHA256 mismatch, download may be corrupt: expected $expected, got $actual" }
Write-Output '  SHA256 OK, extracting...'

Expand-Archive -Path $zip -DestinationPath $tmp -Force
if (Test-Path $nodeDir) { Remove-Item $nodeDir -Recurse -Force }
Move-Item (Join-Path $tmp $name) $nodeDir
Remove-Item $tmp -Recurse -Force
Write-Output "  Done: $nodeDir"
