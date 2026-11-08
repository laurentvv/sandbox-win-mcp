# sbx guest agent. Runs inside Windows Sandbox in the interactive user session (so GUI apps, screenshots and
# input work). Protocol: one JSON request line per TCP connection, one JSON response line back; or, with
# -Mailbox (sandbox has no network), request/response files in the shared folders.
param([int]$Port = 5985, [string]$TokenFile = 'C:\sbx\agent\token.txt', [string]$OutDir = 'C:\sbx\out',
      [int]$IdleMinutes = 30, [switch]$Mailbox)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -Namespace Sbx -Name Native -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
[DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, uint d, System.IntPtr e);
[DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, uint f, System.IntPtr e);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr h);
[DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr h, int c);
[DllImport("user32.dll")] public static extern bool IsIconic(System.IntPtr h);
[DllImport("user32.dll")] public static extern bool IsWindow(System.IntPtr h);
[DllImport("user32.dll")] public static extern bool GetWindowRect(System.IntPtr h, out RECT r);
[DllImport("user32.dll")] public static extern bool PrintWindow(System.IntPtr h, System.IntPtr hdc, uint f);
[DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(System.IntPtr h, int a, out RECT r, int size);
[StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
'@
[Sbx.Native]::SetProcessDPIAware() | Out-Null
. (Join-Path $PSScriptRoot 'desktop.ps1')
$script:captures = @{}
. (Join-Path $PSScriptRoot 'recording.ps1')

# Visible window bounds (excludes the invisible resize border that GetWindowRect includes).
function Get-WindowBounds($h) {
    $r = New-Object Sbx.Native+RECT
    if ([Sbx.Native]::DwmGetWindowAttribute($h, 9, [ref]$r, 16) -ne 0) { [Sbx.Native]::GetWindowRect($h, [ref]$r) | Out-Null }
    $r
}

$token = (Get-Content $TokenFile -Raw).Trim()
$identity = Get-Content (Join-Path $PSScriptRoot 'identity.json') -Raw | ConvertFrom-Json
$agentFiles = [string[]]@(Get-ChildItem $PSScriptRoot -File | Where-Object Name -NotIn @('token.txt', 'identity.json') | ForEach-Object Name)
[Array]::Sort($agentFiles, [StringComparer]::Ordinal)
$sha = [Security.Cryptography.SHA256]::Create()
try {
    $manifest = (@($agentFiles | ForEach-Object {
        $fileHash = [BitConverter]::ToString($sha.ComputeHash([IO.File]::ReadAllBytes((Join-Path $PSScriptRoot $_)))).Replace('-', '').ToLowerInvariant()
        $_ + [char]0 + $fileHash + "`n"
    }) -join '')
    $agentHash = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($manifest))).Replace('-', '').ToLowerInvariant()
} finally { $sha.Dispose() }
if ($identity.protocolVersion -ne 2 -or $agentHash -ne $identity.agentSha256) { throw 'Sandbox agent identity/protocol mismatch' }
Add-Type -Path (Join-Path $PSScriptRoot 'protocol.cs') -ReferencedAssemblies System.Web.Extensions
$protocol = New-Object SbxProtocol $token, ([string]$identity.epoch)
$shotDir = Join-Path $OutDir 'screenshots'
New-Item -ItemType Directory -Force $shotDir | Out-Null
$script:shotCount = 0

# Solid desktop instead of the photo wallpaper: full-screen PNGs drop from ~16 MB to a few hundred KB and read better.
try {
    Add-Type -Namespace Sbx -Name Desk -MemberDefinition @'
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool SystemParametersInfo(uint a, uint p, string v, uint f);
[DllImport("user32.dll")] public static extern bool SetSysColors(int n, int[] e, int[] c);
'@
    Set-ItemProperty 'HKCU:\Control Panel\Colors' Background '32 40 52'
    Set-ItemProperty 'HKCU:\Control Panel\Desktop' WallPaper ''
    [Sbx.Desk]::SetSysColors(1, @(1), @(0x342820)) | Out-Null
    [Sbx.Desk]::SystemParametersInfo(0x14, 0, '', 3) | Out-Null
} catch { }

