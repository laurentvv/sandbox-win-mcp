# Package installation is opt-in and happens only inside the disposable guest.
function Install-SbxPackage {
    param([Parameter(Mandatory=$true)][string]$PackagePath, [string]$CertificatePath,
          [string[]]$DependencyPath, [string]$ApplicationId)
    $ErrorActionPreference = 'Stop'
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [IO.Compression.ZipFile]::OpenRead($PackagePath)
    try {
        $entry = $zip.GetEntry('AppxManifest.xml')
        if (-not $entry) { $entry = $zip.GetEntry('AppxMetadata/AppxBundleManifest.xml') }
        if (-not $entry) { throw 'Package has no AppxManifest.xml or AppxBundleManifest.xml.' }
        $reader = New-Object IO.StreamReader($entry.Open())
        try { [xml]$manifest = $reader.ReadToEnd() } finally { $reader.Dispose() }
        $identity = $manifest.DocumentElement.SelectSingleNode("*[local-name()='Identity']")
        if (-not $identity.Name -or -not $identity.Publisher -or -not $identity.Version) {
            throw 'Package manifest must specify Identity Name, Publisher and Version.'
        }
        $name = [string]$identity.Name
        $publisher = [string]$identity.Publisher
        $version = [version]$identity.Version
        $architecture = [string]$identity.ProcessorArchitecture
        $payloads = @($manifest.DocumentElement.SelectNodes("*[local-name()='Packages']/*[local-name()='Package' and @Type='application']"))
        $isBundle = $manifest.DocumentElement.LocalName -eq 'Bundle'
    } finally { $zip.Dispose() }
    if ($CertificatePath) {
        Import-Certificate -FilePath $CertificatePath -CertStoreLocation Cert:\LocalMachine\TrustedPeople | Out-Null
    }
    try {
        $params = @{ Path = $PackagePath; ErrorAction = 'Stop' }
        if ($DependencyPath) { $params.DependencyPath = $DependencyPath }
        Add-AppxPackage @params
    } catch {
        $details = ($_ | Out-String)
        if ($_.Exception.Message -match '(?i)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})') {
            $activity = $Matches[1]
            try { $details += (Get-AppPackageLog -ActivityID $activity -ErrorAction Stop | Out-String) }
            catch { $details += "`nDeployment log unavailable: $($_.Exception.Message)" }
        }
        throw "Add-AppxPackage failed for '$PackagePath': $details"
    }
    $candidates = @(Get-AppxPackage | Where-Object {
        $_.Name -eq $name -and $_.Publisher -eq $publisher -and -not $_.IsFramework -and -not $_.IsResourcePackage
    })
    $candidates = @($candidates | Where-Object {
        $candidate = $_
        if ($isBundle) {
            @($payloads | Where-Object {
                [version]$_.Version -eq [version]$candidate.Version -and $_.Architecture -eq [string]$candidate.Architecture
            }).Count -gt 0
        } else {
            [version]$candidate.Version -eq $version -and (-not $architecture -or $architecture -eq [string]$candidate.Architecture)
        }
    })
    if ($candidates.Count -ne 1) {
        throw "Installed package '$name' (publisher '$publisher', version $version) did not resolve uniquely for the current user."
    }
    $package = $candidates[0]
    $installed = Get-AppxPackageManifest -Package $package.PackageFullName
    $apps = @($installed.Package.Applications.Application | Where-Object { $_ -and $_.Id })
    if ($ApplicationId) { $apps = @($apps | Where-Object Id -eq $ApplicationId) }
    if ($apps.Count -ne 1) {
        throw "Select one application with --app-id. Found: $(@($installed.Package.Applications.Application | ForEach-Object Id) -join ', ')"
    }
    @{
        packageFullName = $package.PackageFullName
        aumid = "$($package.PackageFamilyName)!$($apps[0].Id)"
        installLocation = $package.InstallLocation
        executable = [Environment]::ExpandEnvironmentVariables([string]$apps[0].Executable)
    }
}
