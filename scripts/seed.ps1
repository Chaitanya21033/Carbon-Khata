<#
.SYNOPSIS  Reload the fictional demo data (wipes the database) and restart the simulator clock from 10 Nov 05:50.
.PARAMETER Force  Skip the confirmation prompt.
#>
param([switch]$Force)
. "$PSScriptRoot\_common.ps1"
Set-Location $Root
Load-DotEnv
if (-not $Force) { $a = Read-Host 'This deletes all data in the carbonkhata database and reloads the demo data. Type YES to continue'; if ($a -ne 'YES') { exit 0 } }
Push-Location (Join-Path $Root 'api'); & $Py -m alembic upgrade head; & $Py -m app.seed.run --reset; Pop-Location
$state = Join-Path $Root 'sim\state\sim.json'
if (Test-Path $state) { Remove-Item $state -Force }
Say 'Demo data reloaded. Restart scripts\dev.ps1 (the simulator replays 24 h on first start).' 'Green'
