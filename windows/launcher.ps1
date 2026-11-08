# SSL vMix dashboard for the Windows vMix PC. Started by "SSL Dashboard.bat".
# 1) downloads the newest build from GitHub (when online), 2) runs the dashboard and restarts it if it stops.
# Data (database, images, ssl-vmix.xlsx) lives in .\data and is never touched by updates.
$ErrorActionPreference = 'Stop'
# Never close silently: show what went wrong and wait.
trap {
  Write-Host ''
  Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host ($_.InvocationInfo.PositionMessage) -ForegroundColor DarkGray
  if (-not $env:SSL_LAUNCHER_TEST) { Read-Host 'Take a photo of this window, then press Enter to close' }
  exit 1
}
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$Root = $PSScriptRoot
$Repo = 'adamem27/ssl-vmix-dashboard'
$Tag = 'windows-latest'
$Asset = 'ssl-dashboard-windows.zip'
$Port = 4310
$ConfigFile = Join-Path $Root 'config.json'
$App = Join-Path $Root 'app'
$Data = Join-Path $Root 'data'
$Host.UI.RawUI.WindowTitle = 'SSL Dashboard'

function Say($msg) { Write-Host ("{0}  {1}" -f (Get-Date -Format 'HH:mm:ss'), $msg) }

$config = @{}
if (Test-Path $ConfigFile) { (Get-Content $ConfigFile -Raw | ConvertFrom-Json).psobject.Properties | ForEach-Object { $config[$_.Name] = $_.Value } }
if (-not $config.token) {
  Write-Host 'Paste the update key (GitHub token) and press Enter. Leave empty to skip updates.'
  $config.token = (Read-Host 'Update key').Trim()
  $config | ConvertTo-Json | Set-Content $ConfigFile -Encoding UTF8
}
if ($null -eq $config.server) {
  Write-Host ''
  Write-Host 'Where is the database?'
  Write-Host '  - online dashboard: type its address, e.g. https://sslgfx.em27code.com'
  Write-Host '  - on this PC only: just press Enter'
  $config.server = (Read-Host 'Online address').Trim().TrimEnd('/')
  if ($config.server) { $config.password = (Read-Host 'Online dashboard password').Trim() }
  $config | ConvertTo-Json | Set-Content $ConfigFile -Encoding UTF8
}

function Update-App {
  if (-not $config.token) { return }
  $h = @{ Authorization = "Bearer $($config.token)"; 'User-Agent' = 'ssl-dashboard-launcher'; Accept = 'application/vnd.github+json' }
  try {
    $rel = Invoke-RestMethod -Headers $h -Uri "https://api.github.com/repos/$Repo/releases/tags/$Tag" -TimeoutSec 15
  } catch {
    Say "Update check skipped ($($_.Exception.Message)). Starting the current version."
    return
  }
  $a = $rel.assets | Where-Object { $_.name -eq $Asset } | Select-Object -First 1
  if (-not $a) { Say 'No build published yet.'; return }
  $versionFile = Join-Path $App 'version.txt'
  $current = if (Test-Path $versionFile) { (Get-Content $versionFile -Raw).Trim() } else { '' }
  if ($current -eq "$($a.id)") { Say 'Up to date.'; return }

  Say "Downloading the new version ($([math]::Round($a.size / 1MB)) MB)..."
  $zip = Join-Path $env:TEMP $Asset
  $tmp = Join-Path $Root 'update.tmp'
  try {
    $h.Accept = 'application/octet-stream'
    Invoke-WebRequest -Headers $h -Uri $a.url -OutFile $zip -TimeoutSec 600 -UseBasicParsing
    if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
    New-Item -ItemType Directory $tmp | Out-Null
    $ok = $false
    try { tar -xf $zip -C $tmp; $ok = ($LASTEXITCODE -eq 0) } catch { }
    if (-not $ok) { Expand-Archive $zip $tmp -Force }
    Stop-Dashboard
    $old = Join-Path $Root 'app.old'
    if (Test-Path $old) { Remove-Item $old -Recurse -Force }
    if (Test-Path $App) { Rename-Item $App 'app.old' }
    Move-Item (Join-Path $tmp 'app') $App
    Set-Content (Join-Path $App 'version.txt') "$($a.id)"
    # Launcher files take effect on the next start.
    # A file that cannot be replaced (read-only, open elsewhere) only gets a warning: the app itself is already updated.
    Get-ChildItem $tmp -File | ForEach-Object {
      $name = $_.Name; $dest = Join-Path $Root $name
      try {
        if ((Test-Path $dest) -and (Get-FileHash $dest).Hash -eq (Get-FileHash $_.FullName).Hash) { return }
        if (Test-Path $dest) { (Get-Item $dest -Force).Attributes = 'Normal' }
        Copy-Item $_.FullName $dest -Force
      } catch { Say "Could not replace $name ($($_.Exception.Message)) - keeping the old one." }
    }
    if (Test-Path $old) { Remove-Item $old -Recurse -Force -ErrorAction SilentlyContinue }
    Say 'Updated.'
  } catch {
    Say "Update failed ($($_.Exception.Message)). Starting the current version."
    if (-not (Test-Path $App) -and (Test-Path (Join-Path $Root 'app.old'))) { Rename-Item (Join-Path $Root 'app.old') 'app' }
  } finally {
    Remove-Item $zip -Force -ErrorAction SilentlyContinue
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
  }
}

