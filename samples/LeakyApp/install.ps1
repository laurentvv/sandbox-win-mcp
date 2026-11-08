# A deliberately sloppy installer for trying `sbx install-test`. Run it in the sandbox, never on your own machine.
# It installs files, an Add/Remove Programs entry, an autorun, a service and a scheduled task.
# Its uninstaller only removes the program folder and the Add/Remove Programs entry, so the rest is left behind.
$ErrorActionPreference = 'Stop'
$dir = "$env:ProgramFiles\LeakyApp"
New-Item -ItemType Directory -Force $dir, "$env:ProgramData\LeakyApp", "$env:APPDATA\LeakyApp" | Out-Null
Set-Content "$dir\leaky.txt" 'pretend this is an app'
Set-Content "$env:ProgramData\LeakyApp\settings.json" '{ "telemetry": true }'
Set-Content "$env:APPDATA\LeakyApp\user.json" '{ "theme": "dark" }'

Set-Content "$dir\uninstall.ps1" @'
Remove-Item -Recurse -Force "$env:ProgramFiles\LeakyApp"
Remove-Item -Recurse -Force 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\LeakyApp'
'@

$u = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\LeakyApp'
New-Item -Force $u | Out-Null
$cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$dir\uninstall.ps1`""
@{ DisplayName = 'Leaky App'; DisplayVersion = '1.0.0'; Publisher = 'sandbox-mcp sample'; InstallLocation = $dir
   UninstallString = $cmd; QuietUninstallString = $cmd }.GetEnumerator() | ForEach-Object { Set-ItemProperty $u $_.Key $_.Value }

New-Item -Force 'HKLM:\SOFTWARE\LeakyApp' | Out-Null
Set-ItemProperty 'HKLM:\SOFTWARE\LeakyApp' 'InstallDir' $dir
Set-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' 'LeakyUpdater' "`"$dir\updater.exe`" --background"
New-Service -Name LeakyUpdater -DisplayName 'Leaky App Updater' -BinaryPathName "`"$dir\updater.exe`"" -StartupType Automatic | Out-Null
Register-ScheduledTask -TaskName 'LeakyApp Daily Check' -Action (New-ScheduledTaskAction -Execute "$dir\updater.exe") `
    -Trigger (New-ScheduledTaskTrigger -Daily -At 3am) | Out-Null
Write-Output 'Leaky App installed.'
