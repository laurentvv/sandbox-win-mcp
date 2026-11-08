$ErrorActionPreference = 'Stop'
Invoke-SbxUi -ProcessId $env:SBX_APP_PID -AutomationId Greet | Out-Null
Wait-SbxUi -ProcessId $env:SBX_APP_PID -AutomationId Output -Name 'Hello from WPF' -TimeoutSec 5 | Out-Null
'PASS: WPF button and output'
