<#
.SYNOPSIS  Share the running demo with phones and other laptops through secure HTTPS links (no admin rights,
  no firewall change, works on any network, even mobile data). Run it in a SECOND PowerShell window while
  scripts\dev.ps1 is running. Uses Cloudflare's free "quick tunnel" (cloudflared, downloaded once into tools\).
  The links are random and stop working when you press Ctrl+C here. Demo data only.
#>
. "$PSScriptRoot\_common.ps1"
$tools = Join-Path $Root 'tools'
$exe = Join-Path $tools 'cloudflared.exe'
if (-not (Test-Path $exe)) {
  Say 'Downloading cloudflared (one time, ~60 MB, no install needed)'
  New-Item -ItemType Directory -Force -Path $tools | Out-Null
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $ProgressPreference = 'SilentlyContinue'
  Invoke-WebRequest -Uri 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe' -OutFile $exe -UseBasicParsing
}
if (-not (Wait-Port 5173 5)) { Fail 'The demo is not running. Start scripts\dev.ps1 first, then run this in a second window.' }

$logDir = Join-Path ([IO.Path]::GetTempPath()) 'carbonkhata-logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$tunnels = @()
foreach ($t in @(@{ name = 'product'; port = 5173 }, @{ name = 'controls'; port = 5174 })) {
  $log = Join-Path $logDir ("tunnel-{0}-{1}.log" -f $t.name, (Get-Date -Format 'HHmmss'))
  $p = Start-Process -FilePath $exe -ArgumentList @('tunnel', '--no-autoupdate', '--url', "http://localhost:$($t.port)") -NoNewWindow -PassThru -RedirectStandardError $log -RedirectStandardOutput "$log.out"
  $tunnels += @{ name = $t.name; p = $p; log = $log; url = $null }
}
Say 'Opening secure links (10-20 s)…'
$deadline = (Get-Date).AddSeconds(60)
while ((Get-Date) -lt $deadline -and ($tunnels | Where-Object { -not $_.url })) {
  foreach ($t in $tunnels) {
    if (-not $t.url -and (Test-Path $t.log)) {
      $m = Select-String -Path $t.log -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($m) { $t.url = $m.Matches[0].Value }
    }
  }
  Start-Sleep -Milliseconds 700
}
if ($tunnels | Where-Object { -not $_.url }) { $tunnels | ForEach-Object { Stop-Process -Id $_.p.Id -Force -ErrorAction SilentlyContinue }; Fail "Could not open the links (no internet, or a proxy blocks Cloudflare). Logs: $logDir" }
$prod = ($tunnels | Where-Object name -eq 'product').url
$ctl = ($tunnels | Where-Object name -eq 'controls').url
Write-Host ''
Write-Host '  PHONE (capture, sign in as Store keeper / Operator):' -ForegroundColor Green
Write-Host "      $prod" -ForegroundColor White
Write-Host '  LAPTOP B (demo controls):' -ForegroundColor Green
Write-Host "      $ctl" -ForegroundColor White
Write-Host '  LAPTOP B (field-device / CO2 sensor pages):' -ForegroundColor Green
Write-Host "      $ctl/#/devices" -ForegroundColor White
Write-Host '  API docs:' -ForegroundColor Green
Write-Host "      $prod/docs      ·      $ctl/sim/docs" -ForegroundColor White
Write-Host ''
Write-Host '  Tip: send these links to the phone over WhatsApp. Keep this window open; Ctrl+C closes the links.' -ForegroundColor DarkGray
try { while ($true) { Start-Sleep 2; foreach ($t in $tunnels) { if ($t.p.HasExited) { Fail "The $($t.name) link stopped. Run scripts\share.ps1 again." } } } }
finally { $tunnels | ForEach-Object { Stop-Process -Id $_.p.Id -Force -ErrorAction SilentlyContinue }; Say 'Links closed.' 'Yellow' }
