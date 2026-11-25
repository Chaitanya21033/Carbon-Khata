<#
.SYNOPSIS  Run all tests: backend (pytest: 38 ported reference tests + API tests), simulator, and frontend (vitest).
  Needs PostgreSQL running (scripts\setup.ps1 / dev.ps1 start it). Uses the carbonkhata_test database.
#>
. "$PSScriptRoot\_common.ps1"
Set-Location $Root
Load-DotEnv
docker compose -f (Join-Path $Root 'infra\docker-compose.yml') up -d db | Out-Null
if (-not (Wait-Port 5432 60)) { Fail 'PostgreSQL is not reachable on 5432.' }
$failed = 0
Say 'Backend: domain (ported reference tests), integration (EMS + simulator), API'
Push-Location (Join-Path $Root 'api'); & $Py -m pytest -q; if ($LASTEXITCODE -ne 0) { $failed++ }; Pop-Location
Say 'Simulator'
Push-Location (Join-Path $Root 'sim'); & $Py -m pytest -q tests; if ($LASTEXITCODE -ne 0) { $failed++ }; Pop-Location
Say 'Frontend (vitest)'
Push-Location (Join-Path $Root 'web'); npm test --silent; if ($LASTEXITCODE -ne 0) { $failed++ }; Pop-Location
if ($failed) { Fail "$failed test suite(s) failed." } else { Say 'All tests passed.' 'Green' }
