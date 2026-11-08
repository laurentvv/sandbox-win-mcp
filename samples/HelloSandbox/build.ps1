# Builds samples\HelloSandbox\bin\HelloSandbox.exe with the inbox .NET Framework compiler.
$here = $PSScriptRoot
$csc = "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
New-Item -ItemType Directory -Force "$here\bin" | Out-Null
& $csc /nologo /target:winexe /out:"$here\bin\HelloSandbox.exe" /r:System.Windows.Forms.dll /r:System.Drawing.dll "$here\Program.cs"
if ($LASTEXITCODE) { throw "csc failed ($LASTEXITCODE)" }
"$here\bin\HelloSandbox.exe"
