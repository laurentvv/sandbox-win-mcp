# Incremental deployment helpers, loaded by the guest agent (Windows PowerShell 5.1).
function Get-DeployHash([string]$file) {
    $stream = [IO.File]::OpenRead($file)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose(); $stream.Dispose() }
}

function Assert-DeployPath([string]$p) {
    $item = $p
    while ($item) {
        if (Test-Path -LiteralPath $item) {
            if ((Get-Item -LiteralPath $item -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw "Reparse point not allowed: $item"
            }
        }
        $item = Split-Path -Parent $item
    }
}

function Get-DeployRoot([string]$p) {
    if ($p -notmatch '^[A-Za-z]:\\' -or $p -match '[*?"<>|]' -or $p.Substring(2).Contains(':')) {
        throw 'Deployment destination must be an absolute local directory'
    }
    $root = [IO.Path]::GetFullPath($p).TrimEnd('\')
    if ($root.Length -le 3 -or $root -match '(?i)^C:\\(sbx|Windows)(\\|$)') {
        throw "Protected deployment destination: $root"
    }
    Assert-DeployPath $root
    $root
}

function Join-DeployPath([string]$root, [string]$relative) {
    if (-not $relative -or $relative -match '(^[\\/]|[:*?"<>|/]|(^|\\)\.\.?($|\\)|\\\\)' -or $relative.EndsWith('\')) {
        throw "Invalid deployment relative path: $relative"
    }
    $full = [IO.Path]::GetFullPath((Join-Path $root $relative))
    if (-not $full.StartsWith($root.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw "Deployment path escapes destination: $relative"
    }
    Assert-DeployPath $full
    $full
}

function Get-DeployManifest([string]$root) {
    $files = @(); $directories = @()
    if (Test-Path -LiteralPath $root) {
        Assert-DeployPath $root
        $item = Get-Item -LiteralPath $root -Force
        if (-not $item.PSIsContainer) { throw "Destination is not a directory: $root" }
        $root = $item.FullName.TrimEnd('\')
        $stack = New-Object 'Collections.Generic.Stack[string]'
        $stack.Push($root)
        while ($stack.Count) {
            foreach ($i in Get-ChildItem -LiteralPath $stack.Pop() -Force) {
                Assert-DeployPath $i.FullName
                $relative = $i.FullName.Substring($root.Length + 1)
                if ($i.PSIsContainer) { $directories += $relative; $stack.Push($i.FullName) }
                else {
                    $files += @{ path = $relative; size = $i.Length; sha256 = Get-DeployHash $i.FullName }
                }
            }
        }
    }
    @{ files = @($files); directories = @($directories) }
}

function Assert-DeployManifest($expected, $actual) {
    if (@($expected.files).Count -ne @($actual.files).Count -or
        @($expected.directories).Count -ne @($actual.directories).Count) { throw 'Deployment manifest mismatch (file/directory count)' }
    $map = @{}
    foreach ($f in $actual.files) { $map[$f.path] = $f }
    foreach ($f in $expected.files) {
        $a = $map[$f.path]
        if (-not $a -or $a.size -ne $f.size -or $a.sha256 -ne $f.sha256) { throw "Deployment hash mismatch: $($f.path)" }
    }
    $dirs = @{}
    foreach ($d in $actual.directories) { $dirs[$d] = $true }
    foreach ($d in $expected.directories) { if (-not $dirs.ContainsKey($d)) { throw "Deployment directory mismatch: $d" } }
}

function Op-DeployManifest($req) {
    Get-DeployManifest (Get-DeployRoot $req.destination)
}

function Op-DeployApply($req) {
    $root = Get-DeployRoot $req.destination
    $stage = [IO.Path]::GetFullPath([string]$req.from).TrimEnd('\')
    if ($stage -notmatch '^C:\\sbx\\in\\deploy-[0-9a-f-]+$') { throw 'Invalid deployment staging directory' }
    foreach ($f in $req.manifest.files) {
        $null = Join-DeployPath $root $f.path
        if ($f.sha256 -notmatch '^[a-fA-F0-9]{64}$' -or $f.size -lt 0) { throw 'Invalid deployment manifest entry' }
    }
    foreach ($d in $req.manifest.directories) { $null = Join-DeployPath $root $d }
    foreach ($f in $req.changed) {
        $file = Join-DeployPath $stage $f.path
        $i = Get-Item -LiteralPath $file -Force
        if ($i.Length -ne $f.size -or (Get-DeployHash $file) -ne $f.sha256) {
            throw "Staged file hash mismatch: $($f.path)"
        }
    }
    foreach ($f in $req.removed) { $null = Join-DeployPath $root $f.path }
    $launchPath = $null
    if ($req.launch) {
        $launchPath = if ([IO.Path]::IsPathRooted($req.launch)) { [IO.Path]::GetFullPath($req.launch) } else { Join-DeployPath $root $req.launch }
        if (-not $launchPath.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Launch executable must be inside deployment destination' }
        $found = @($req.manifest.files | Where-Object { (Join-DeployPath $root $_.path) -eq $launchPath })
        if (-not $found.Count) { throw "Launch executable not in deployment manifest: $launchPath" }
    }
    if ($req.restart -and -not $launchPath) { throw 'restart requires a launch executable' }
    Assert-DeployManifest $req.before (Get-DeployManifest $root)
    $existed = Test-Path -LiteralPath $root
    $backup = Join-Path $env:TEMP ('sbx-deploy-' + [guid]::NewGuid().ToString())
    New-Item -ItemType Directory -Path $backup | Out-Null
    $oldFiles = @{}; $stopped = @(); $retainBackup = $false
    foreach ($f in $req.before.files) { $oldFiles[$f.path] = $true }
    try {
        foreach ($f in @($req.changed) + @($req.removed)) {
            if ($oldFiles.ContainsKey($f.path)) {
                $to = Join-DeployPath $backup $f.path
                New-Item -ItemType Directory -Path (Split-Path -Parent $to) -Force | Out-Null
                Copy-Item -LiteralPath (Join-DeployPath $root $f.path) -Destination $to -Force
            }
        }
        if ($req.restart) {
            foreach ($p in Get-CimInstance Win32_Process) {
                if ($p.ExecutablePath -and $p.ExecutablePath.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase)) {
                    $process = Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue
                    if ($process -and -not $process.HasExited) {
                        Stop-Process -Id $process.Id -Force -ErrorAction Stop
                        if (-not $process.WaitForExit(10000)) { throw "Process did not stop for deployment: $($process.Id)" }
                        $stopped += $process.Id
                    }
                }
            }
        }
        try {
            foreach ($f in $req.removed) { Remove-Item -LiteralPath (Join-DeployPath $root $f.path) -Force }
            $desiredDirs = @{}
            foreach ($d in $req.manifest.directories) { $desiredDirs[$d] = $true }
            foreach ($d in @($req.before.directories | Sort-Object { $_.Length } -Descending)) {
                if (-not $desiredDirs.ContainsKey($d)) { [IO.Directory]::Delete((Join-DeployPath $root $d), $false) }
            }
            New-Item -ItemType Directory -Path $root -Force | Out-Null
            foreach ($d in $req.manifest.directories) { New-Item -ItemType Directory -Path (Join-DeployPath $root $d) -Force | Out-Null }
            foreach ($f in $req.changed) {
                $to = Join-DeployPath $root $f.path
                New-Item -ItemType Directory -Path (Split-Path -Parent $to) -Force | Out-Null
                Copy-Item -LiteralPath (Join-DeployPath $stage $f.path) -Destination $to -Force
            }
            Assert-DeployManifest $req.manifest (Get-DeployManifest $root)
        } catch {
            $failure = $_
            try {
                foreach ($f in $req.changed) {
                    $to = Join-DeployPath $root $f.path
                    if (-not $oldFiles.ContainsKey($f.path) -and (Test-Path -LiteralPath $to -PathType Leaf)) { Remove-Item -LiteralPath $to -Force }
                }
                $oldDirs = @{}
                foreach ($d in $req.before.directories) { $oldDirs[$d] = $true }
                foreach ($d in @($req.manifest.directories | Sort-Object { $_.Length } -Descending)) {
                    $to = Join-DeployPath $root $d
                    if (-not $oldDirs.ContainsKey($d) -and (Test-Path -LiteralPath $to -PathType Container)) { [IO.Directory]::Delete($to, $false) }
                }
                foreach ($d in $req.before.directories) { New-Item -ItemType Directory -Path (Join-DeployPath $root $d) -Force | Out-Null }
                foreach ($f in @($req.changed) + @($req.removed)) {
                    if ($oldFiles.ContainsKey($f.path)) {
                        $to = Join-DeployPath $root $f.path
                        New-Item -ItemType Directory -Path (Split-Path -Parent $to) -Force | Out-Null
                        $saved = Join-DeployPath $backup $f.path
                        if (-not (Test-Path -LiteralPath $to -PathType Leaf) -or
                            (Get-DeployHash $to) -ne (Get-DeployHash $saved)) {
                            Copy-Item -LiteralPath $saved -Destination $to -Force
                        }
                    }
                }
                Assert-DeployManifest $req.before (Get-DeployManifest $root)
                if (-not $existed -and (Test-Path -LiteralPath $root)) { [IO.Directory]::Delete($root, $false) }
            } catch {
                $retainBackup = $true
                throw "Deployment failed: $failure; rollback failed: $_; backup retained at $backup"
            }
            throw "Deployment failed; previous files restored: $failure"
        }
        $result = @{ verified = $true; stopped = @($stopped) }
        if ($launchPath) { $result.launch = Op-Launch @{ path = $launchPath; args = $req.args; cwd = $root; waitForWindowSec = 15 } }
        $result
    } finally {
        if (-not $retainBackup) { Remove-Item -LiteralPath $backup -Recurse -Force }
    }
}
