$ErrorActionPreference = 'Stop'
Invoke-SbxUi -ProcessId $env:SBX_APP_PID -Name Greet -ControlType Button | Out-Null
Wait-SbxUi -ProcessId $env:SBX_APP_PID -Name 'Hello from native Win32' -TimeoutSec 5 | Out-Null
'PASS: native Win32 button and output'
"Guest Windows: $([Environment]::OSVersion.Version)"
