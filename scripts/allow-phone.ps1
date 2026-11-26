<#
.SYNOPSIS  One-time: let phones on the same Wi-Fi open CarbonKhata (ports 5173 product, 5174 devices/controls).
  Marks the current Wi-Fi as a Private network and adds a Windows Firewall rule. Asks for administrator rights.
#>
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`""
  exit
}
Write-Host '==> Setting the connected network(s) to Private' -ForegroundColor Cyan
Get-NetConnectionProfile | Where-Object { $_.NetworkCategory -ne 'DomainAuthenticated' } | ForEach-Object {
  try { Set-NetConnectionProfile -InterfaceIndex $_.InterfaceIndex -NetworkCategory Private; Write-Host "   $($_.Name): Private" } catch { Write-Host "   $($_.Name): could not change ($($_.Exception.Message))" -ForegroundColor Yellow }
}
Write-Host '==> Firewall rule for ports 5173 and 5174 (inbound TCP)' -ForegroundColor Cyan
Get-NetFirewallRule -DisplayName 'CarbonKhata demo' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName 'CarbonKhata demo' -Direction Inbound -Protocol TCP -LocalPort 5173, 5174 -Action Allow -Profile Private, Domain, Public | Out-Null
Write-Host '   added'
$ip = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notmatch '^(127\.|169\.254\.)' -and $_.InterfaceAlias -notmatch 'vEthernet|WSL|Loopback' -and $_.PrefixOrigin -in @('Dhcp', 'Manual') } | Select-Object -First 1).IPAddress
Write-Host "`nDone. On the phone open:  http://${ip}:5173" -ForegroundColor Green
Write-Host 'If it still does not open, this Wi-Fi blocks devices from talking to each other: connect the laptop to the phone''s hotspot and use the new address dev.ps1 prints.' -ForegroundColor Yellow
Read-Host 'Press Enter to close'
