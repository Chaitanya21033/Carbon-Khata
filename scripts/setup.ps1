<#
.SYNOPSIS  One-time setup of CarbonKhata on a Windows laptop.
.DESCRIPTION
  Checks Node 20+, Python 3.12+ and Docker; creates the Python venv; installs dependencies; copies .env;
  starts PostgreSQL + Mosquitto in Docker; runs migrations; loads the demo data.
  Run from the repository root:  powershell -ExecutionPolicy Bypass -File scripts\setup.ps1
  Without Docker (or with -NoDocker) it uses an embedded PostgreSQL from pip and sends meter data over HTTP instead of MQTT.
.PARAMETER NoDocker  Do not use Docker even if it is installed.
#>
param([switch]$NoDocker)
. "$PSScriptRoot\_common.ps1"
Set-Location $Root

Say 'Checking prerequisites'
try { $node = (node --version) } catch { Fail 'Node.js not found. Install Node.js 20 LTS from nodejs.org, then reopen PowerShell.' }
if ([int]($node.TrimStart('v').Split('.')[0]) -lt 20) { Fail "Node.js $node found; version 20 or newer is needed." }
Write-Host "   Node $node"
$pyCmd = Find-Python
if (-not $pyCmd) { Fail 'Python 3.12+ not found. Install Python 3.12 from python.org (tick "Add python.exe to PATH").' }
Write-Host "   Python: $($pyCmd -join ' ')"
$docker = $false
if (-not $NoDocker) {
  try { docker version --format '{{.Server.Version}}' *> $null; $docker = ($LASTEXITCODE -eq 0) } catch { $docker = $false }
}
if ($docker) { Write-Host '   Docker OK' } else { Write-Host '   Docker not used: no-Docker mode (embedded PostgreSQL from pip, meter data over HTTP instead of MQTT)' -ForegroundColor Yellow }

Say 'Configuration (.env)'
$envFile = Join-Path $Root '.env'
if (-not (Test-Path $envFile)) { Copy-Item (Join-Path $Root 'infra\.env.example') $envFile; Write-Host '   Created .env from infra\.env.example' } else { Write-Host '   .env already exists (kept)' }
if ($docker) {
  if ((Get-Content $envFile) -match '^DATABASE_URL=embedded') { Set-EnvVar 'DATABASE_URL' 'postgresql+psycopg://carbonkhata:carbonkhata@localhost:5432/carbonkhata'; Set-EnvVar 'TEST_DATABASE_URL' 'postgresql+psycopg://carbonkhata:carbonkhata@localhost:5432/carbonkhata_test'; Set-EnvVar 'MQTT_ENABLED' 'true' }
} else {
  Set-EnvVar 'DATABASE_URL' 'embedded'; Set-EnvVar 'TEST_DATABASE_URL' 'embedded-test'; Set-EnvVar 'MQTT_ENABLED' 'false'
}
Load-DotEnv

Say 'Python virtual environment + API / simulator packages'
if (-not (Test-Path $Py)) { $exe = $pyCmd[0]; $rest = @($pyCmd | Select-Object -Skip 1); & $exe @rest -m venv $Venv }
& $Py -m pip install --upgrade pip --quiet
& $Py -m pip install -r (Join-Path $Root 'api\requirements.txt') --quiet
if ($LASTEXITCODE -ne 0) { Fail 'pip install failed (see above).' }
if (-not $docker) {
  & $Py -m pip install pgserver --quiet
  if ($LASTEXITCODE -ne 0) { Fail 'Could not install pgserver (embedded PostgreSQL). It needs Python 3.12 on 64-bit Windows.' }
}

Say 'Web app and demo-control panel packages (npm)'
foreach ($d in @('web', 'sim\control-panel')) {
  Push-Location (Join-Path $Root $d); npm install --no-fund --no-audit --loglevel=error; if ($LASTEXITCODE -ne 0) { Pop-Location; Fail "npm install failed in $d" }; Pop-Location
}

if ($docker) {
  Say 'Starting PostgreSQL (TimescaleDB) and Mosquitto in Docker'
  docker compose -f (Join-Path $Root 'infra\docker-compose.yml') up -d
  if (-not (Wait-Port 5432 90)) { Fail 'PostgreSQL did not start on port 5432.' }
  for ($i = 0; $i -lt 40; $i++) { docker exec carbonkhata-db-1 pg_isready -U carbonkhata -d carbonkhata *> $null; if ($LASTEXITCODE -eq 0) { break }; Start-Sleep 1 }
  docker exec carbonkhata-db-1 psql -U carbonkhata -d carbonkhata -tc "SELECT 1 FROM pg_database WHERE datname='carbonkhata_test'" | Out-String | ForEach-Object {
    if ($_.Trim() -ne '1') { docker exec carbonkhata-db-1 psql -U carbonkhata -d carbonkhata -c 'CREATE DATABASE carbonkhata_test' | Out-Null }
  }
} else {
  Say 'Starting the embedded PostgreSQL (first start takes ~30 s)'
}

Say 'Database migrations'
Push-Location (Join-Path $Root 'api'); & $Py -m alembic upgrade head; $rc = $LASTEXITCODE; Pop-Location
if ($rc -ne 0) { Fail 'Migrations failed.' }

Say 'Demo data'
Push-Location (Join-Path $Root 'api'); & $Py -m app.seed.run; Pop-Location

Say 'Setup complete. Start everything with:  powershell -ExecutionPolicy Bypass -File scripts\dev.ps1' 'Green'
