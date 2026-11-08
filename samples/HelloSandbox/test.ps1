# Example test script for `sbx run --test`. It runs INSIDE the sandbox after the app is launched.
# The SbxUi module is already imported: Get-SbxUiTree, Invoke-SbxUi, Wait-SbxUi drive the app by control
# name through native UI Automation (works for WinForms, WPF, Win32 and WinUI), not by pixels.
# Available: $env:SBX_APP_PID, $env:SBX_APP_DIR, $env:SBX_APP_EXE, $env:SBX_OUT (copied back to the host).
# Exit 0 (or no error) = pass; a thrown error or non-zero exit = fail.
$ErrorActionPreference = 'Stop'
$app = @{ ProcessId = $env:SBX_APP_PID }

Invoke-SbxUi @app -AutomationId NameBox -Action setvalue -Value 'Sandbox Tester' | Out-Null
Invoke-SbxUi @app -Name Greet | Out-Null
$label = (Wait-SbxUi @app -AutomationId Output -Name 'Hello, Sandbox Tester!' -TimeoutSec 5).name
"label: $label"

$file = Join-Path $env:SBX_APP_DIR 'greeting.txt'
"file:  $(Get-Content $file)"
Copy-Item $file $env:SBX_OUT
if ((Get-Content $file) -ne $label) { throw 'greeting.txt does not match the label' }
'PASS'
