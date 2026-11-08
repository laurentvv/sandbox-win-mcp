# Build and dev-sign without trusting the certificate or registering the package on the host.
$ErrorActionPreference = 'Stop'
& "$PSScriptRoot\build.ps1"
if (-not (Get-Command winapp -ErrorAction SilentlyContinue)) { throw 'Install winapp CLI to package this sample.' }
$layout = "$PSScriptRoot\bin\layout"
New-Item -ItemType Directory -Force $layout | Out-Null
Copy-Item "$PSScriptRoot\bin\publish\NativeWin32.exe", "$PSScriptRoot\AppxManifest.xml" $layout -Force
Add-Type -AssemblyName System.Drawing
$image = New-Object Drawing.Bitmap(150, 150)
$graphics = [Drawing.Graphics]::FromImage($image)
try {
    $graphics.Clear([Drawing.Color]::SteelBlue)
    $image.Save("$layout\Logo.png")
} finally { $graphics.Dispose(); $image.Dispose() }
winapp cert generate --manifest "$layout\AppxManifest.xml" --output "$PSScriptRoot\bin\devcert.pfx" --export-cer --if-exists skip --quiet
if ($LASTEXITCODE) { throw "Certificate generation failed ($LASTEXITCODE)" }
winapp package $layout --cert "$PSScriptRoot\bin\devcert.pfx" --skip-pri --output "$PSScriptRoot\bin\NativeWin32.msix" --quiet
if ($LASTEXITCODE) { throw "MSIX packaging failed ($LASTEXITCODE)" }
"Package: $PSScriptRoot\bin\NativeWin32.msix"
"Public certificate: $PSScriptRoot\bin\devcert.cer"
