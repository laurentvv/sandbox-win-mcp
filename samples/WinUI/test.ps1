# Run inside the guest via sbx --test, with SbxUi already imported.
$ErrorActionPreference = 'Stop'
if (-not $env:SBX_APP_PID) { throw 'SBX_APP_PID must identify the launched sample.' }

Wait-SbxUi -ProcessId $env:SBX_APP_PID -AutomationId NameBox -TimeoutSec 30 | Out-Null
Wait-SbxUi -ProcessId $env:SBX_APP_PID -AutomationId Counter -Name 'Count: 0' -TimeoutSec 5 | Out-Null
Invoke-SbxUi -ProcessId $env:SBX_APP_PID -AutomationId NameBox -Action setvalue -Value 'Sandbox Tester' | Out-Null
Invoke-SbxUi -ProcessId $env:SBX_APP_PID -AutomationId GreetButton -Action invoke | Out-Null
Wait-SbxUi -ProcessId $env:SBX_APP_PID -AutomationId Output -Name 'Hello, Sandbox Tester!' -TimeoutSec 5 | Out-Null

1..2 | ForEach-Object {
    Invoke-SbxUi -ProcessId $env:SBX_APP_PID -AutomationId IncrementButton -Action invoke | Out-Null
    Wait-SbxUi -ProcessId $env:SBX_APP_PID -AutomationId Counter -Name "Count: $_" -TimeoutSec 5 | Out-Null
}

# Verify empty/whitespace input has a deterministic fallback too.
Invoke-SbxUi -ProcessId $env:SBX_APP_PID -AutomationId NameBox -Action setvalue -Value '   ' | Out-Null
Invoke-SbxUi -ProcessId $env:SBX_APP_PID -AutomationId GreetButton -Action invoke | Out-Null
Wait-SbxUi -ProcessId $env:SBX_APP_PID -AutomationId Output -Name 'Hello, Sandbox!' -TimeoutSec 5 | Out-Null
'PASS: WinUI greeting, counter, and blank-name fallback'