function Stop-Dashboard {
  Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
}

Say 'Checking for updates...'
Update-App
if (-not (Test-Path (Join-Path $App 'app.cjs'))) { Say 'The app is missing and could not be downloaded. Check the internet connection and the update key.'; Read-Host 'Press Enter to close'; exit 1 }

New-Item -ItemType Directory $Data -Force | Out-Null
$ErrorActionPreference = 'Continue'
$Node = Join-Path $App 'node\node.exe'

if ($config.server) {
  # Online mode: the database lives on the server; this PC keeps a local copy of the files for vMix.
  $env:SYNC_SERVER = $config.server
  $env:SYNC_PASSWORD = "$($config.password)"
  $env:SYNC_FOLDER = Join-Path $Data 'assets'
  Say "Online dashboard: $($config.server)"
  Say "vMix Excel file: $Data\assets\ssl-vmix.xlsx"
  Say 'Keep this window open (you can minimize it).'
  if ($env:SSL_LAUNCHER_TEST) { & $Node (Join-Path $App 'vmix-sync.mjs') --once; exit $LASTEXITCODE }
  Start-Process $config.server
  while ($true) {
    & $Node (Join-Path $App 'vmix-sync.mjs')
    Say 'Sync stopped. Restarting in 5 s...'
    Start-Sleep 5
  }
}

# Local mode: the dashboard and its database run on this PC.
Stop-Dashboard
$env:DATA_DIR = $Data
$env:HOST = '0.0.0.0'
$env:PORT = "$Port"
$env:LOG_LEVEL = 'warn'
if ($config.localPassword) { $env:DASHBOARD_PASSWORD = $config.localPassword }
$Log = Join-Path $Data 'dashboard.log'
$ip = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } | Select-Object -First 1).IPAddress
Say "Dashboard: http://localhost:$Port   (other computers in this network: http://${ip}:$Port)"
Say "vMix Excel file: $Data\assets\ssl-vmix.xlsx"
Say 'Keep this window open (you can minimize it).'
# CI check: start once, confirm it answers, stop.
if ($env:SSL_LAUNCHER_TEST) {
  $p = Start-Process $Node -ArgumentList "`"$(Join-Path $App 'app.cjs')`"" -PassThru -NoNewWindow
  $ok = $false
  foreach ($i in 1..30) { Start-Sleep 1; try { if ((Invoke-RestMethod "http://127.0.0.1:$Port/api/health").ok) { $ok = $true; break } } catch { } }
  Stop-Process $p -Force
  if ($ok) { exit 0 } else { exit 1 }
}
Start-Job { Start-Sleep 4; Start-Process "http://localhost:$using:Port" } | Out-Null
while ($true) {
  & $Node (Join-Path $App 'app.cjs') 2>&1 | Out-File $Log -Append -Encoding utf8
  Say 'The dashboard stopped. Restarting in 5 s...'
  Start-Sleep 5
}
