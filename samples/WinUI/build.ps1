# Builds only: never launches, installs a package, or trusts a certificate.
# Requires Windows x64, .NET 10 SDK, VS C++ x64 redist, and winapp 0.7.1.
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Invoke-Checked {
    param([string]$Tool, [string[]]$Arguments)
    & $Tool @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Tool failed with exit code $LASTEXITCODE" }
}

Push-Location $PSScriptRoot
try {
    $project = Join-Path $PSScriptRoot 'HelloWinUI.csproj'
    $bin = Join-Path $PSScriptRoot 'bin'
    $publish = Join-Path $bin 'unpackaged'
    $layout = Join-Path $bin 'package-layout'
    $cert = Join-Path $bin 'SandboxShowcase.pfx'
    $msix = Join-Path $bin 'HelloWinUI.msix'
    New-Item $bin -ItemType Directory -Force | Out-Null
    foreach ($path in @($publish, $layout, $msix)) {
        if (Test-Path $path) { Remove-Item $path -Recurse -Force }
    }

    # Try the global package cache without contacting a feed, then NuGet, then the proxy.
    # A committed lock file pins the transitive dependencies as well as direct references.
    $cacheInfo = & dotnet nuget locals global-packages --list
    if ($LASTEXITCODE -ne 0) { throw 'Cannot locate the NuGet global package cache.' }
    $cache = ($cacheInfo | Select-Object -Last 1) -replace '^global-packages:\s*', ''
    $restored = $false
    foreach ($source in @($cache, 'https://api.nuget.org/v3/index.json',
                         'https://packagefeedproxy.microsoft.io/nuget/v3/index.json')) {
        $restoreArgs = @('restore', $project, '--source', $source, '-p:NuGetAudit=false')
        if (Test-Path 'packages.lock.json') { $restoreArgs += '--locked-mode' }
        & dotnet @restoreArgs
        if ($LASTEXITCODE -eq 0) { $restored = $true; break }
    }
    if (-not $restored) { throw 'Restore failed from the local cache and both feeds.' }

    Invoke-Checked dotnet @('publish', $project, '-c', 'Release', '-p:Platform=x64',
        '--no-restore', '-o', $publish)

    # WindowsAppSDKSelfContained does NOT include the VC runtime. Deploy the licensed
    # release CRT app-locally instead of requiring a guest redist installer/framework.
    $vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
    $vs = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    if (-not $vs) { throw 'Visual Studio C++ x64 tools/redist are required.' }
    $redistRoot = Join-Path $vs 'VC\Redist\MSVC'
    $redist = Get-ChildItem $redistRoot -Directory |
        Where-Object { $_.Name -match '^\d+\.\d+\.\d+$' } |
        Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1
    $crt = @(Get-ChildItem (Join-Path $redist.FullName 'x64\Microsoft.VC*.CRT') -Directory)
    if ($crt.Count -ne 1) { throw "Expected one x64 CRT directory in $($redist.FullName)." }
    Copy-Item (Join-Path $crt[0].FullName '*.dll') $publish -Force
    foreach ($file in @('HelloWinUI.exe', 'App.xbf', 'MainWindow.xbf', 'resources.pri', 'coreclr.dll', 'hostfxr.dll', 'Microsoft.UI.Xaml.dll',
                        'Microsoft.WindowsAppRuntime.dll', 'vcruntime140.dll', 'vcruntime140_1.dll', 'msvcp140.dll')) {
        if (-not (Test-Path (Join-Path $publish $file))) { throw "Missing self-contained file: $file" }
    }

    # The merged app PRI contains WinUI theme XBF data, not just app strings.
    # Standalone Microsoft.UI.Xaml.Controls.pri alone is insufficient at startup.
    $sdkTools = Join-Path $cache 'microsoft.windows.sdk.buildtools\10.0.28000.2957\bin\10.0.28000.0\x64'
    $priDump = Join-Path $bin 'resources-pri.xml'
    Invoke-Checked (Join-Path $sdkTools 'makepri.exe') @('dump', '/if',
        (Join-Path $publish 'resources.pri'), '/of', $priDump, '/dt', 'detailed', '/o')
    if (-not (Select-String -LiteralPath $priDump -SimpleMatch 'Files/Microsoft.UI.Xaml/Themes/themeresources.xbf' -Quiet)) {
        throw 'Merged resources.pri is missing the WinUI theme resource.'
    }

    # Package the SAME self-contained payload; reg-free WinRT initialization works with
    # or without package identity. No framework PackageDependency entries are needed.
    Copy-Item $publish $layout -Recurse
    New-Item (Join-Path $layout 'Assets') -ItemType Directory -Force | Out-Null
    Add-Type -AssemblyName System.Drawing
    $logo = [System.Drawing.Bitmap]::new(150, 150)
    $graphics = [System.Drawing.Graphics]::FromImage($logo)
    try {
        $graphics.Clear([System.Drawing.Color]::SteelBlue)
        $graphics.FillRectangle([System.Drawing.Brushes]::White, 35, 35, 36, 36)
        $graphics.FillRectangle([System.Drawing.Brushes]::White, 79, 35, 36, 36)
        $graphics.FillRectangle([System.Drawing.Brushes]::White, 35, 79, 36, 36)
        $graphics.FillRectangle([System.Drawing.Brushes]::White, 79, 79, 36, 36)
        $logo.Save((Join-Path $layout 'Assets\Logo.png'), [System.Drawing.Imaging.ImageFormat]::Png)
    }
    finally { $graphics.Dispose(); $logo.Dispose() }

    # CertificateRequest is memory-only. Unlike New-SelfSignedCertificate (also used
    # by some CLI generators), it never inserts even an untrusted cert into host My.
    if (-not (Test-Path $cert)) {
        $key = [Security.Cryptography.RSA]::Create(2048)
        try {
            $request = [Security.Cryptography.X509Certificates.CertificateRequest]::new(
                'CN=SandboxShowcase', $key, [Security.Cryptography.HashAlgorithmName]::SHA256,
                [Security.Cryptography.RSASignaturePadding]::Pkcs1)
            $request.CertificateExtensions.Add(
                [Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($false, $false, 0, $true))
            $request.CertificateExtensions.Add(
                [Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new(
                    [Security.Cryptography.X509Certificates.X509KeyUsageFlags]::DigitalSignature, $true))
            $eku = [Security.Cryptography.OidCollection]::new()
            $eku.Add([Security.Cryptography.Oid]::new('1.3.6.1.5.5.7.3.3')) | Out-Null
            $request.CertificateExtensions.Add(
                [Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]::new($eku, $true))
            $certificate = $request.CreateSelfSigned([DateTimeOffset]::UtcNow.AddMinutes(-5),
                [DateTimeOffset]::UtcNow.AddDays(365))
            try {
                [IO.File]::WriteAllBytes($cert, $certificate.Export(
                    [Security.Cryptography.X509Certificates.X509ContentType]::Pfx, 'password'))
                [IO.File]::WriteAllBytes((Join-Path $bin 'SandboxShowcase.cer'), $certificate.Export(
                    [Security.Cryptography.X509Certificates.X509ContentType]::Cert))
            }
            finally { $certificate.Dispose() }
        }
        finally { $key.Dispose() }
    }
    # Use the pinned SDK packer directly: winapp package 0.7.1 otherwise rewrites
    # framework dependencies or re-extracts its own Windows App SDK runtime cache.
    # The publish output already includes the SDK's reg-free WinRT support + PRI.
    Copy-Item 'Package.appxmanifest' (Join-Path $layout 'AppxManifest.xml')
    $makeappx = Join-Path $sdkTools 'makeappx.exe'
    Invoke-Checked $makeappx @('pack', '/d', $layout, '/p', $msix, '/o')
    Invoke-Checked winapp @('sign', $msix, $cert, '--password', 'password')

    # Guard against CLI changes silently turning this into framework-dependent MSIX.
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [IO.Compression.ZipFile]::OpenRead($msix)
    try {
        $reader = [IO.StreamReader]::new($archive.GetEntry('AppxManifest.xml').Open())
        try { [xml]$manifest = $reader.ReadToEnd() }
        finally { $reader.Dispose() }
        if ($manifest.SelectNodes('//*[local-name()="PackageDependency"]').Count -ne 0) {
            throw 'Unexpected framework dependency in self-contained MSIX.'
        }
        foreach ($file in @('AppxSignature.p7x', 'App.xbf', 'MainWindow.xbf', 'resources.pri', 'coreclr.dll', 'Microsoft.UI.Xaml.dll', 'vcruntime140.dll')) {
            if (-not ($archive.Entries | Where-Object FullName -IEQ $file)) {
                throw "Missing MSIX payload file: $file"
            }
        }
    }
    finally { $archive.Dispose() }

    [pscustomobject]@{
        Exe = Join-Path $publish 'HelloWinUI.exe'
        Msix = $msix
        Certificate = Join-Path $bin 'SandboxShowcase.cer'
        SigningKey = $cert
    }
}
finally { Pop-Location }
