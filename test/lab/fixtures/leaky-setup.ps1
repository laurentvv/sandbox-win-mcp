# Synthetic "leaky" installer for the utility battery: installs files, registry, a scheduled
# task and a startup item, registers in Add/Remove Programs, and provides NO uninstaller -
# exactly what sandbox_install_test's leftovers report is for.
$ErrorActionPreference = 'Stop'
$dir = 'C:\Program Files\LeakyApp'
New-Item -ItemType Directory -Force $dir | Out-Null
Set-Content (Join-Path $dir 'leaky.exe') -Value 'not really an exe'
Set-Content (Join-Path $dir 'leaky.dll') -Value 'not really a dll'
New-Item -Path 'HKLM:\SOFTWARE\LeakyApp' -Force | Out-Null
New-ItemProperty -Path 'HKLM:\SOFTWARE\LeakyApp' -Name Installed -Value 1 -PropertyType DWord -Force | Out-Null
schtasks.exe /Create /F /TN LeakyUpdate /SC ONLOGON /TR "powershell.exe -WindowStyle Hidden -File $dir\leaky.exe" | Out-Null
Set-Content (Join-Path ([Environment]::GetFolderPath('Startup')) 'leaky.cmd') -Value "@rem leaky startup item"
New-Item -Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\LeakyApp' -Force | Out-Null
New-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\LeakyApp' -Name DisplayName -Value 'LeakyApp 1.0' -PropertyType String -Force | Out-Null
New-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\LeakyApp' -Name UninstallString -Value "powershell.exe -File $dir\uninstall.ps1" -PropertyType String -Force | Out-Null
Write-Output 'LeakyApp installed.'
