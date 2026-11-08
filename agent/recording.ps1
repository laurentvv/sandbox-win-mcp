$script:recording = $null
function Op-RecordStart($req) {
    if ($script:recording -and -not $script:recording.process.HasExited) { throw 'A recording is already running.' }
    if ($req.recordingId -notmatch '^[a-f0-9]{32}$') { throw 'Invalid recordingId' }
    $fps = [int]$req.fps; $duration = [int]$req.maxDurationSec; $frames = [int]$req.maxFrames
    if ($fps -lt 1 -or $fps -gt 5 -or $duration -lt 1 -or $duration -gt 300 -or $frames -lt 1 -or $frames -gt 600) {
        throw 'Recording limits: fps 1-5, maxDurationSec 1-300, maxFrames 1-600.'
    }
    Assert-InteractiveDesktop
    $dir = Join-Path (Join-Path $OutDir 'recordings') $req.recordingId
    if (Test-Path -LiteralPath $dir) { throw 'Recording directory already exists; evidence will not be overwritten.' }
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
    # Existing control files avoid the shared-folder client's negative "not found" cache.
    [IO.File]::WriteAllText((Join-Path $dir 'started'), 'pending')
    [IO.File]::WriteAllText((Join-Path $dir 'control'), 'continue')
    $p = Start-Process powershell.exe -WindowStyle Hidden -PassThru -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$PSScriptRoot\record.ps1`" -Directory `"$dir`" -Fps $fps -MaxDurationSec $duration -MaxFrames $frames"
    $null = $p.Handle
    $script:recording = @{ id = [string]$req.recordingId; directory = $dir; process = $p }
    $deadline = (Get-Date).AddSeconds(15)
    while ((Read-DesktopSharedText (Join-Path $dir 'started')) -ne 'ready' -and -not $p.HasExited -and (Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 100
    }
    if ((Read-DesktopSharedText (Join-Path $dir 'started')) -ne 'ready') {
        [IO.File]::WriteAllText((Join-Path $dir 'control'), 'stop')
        throw "Recording did not capture its first frame. Evidence retained at $dir"
    }
    @{ recordingId = $req.recordingId; pid = $p.Id; fps = $fps; maxDurationSec = $duration; maxFrames = $frames }
}
function Op-RecordStop($req) {
    $r = $script:recording
    if (-not $r -or $r.id -ne $req.recordingId) { throw 'No matching recording in this agent.' }
    [IO.File]::WriteAllText((Join-Path $r.directory 'control'), 'stop')
    if (-not $r.process.WaitForExit(15000)) { throw "Recorder did not stop; partial evidence retained at $($r.directory)" }
    @{ recordingId = $r.id; stopped = $true }
}
