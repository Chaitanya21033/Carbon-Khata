<#
.SYNOPSIS  Start CarbonKhata: API (:8000), web app (:5173), simulator + demo controls (:5175 / :5174).
.PARAMETER Demo     Also open the product and the demo-control panel in the browser.
.PARAMETER NoSim    Start the product only (no simulator), e.g. when real devices feed the API.
  Logs from all four processes appear here, prefixed. Ctrl+C stops everything.
#>
param([switch]$Demo, [switch]$NoSim)
. "$PSScriptRoot\_common.ps1"
Set-Location $Root
if (-not (Test-Path $Py)) { Fail 'Run scripts\setup.ps1 first.' }
Load-DotEnv

Say 'Making sure PostgreSQL and Mosquitto are running'
if (Use-Docker) {
  docker compose -f (Join-Path $Root 'infra\docker-compose.yml') up -d | Out-Null
  if (-not (Wait-Port 5432 60)) { Fail 'PostgreSQL is not reachable on 5432 (is Docker Desktop running?).' }
  if (-not (Wait-Port 1883 30)) { Fail 'Mosquitto is not reachable on 1883.' }
} else { Write-Host '   no-Docker mode: embedded PostgreSQL, meter data over HTTP' }
Push-Location (Join-Path $Root 'api'); & $Py -m alembic upgrade head | Out-Null; Pop-Location

$procs = [ordered]@{}
function Start-Svc($name, $dir, $file, $argList) {
  $out = Join-Path ([IO.Path]::GetTempPath()) "carbonkhata-$name.log"
  if (Test-Path $out) { Remove-Item $out -Force }
  $p = Start-Process -FilePath $file -ArgumentList $argList -WorkingDirectory (Join-Path $Root $dir) -NoNewWindow -PassThru -RedirectStandardOutput $out -RedirectStandardError "$out.err"
  $procs[$name] = @{ p = $p; out = $out; pos = 0; epos = 0 }
}
$npm = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source; if (-not $npm) { $npm = 'npm' }

Say 'Starting API on http://localhost:8000 (docs at /docs)'
Start-Svc 'api' 'api' $Py @('-m', 'uvicorn', 'app.main:app', '--port', '8000')
if (-not (Wait-Port 8000 60)) { Fail "API did not start. See the temp folder: carbonkhata-api.log.err" }
Say 'Starting web app on http://localhost:5173'
Start-Svc 'web' 'web' $npm @('run', 'dev')
if (-not $NoSim) {
  Say 'Starting simulator (control API :5175) and demo controls on http://localhost:5174'
  Start-Svc 'sim' 'sim' $Py @('-m', 'simulator.service')
  Start-Svc 'controls' 'sim\control-panel' $npm @('run', 'dev')
}
if ($Demo) { Wait-Port 5173 60 | Out-Null; Start-Process 'http://localhost:5173'; if (-not $NoSim) { Wait-Port 5174 60 | Out-Null; Start-Process 'http://localhost:5174' } }

$lan = $null
try {
  $lan = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop | Where-Object { $_.IPAddress -notmatch '^(127\.|169\.254\.)' -and $_.InterfaceAlias -notmatch 'vEthernet|WSL|Loopback|VirtualBox|VMware' -and $_.PrefixOrigin -in @('Dhcp', 'Manual') } | Sort-Object InterfaceMetric | Select-Object -First 1).IPAddress
} catch { }
if ($lan) {
  Write-Host "`nOn a phone on the same Wi-Fi:" -ForegroundColor White
  Write-Host "   Product (sign in as the operator):   http://${lan}:5173" -ForegroundColor White
  Write-Host "   Field-device pages:                  http://${lan}:5174/#/devices" -ForegroundColor White
  Write-Host "   (If Windows asks, allow Node.js on PRIVATE networks. Photos from phones are saved in $(Join-Path $Root 'captures'))" -ForegroundColor DarkGray
}
$colors = @{ api = 'Green'; web = 'Cyan'; sim = 'Yellow'; controls = 'Magenta' }
Write-Host "`nRunning. Product: http://localhost:5173  ·  Demo controls: http://localhost:5174  ·  API docs: http://localhost:8000/docs  ·  Ctrl+C to stop`n" -ForegroundColor White
try {
  while ($true) {
    foreach ($k in $procs.Keys) {
      $s = $procs[$k]
      foreach ($pair in @(@($s.out, 'pos'), @("$($s.out).err", 'epos'))) {
        $f = $pair[0]; if (-not (Test-Path $f)) { continue }
        $fs = [IO.File]::Open($f, 'Open', 'Read', 'ReadWrite')
        try { $fs.Seek($s[$pair[1]], 'Begin') | Out-Null; $sr = New-Object IO.StreamReader($fs); $txt = $sr.ReadToEnd(); $s[$pair[1]] = $fs.Position } finally { $fs.Close() }
        if ($txt) { $txt.TrimEnd() -split "`r?`n" | Where-Object { $_ -and $_ -notmatch 'HTTP Request: (GET|POST|PUT)' } | ForEach-Object { Write-Host ("[{0,-8}] {1}" -f $k, $_) -ForegroundColor $colors[$k] } }
      }
      if ($s.p.HasExited) { Write-Host "[$k] exited with code $($s.p.ExitCode)" -ForegroundColor Red; $procs.Remove($k); break }
    }
    Start-Sleep -Milliseconds 400
  }
} finally {
  Say 'Stopping…' 'Yellow'
  foreach ($k in @($procs.Keys)) {
    $id = $procs[$k].p.Id
    # Kill the whole tree (npm.cmd -> node -> vite) on Windows; plain stop elsewhere.
    if ($env:OS -eq 'Windows_NT') { & taskkill /T /F /PID $id *> $null } else { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }
  }
}
