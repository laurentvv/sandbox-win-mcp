$ErrorActionPreference = 'Stop'
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$vs = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $vs) { throw 'Install Visual Studio C++ desktop build tools.' }
New-Item -ItemType Directory -Force "$PSScriptRoot\bin\publish" | Out-Null
& $env:ComSpec /d /c "call `"$vs\VC\Auxiliary\Build\vcvars64.bat`" >nul && cl /nologo /W4 /MT /O2 /Fe:`"$PSScriptRoot\bin\publish\NativeWin32.exe`" /Fo:`"$PSScriptRoot\bin\main.obj`" `"$PSScriptRoot\main.cpp`" /link /SUBSYSTEM:WINDOWS user32.lib gdi32.lib"
if ($LASTEXITCODE) { throw "cl failed ($LASTEXITCODE)" }
"$PSScriptRoot\bin\publish\NativeWin32.exe"
