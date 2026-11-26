# Shared helpers for the CarbonKhata scripts (Windows PowerShell 5.1+ or PowerShell 7).
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Venv = Join-Path $Root '.venv'
$Py = Join-Path $Venv 'Scripts\python.exe'
if (-not $IsWindows -and $PSVersionTable.PSEdition -eq 'Core' -and -not (Test-Path $Py)) { $Py = Join-Path $Venv 'bin/python' }
$env:PYTHONUTF8 = '1'
$env:PYTHONIOENCODING = 'utf-8'

function Say($msg, $color = 'Cyan') { Write-Host "==> $msg" -ForegroundColor $color }
function Fail($msg) { Write-Host "ERROR: $msg" -ForegroundColor Red; exit 1 }

function Load-DotEnv {
  $f = Join-Path $Root '.env'
  if (Test-Path $f) {
    Get-Content $f | Where-Object { $_ -match '^\s*[A-Za-z_][A-Za-z0-9_]*=' } | ForEach-Object {
      $k, $v = $_ -split '=', 2
      [Environment]::SetEnvironmentVariable($k.Trim(), $v.Trim(), 'Process')
    }
  }
}

function Find-Python {
  foreach ($c in @(@('py', '-3.12'), @('py', '-3.13'), @('python'), @('python3'))) {
    try {
      $exe = $c[0]; $args2 = @($c | Select-Object -Skip 1)
      $v = & $exe @args2 -c "import sys; print('%d.%d' % sys.version_info[:2])" 2>$null
      if ($LASTEXITCODE -eq 0 -and $v -and [version]$v -ge [version]'3.12') { return , $c }
    } catch { }
  }
  return $null
}

function Wait-Port($port, $seconds = 60) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $deadline) {
    try { $c = New-Object Net.Sockets.TcpClient; $c.Connect('127.0.0.1', $port); $c.Close(); return $true } catch { Start-Sleep -Milliseconds 500 }
  }
  return $false
}

# No-Docker mode: DATABASE_URL=embedded (PostgreSQL from the pgserver pip package) and MQTT_ENABLED=false (HTTP frames).
function Use-Docker { return -not ($env:DATABASE_URL -like 'embedded*') }

function Set-EnvVar($key, $value) {
  $f = Join-Path $Root '.env'
  $lines = @(Get-Content $f)
  $found = $false
  $lines = $lines | ForEach-Object { if ($_ -match "^\s*$key=") { $found = $true; "$key=$value" } else { $_ } }
  if (-not $found) { $lines += "$key=$value" }
  Set-Content -Path $f -Value $lines -Encoding UTF8
  [Environment]::SetEnvironmentVariable($key, $value, 'Process')
}
