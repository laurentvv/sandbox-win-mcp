# Compile-check agent/uia.cs with the exact pipeline the guest uses: Windows PowerShell 5.1's
# C# 5 compiler plus a runtime-generated UIAutomationClient interop. Run before shipping any
# uia.cs change: the guest cannot report a compile error usefully.
# Usage: powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\check-uia.ps1
$ErrorActionPreference = 'Stop'
$agentDir = Join-Path $PSScriptRoot '..\agent'
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
$dir = Join-Path $env:TEMP 'sbx-uia-check'
New-Item -ItemType Directory -Force $dir | Out-Null
$interop = Join-Path $dir 'Interop.UIAutomationClient.dll'
if (-not (Test-Path $interop)) { [SbxTlb]::Generate($interop) }
Add-Type -Path $interop
$framework = [Runtime.InteropServices.RuntimeEnvironment]::GetRuntimeDirectory()
Add-Type -Path (Join-Path $agentDir 'uia.cs') -ReferencedAssemblies $interop, (Join-Path $framework 'System.dll'), (Join-Path $framework 'System.Core.dll')
Write-Output "uia.cs compiled OK (PS $($PSVersionTable.PSVersion), C# 5-compatible)"
