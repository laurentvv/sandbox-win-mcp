$ErrorActionPreference = 'Stop'
Invoke-SbxUi -ProcessId $env:SBX_APP_PID -AutomationId Greet | Out-Null
Wait-SbxUi -ProcessId $env:SBX_APP_PID -AutomationId Output -Name 'Hello from WinForms' -TimeoutSec 5 | Out-Null
'PASS: WinForms button and output'
