# UI Automation helpers for the sbx guest agent, also handy in `sbx run --test` scripts:
#   Import-Module C:\sbx\agent\SbxUi.psm1
#   Invoke-SbxUi -ProcessId $env:SBX_APP_PID -AutomationId NameBox -Action setvalue -Value 'Ada'
#   Invoke-SbxUi -ProcessId $env:SBX_APP_PID -Name Greet
#   Wait-SbxUi -ProcessId $env:SBX_APP_PID -Name 'Hello, Ada!' -TimeoutSec 5
# Uses native UIA (see uia.cs) through a COM interop generated at runtime from UIAutomationCore.dll.

function Initialize-SbxUi {
    if ('SbxUia' -as [type]) { return }
    if (-not ('SbxTlb' -as [type])) {
        Add-Type -TypeDefinition @'
using System; using System.Reflection; using System.Runtime.InteropServices;
public static class SbxTlb {
    [DllImport("oleaut32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
    static extern void LoadTypeLibEx(string file, int kind, [MarshalAs(UnmanagedType.Interface)] out object tlb);
    class Sink : ITypeLibImporterNotifySink {
        public void ReportEvent(ImporterEventKind k, int c, string m) { }
        public Assembly ResolveRef(object t) { return null; }
    }
    public static void Generate(string file) {
        object tlb; LoadTypeLibEx(Environment.ExpandEnvironmentVariables(@"%SystemRoot%\System32\UIAutomationCore.dll"), 2, out tlb);
        var ab = new TypeLibConverter().ConvertTypeLibToAssembly(tlb, file, TypeLibImporterFlags.None, new Sink(), null, null, "UIAutomationClient", null);
        ab.Save(System.IO.Path.GetFileName(file));
    }
}
'@
    }
    $dir = Join-Path $env:TEMP 'sbx-uia'
    New-Item -ItemType Directory -Force $dir | Out-Null
    $interop = Join-Path $dir 'Interop.UIAutomationClient.dll'
    if (-not (Test-Path $interop)) { [SbxTlb]::Generate($interop) }
    Add-Type -Path $interop # load it first so the compiled code can resolve it by name
    # A self-contained app's working directory can contain modern System.dll facades.
    $framework = [Runtime.InteropServices.RuntimeEnvironment]::GetRuntimeDirectory()
    Add-Type -Path (Join-Path $PSScriptRoot 'uia.cs') -ReferencedAssemblies $interop, (Join-Path $framework 'System.dll'), (Join-Path $framework 'System.Core.dll')
}

# Surface the real error instead of PowerShell's "Exception calling X with N argument(s)" wrapper.
function Invoke-Unwrapped([scriptblock]$Body) {
    try { & $Body } catch {
        $e = $_.Exception
        if ($e -is [System.Management.Automation.MethodInvocationException] -and $e.InnerException) { throw $e.InnerException.Message }
        throw
    }
}

function Get-SbxUiTree {
    param([int]$ProcessId, [string]$WindowTitle, [int]$Depth = 12, [int]$MaxNodes = 400)
    Initialize-SbxUi
    Invoke-Unwrapped { [SbxUia]::Tree($ProcessId, $WindowTitle, $Depth, $MaxNodes, 60000) }
}

function Invoke-SbxUi {
    param([int]$ProcessId, [string]$WindowTitle, [string]$Name, [string]$AutomationId, [string]$ControlType, [int]$Index = 0,
          [ValidateSet('click', 'invoke', 'doubleclick', 'rightclick', 'setvalue', 'set', 'toggle', 'select', 'expand', 'collapse', 'focus', 'read')]
          [string]$Action = 'click', [string]$Value, [double]$TimeoutSec = 10)
    Initialize-SbxUi
    Invoke-Unwrapped { [SbxUia]::Act($ProcessId, $WindowTitle, $Name, $AutomationId, $ControlType, $Index, $Action, $Value, [int]($TimeoutSec * 1000)) }
}

function Wait-SbxUi {
    param([int]$ProcessId, [string]$WindowTitle, [string]$Name, [string]$AutomationId, [string]$ControlType, [double]$TimeoutSec = 30)
    Initialize-SbxUi
    Invoke-Unwrapped { [SbxUia]::Wait($ProcessId, $WindowTitle, $Name, $AutomationId, $ControlType, [int]($TimeoutSec * 1000)) }
}

Export-ModuleMember -Function Initialize-SbxUi, Get-SbxUiTree, Invoke-SbxUi, Wait-SbxUi