function Find-Window($req) {
    $procs = Get-Process | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero }
    if ($req.pid) { $procs = $procs | Where-Object Id -eq ([int]$req.pid) }
    if ($req.windowTitle) { $procs = $procs | Where-Object { $_.MainWindowTitle -like "*$($req.windowTitle)*" } }
    $p = $procs | Select-Object -First 1
    if (-not $p) { throw "No window found (title='$($req.windowTitle)' pid='$($req.pid)')" }
    $p
}

function Focus-Window($h) {
    if ([Sbx.Native]::IsIconic($h)) { [Sbx.Native]::ShowWindow($h, 9) | Out-Null }
    # Tapping ALT lifts the foreground lock so SetForegroundWindow is honored.
    [Sbx.Native]::keybd_event(0x12, 0, 0, [IntPtr]::Zero); [Sbx.Native]::keybd_event(0x12, 0, 2, [IntPtr]::Zero)
    [Sbx.Native]::SetForegroundWindow($h) | Out-Null
    Start-Sleep -Milliseconds 150
}

function Op-Exec($req) {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    if ($req.shell -eq 'cmd') {
        $psi.FileName = 'cmd.exe'; $psi.Arguments = "/d /s /c `"$($req.command)`""
    } else {
        $enc = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes("`$ProgressPreference='SilentlyContinue'`n" + [string]$req.command))
        $psi.FileName = 'powershell.exe'; $psi.Arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -OutputFormat Text -EncodedCommand $enc"
    }
    if ($req.cwd) { $psi.WorkingDirectory = $req.cwd }
    $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $p = [Diagnostics.Process]::Start($psi)
    $out = $p.StandardOutput.ReadToEndAsync(); $err = $p.StandardError.ReadToEndAsync()
    $timeoutMs = [int]([double]$(if ($req.timeoutSec) { $req.timeoutSec } else { 120 }) * 1000)
    $timedOut = -not $p.WaitForExit($timeoutMs)
    if ($timedOut) { & taskkill.exe /T /F /PID $p.Id 2>&1 | Out-Null; $p.WaitForExit(5000) | Out-Null }
    @{ exitCode = $(if ($timedOut) { $null } else { $p.ExitCode }); timedOut = $timedOut
       stdout = $out.Result; stderr = (Convert-Stderr $err.Result); durationMs = $sw.ElapsedMilliseconds }
}

# powershell.exe writes its error stream as CLIXML when stderr is redirected; turn it back into plain text.
function Convert-Stderr([string]$s) {
    if (-not $s -or -not $s.StartsWith('#< CLIXML')) { return $s }
    try {
        $x = [xml]$s.Substring($s.IndexOf('<Objs'))
        $t = (@($x.Objs.ChildNodes | Where-Object LocalName -eq 'S' | ForEach-Object InnerText) -join '')
        [regex]::Replace($t, '_x([0-9A-Fa-f]{4})_', { param($m) [string][char][Convert]::ToInt32($m.Groups[1].Value, 16) }).TrimEnd()
    } catch { $s }
}

$script:launched = @{}

function Op-Launch($req) {
    $launchedAt = (Get-Date).ToString('o')
    if ($req.aumid) {
        if (-not ('SbxActivation' -as [type])) {
            Add-Type -Path (Join-Path $PSScriptRoot 'activation.cs')
        }
        $appPid = [SbxActivation]::Launch([string]$req.aumid, [string]$req.args)
        $p = Get-Process -Id $appPid -ErrorAction Stop
    } else {
        $a = @{ FilePath = [Environment]::ExpandEnvironmentVariables($req.path); PassThru = $true }
        if ($req.args) { $a.ArgumentList = $req.args }
        if ($req.cwd) { $a.WorkingDirectory = $req.cwd } elseif (Split-Path -Parent $a.FilePath) { $a.WorkingDirectory = Split-Path -Parent $a.FilePath }
        $p = Start-Process @a
    }
    $null = $p.Handle # keep the handle so ExitCode is available after the process exits
    $script:launched[$p.Id] = $p
    if ($req.waitForWindowSec) {
        $deadline = (Get-Date).AddSeconds([double]$req.waitForWindowSec)
        while ((Get-Date) -lt $deadline) {
            $p.Refresh(); if ($p.HasExited -or $p.MainWindowHandle -ne [IntPtr]::Zero) { break }
            Start-Sleep -Milliseconds 200
        }
        $p.Refresh()
    }
    @{ pid = $p.Id; hasExited = $p.HasExited; windowTitle = $(if (-not $p.HasExited) { $p.MainWindowTitle }); launchedAt = $launchedAt }
}

function Op-Process($req) {
    $p = $script:launched[[int]$req.pid]
    if (-not $p) { $p = Get-Process -Id ([int]$req.pid) -ErrorAction SilentlyContinue }
    if (-not $p) { return @{ pid = [int]$req.pid; hasExited = $true; exitCode = $null; hasWindow = $false } }
    $p.Refresh()
    $alive = -not $p.HasExited
    @{ pid = $p.Id; hasExited = $p.HasExited; exitCode = $(if (-not $alive) { $p.ExitCode })
       hasWindow = ($alive -and $p.MainWindowHandle -ne [IntPtr]::Zero); windowTitle = $(if ($alive) { $p.MainWindowTitle }) }
}

function Op-Copy($req) {
    if (-not (Test-Path -LiteralPath $req.from)) { throw "Source not found: $($req.from)" }
    $parent = Split-Path -Parent $req.to
    if ($parent) { New-Item -ItemType Directory -Force $parent | Out-Null }
    if (Test-Path -LiteralPath $req.to) { Remove-Item -LiteralPath $req.to -Recurse -Force }
    Copy-Item -LiteralPath $req.from -Destination $req.to -Recurse -Force
    $items = @(Get-ChildItem -LiteralPath $req.to -Recurse -File -ErrorAction SilentlyContinue)
    if ((Get-Item -LiteralPath $req.to) -is [IO.FileInfo]) { $items = @(Get-Item -LiteralPath $req.to) }
    @{ path = $req.to; files = $items.Count; bytes = ($items | Measure-Object Length -Sum).Sum }
}

function Op-Screenshot($req) {
    $desktopBefore = Get-DesktopFacts
    $left = 0; $top = 0
    if ($req.windowTitle -or $req.pid) {
        # Focus + copy from screen (not PrintWindow) so DPI-virtualized apps are captured at their real size.
        $p = Find-Window $req; $h = $p.MainWindowHandle
        Focus-Window $h; Start-Sleep -Milliseconds 200
        $r = Get-WindowBounds $h
        $left = $r.Left; $top = $r.Top
        $bmp = New-Object Drawing.Bitmap ([Math]::Max(1, $r.Right - $r.Left)), ([Math]::Max(1, $r.Bottom - $r.Top))
        $g = [Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($r.Left, $r.Top, 0, 0, $bmp.Size); $g.Dispose()
    } else {
        $b = [Windows.Forms.SystemInformation]::VirtualScreen
        $left = $b.Left; $top = $b.Top
        $bmp = New-Object Drawing.Bitmap $b.Width, $b.Height
        $g = [Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size); $g.Dispose()
    }
    try { Assert-CaptureDesktop $desktopBefore } catch { $bmp.Dispose(); throw }
    $script:shotCount++
    $name = '{0:D3}-{1}' -f $script:shotCount, $(if ($req.name) { $req.name -replace '[^\w\-]', '_' } else { 'shot' })
    $full = Join-Path $shotDir "$name.png"; $bmp.Save($full, [Drawing.Imaging.ImageFormat]::Png)
    $maxW = $(if ($req.maxWidth) { [int]$req.maxWidth } else { 1280 })
    $scale = [Math]::Min(1.0, $maxW / $bmp.Width)
    $sw = [Math]::Max(1, [int]($bmp.Width * $scale)); $sh = [Math]::Max(1, [int]($bmp.Height * $scale))
    $small = New-Object Drawing.Bitmap $sw, $sh
    $g = [Drawing.Graphics]::FromImage($small); $g.InterpolationMode = 'HighQualityBicubic'
    $g.DrawImage($bmp, 0, 0, $sw, $sh); $g.Dispose()
    $preview = Join-Path $shotDir "$name.preview.png"; $small.Save($preview, [Drawing.Imaging.ImageFormat]::Png)
    $captureId = [Guid]::NewGuid().ToString('N')
    $res = @{ captureId = $captureId; file = "$name.png"; preview = "$name.preview.png"; width = $bmp.Width; height = $bmp.Height
              previewWidth = $sw; previewHeight = $sh; scale = $scale; left = $left; top = $top }
    if ($h) { $res.windowHandle = $h.ToInt64().ToString() }
    $script:captures[$captureId] = $res
    $bmp.Dispose(); $small.Dispose(); $res
}

function Op-Windows($req) {
    @(Get-Process | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero -and $_.MainWindowTitle } | ForEach-Object {
        $r = Get-WindowBounds $_.MainWindowHandle
        @{ pid = $_.Id; process = $_.ProcessName; title = $_.MainWindowTitle
           left = $r.Left; top = $r.Top; width = $r.Right - $r.Left; height = $r.Bottom - $r.Top }
    })
}

function Op-Click($req) {
    if ($req.captureId) {
        $shot = $script:captures[[string]$req.captureId]
        if (-not $shot) { throw 'Unknown captureId; take another screenshot.' }
        if ($shot.windowHandle) {
            $h = [IntPtr][long]$shot.windowHandle
            $r = Get-WindowBounds $h
            if (-not [Sbx.Native]::IsWindow($h) -or [Sbx.Native]::IsIconic($h) -or $r.Left -ne $shot.left -or $r.Top -ne $shot.top -or
                ($r.Right - $r.Left) -ne $shot.width -or ($r.Bottom - $r.Top) -ne $shot.height) {
                throw 'Captured window moved, resized, minimized or closed; take another screenshot.'
            }
        } else {
            $bounds = [Windows.Forms.SystemInformation]::VirtualScreen
            if ($bounds.Left -ne $shot.left -or $bounds.Top -ne $shot.top -or
                $bounds.Width -ne $shot.width -or $bounds.Height -ne $shot.height) {
                throw 'Desktop bounds changed since capture; take another screenshot.'
            }
        }
    }
    if (-not [Sbx.Native]::SetCursorPos([int]$req.x, [int]$req.y)) {
        throw 'desktop not interactive (locked / secure desktop / UAC): SetCursorPos failed'
    }
    Start-Sleep -Milliseconds 50
    $down, $up = if ($req.button -eq 'right') { 0x08, 0x10 } else { 0x02, 0x04 }
    $n = $(if ($req.double) { 2 } else { 1 })
    for ($i = 0; $i -lt $n; $i++) {
        [Sbx.Native]::mouse_event($down, 0, 0, 0, [IntPtr]::Zero); [Sbx.Native]::mouse_event($up, 0, 0, 0, [IntPtr]::Zero)
        Start-Sleep -Milliseconds 60
    }
    @{ x = [int]$req.x; y = [int]$req.y }
}

function Op-Keys($req) {
    if ($req.windowTitle -or $req.pid) { Focus-Window (Find-Window $req).MainWindowHandle }
    $keys = [string]$req.keys
    if ($req.literal) { $keys = [regex]::Replace($keys, '[+^%~(){}\[\]]', { param($m) '{' + $m.Value + '}' }) }
    [Windows.Forms.SendKeys]::SendWait($keys)
    @{ sent = $keys.Length }
}

# UI Automation lives in SbxUi.psm1 so in-guest test scripts can use the same helpers.
function Get-Opt($v, $default) { if ($null -eq $v -or "$v" -eq '') { $default } else { $v } }
function Import-SbxUi { if (-not (Get-Command Invoke-SbxUi -ErrorAction SilentlyContinue)) { Import-Module (Join-Path $PSScriptRoot 'SbxUi.psm1') } }

function Op-UiTree($req) {
    Import-SbxUi
    Get-SbxUiTree -ProcessId ([int]$req.pid) -WindowTitle ([string]$req.windowTitle) -Depth (Get-Opt $req.depth 12) -MaxNodes (Get-Opt $req.maxNodes 400)
}

function Op-UiAction($req) {
    Import-SbxUi
    Invoke-SbxUi -ProcessId ([int]$req.pid) -WindowTitle ([string]$req.windowTitle) -Name ([string]$req.name) -AutomationId ([string]$req.automationId) `
        -ControlType ([string]$req.controlType) -Index ([int]$req.index) -Action (Get-Opt $req.action 'click') -Value ([string]$req.value)
}

function Op-UiWait($req) {
    Import-SbxUi
    Wait-SbxUi -ProcessId ([int]$req.pid) -WindowTitle ([string]$req.windowTitle) -Name ([string]$req.name) -AutomationId ([string]$req.automationId) `
        -ControlType ([string]$req.controlType) -TimeoutSec (Get-Opt $req.timeoutSec 30)
}

# System change tracking (see snap.cs): snapshot files/registry/services/autoruns/programs, then diff two snapshots.
$script:snapDir = 'C:\sbx-snap'
function Import-SbxSnap { if (-not ('SbxSnap' -as [type])) { Add-Type -Path (Join-Path $PSScriptRoot 'snap.cs') -ReferencedAssemblies System.Core } }
function Get-SnapPath([string]$name) {
    if ($name -notmatch '^[\w-]+$') { throw "Snapshot names may only contain letters, digits, - and _ (got '$name')" }
    Join-Path $script:snapDir "$name.tsv"
}
function Op-Snapshot($req) {
    Import-SbxSnap
    [SbxSnap]::Take((Get-SnapPath $req.name), [string[]]@($req.exclude | Where-Object { $_ }))
}
function Op-Diff($req) {
    Import-SbxSnap
    $a = Get-SnapPath $req.from; $b = Get-SnapPath $req.to
    foreach ($f in $a, $b) { if (-not (Test-Path $f)) { throw "No snapshot named '$([IO.Path]::GetFileNameWithoutExtension($f))'" } }
    [SbxSnap]::Diff($a, $b, [int](Get-Opt $req.max 200))
}

. "$PSScriptRoot\deploy.ps1"

function Invoke-Request([string]$line) {
    $counter = 1L
    $resp = try {
        $envelope = $line | ConvertFrom-Json
        if ($envelope.counter -gt 0 -and $envelope.counter -le 9007199254740991) { $counter = [long]$envelope.counter }
        $req = $protocol.Open($line, 'request', 0) | ConvertFrom-Json
        if ($req.op -in @('screenshot', 'click', 'keys', 'uiaction')) { Assert-InteractiveDesktop }
        $result = switch ($req.op) {
            'ping'       { @{ user = "$env:USERDOMAIN\$env:USERNAME"; computer = $env:COMPUTERNAME; pid = $PID
                             epoch = $identity.epoch; protocolVersion = 2; agentVersion = $identity.agentVersion; agentSha256 = $agentHash } }
            'desktop'    { Get-DesktopFacts }
            'recordstart' { Op-RecordStart $req }
            'recordstop'  { Op-RecordStop $req }
            'exec'       { Op-Exec $req }
            'launch'     { Op-Launch $req }
            'process'    { Op-Process $req }
            'copy'       { Op-Copy $req }
            'deploy_manifest' { Op-DeployManifest $req }
            'deploy_apply' { Op-DeployApply $req }
            'screenshot' { Op-Screenshot $req }
            'windows'    { , (Op-Windows $req) }
            'click'      { Op-Click $req }
            'keys'       { Op-Keys $req }
            'uitree'     { Op-UiTree $req }
            'uiaction'   { Op-UiAction $req }
            'uiwait'     { Op-UiWait $req }
            'snapshot'   { Op-Snapshot $req }
            'diff'       { Op-Diff $req }
            default      { throw "unknown op '$($req.op)'" }
        }
        # An op that outputs nothing yields AutomationNull, which PS 5.1 serializes as {}.
        if ($null -eq $result) { $result = $null }
        @{ ok = $true; result = $result }
    } catch {
        $ex = $_.Exception
        if ($ex -is [System.Management.Automation.MethodInvocationException] -and $ex.InnerException) { $ex = $ex.InnerException }
        @{ ok = $false; error = "$($ex.Message)" }
    }
    $protocol.Seal(($resp | ConvertTo-Json -Compress -Depth 8), 'response', $counter)
}

# Idle watchdog: shutting the guest down ends the sandbox, so a forgotten sandbox doesn't run forever.
$script:lastActivity = Get-Date
function Test-Idle {
    if ($IdleMinutes -gt 0 -and ((Get-Date) - $script:lastActivity).TotalMinutes -ge $IdleMinutes) {
        & shutdown.exe /s /t 0 /f
        exit
    }
}

if ($Mailbox) {
    # Offline transport: the host drops req-N.json into the read-only in share, then bumps seq.txt; we answer with
    # resp-N.json in out. The guest's share client caches "file not found" for ~5s, so we never probe for request
    # files that may not exist yet: we re-read seq.txt (always exists, content changes show up in ~50ms) and only
    # open req-N once seq says it is there. A slow direct probe is the fallback if seq.txt ever lags.
    $inBox = 'C:\sbx\in\mailbox'; $outBox = Join-Path $OutDir 'mailbox'; $seqFile = Join-Path $inBox 'seq.txt'
    New-Item -ItemType Directory -Force $outBox | Out-Null
    $n = 1; $polls = 0; $missingSince = $null
    function Read-Shared($p) {
        # FileShare.ReadWrite so our constant polling never blocks the host from bumping seq.txt.
        $fs = [IO.File]::Open($p, 'Open', 'Read', 'ReadWrite, Delete')
        try { (New-Object IO.StreamReader($fs)).ReadToEnd() } finally { $fs.Dispose() }
    }
    while ($true) {
        $f = Join-Path $inBox ('req-{0:D6}.json' -f $n)
        $avail = 0; try { $avail = [int](Read-Shared $seqFile) } catch { }
        $text = $null
        if ($avail -ge $n -or ((++$polls % 60) -eq 0 -and [IO.File]::Exists($f))) { try { $text = [IO.File]::ReadAllText($f) } catch { } }
        if ($text) {
            $json = Invoke-Request $text
            $out = Join-Path $outBox ('resp-{0:D6}.json' -f $n)
            [IO.File]::WriteAllText("$out.tmp", $json, (New-Object Text.UTF8Encoding($false)))
            Move-Item -LiteralPath "$out.tmp" -Destination $out -Force
            $n++; $missingSince = $null; $script:lastActivity = Get-Date
        } else {
            # A host process may die after reserving a number but before publishing its request.
            # Wait beyond the share's negative-cache lifetime before skipping a durable gap.
            if ($avail -gt $n) {
                if (-not $missingSince) { $missingSince = Get-Date }
                if (((Get-Date) - $missingSince).TotalSeconds -ge 10) {
                    $n++; $missingSince = $null
                    continue
                }
            }
            Start-Sleep -Milliseconds 50; Test-Idle
        }
    }
}

$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Any, $Port)
$listener.Start()
while ($true) {
    $accept = $listener.AcceptTcpClientAsync()
    while (-not $accept.Wait(1000)) { Test-Idle }
    $client = $accept.Result
    try {
        $stream = $client.GetStream()
        $stream.ReadTimeout = 5000
        $reader = New-Object IO.StreamReader($stream, [Text.Encoding]::UTF8)
        $writer = New-Object IO.StreamWriter($stream, (New-Object Text.UTF8Encoding($false))); $writer.AutoFlush = $true
        $writer.WriteLine((Invoke-Request $reader.ReadLine()))
    } catch { } finally { $client.Close(); $script:lastActivity = Get-Date }
}
