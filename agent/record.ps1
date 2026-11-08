param([string]$Directory, [int]$Fps = 2, [int]$MaxDurationSec = 120, [int]$MaxFrames = 240)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'desktop.ps1')
$utf8 = New-Object Text.UTF8Encoding($false)
$clock = [Diagnostics.Stopwatch]::StartNew()
$count = 0; $errorText = $null
try {
    while ($count -lt $MaxFrames -and $clock.Elapsed.TotalSeconds -lt $MaxDurationSec -and
        (Read-DesktopSharedText (Join-Path $Directory 'control')) -ne 'stop') {
        $facts = Get-DesktopFacts
        if (-not $facts.ready) { throw 'desktop not interactive (locked / secure desktop / UAC)' }
        $bmp = $null; $small = $null; $g = $null
        try {
            $bmp = New-Object Drawing.Bitmap $facts.width, $facts.height
            $g = [Drawing.Graphics]::FromImage($bmp)
            $g.CopyFromScreen($facts.left, $facts.top, 0, 0, $bmp.Size); $g.Dispose(); $g = $null
            Assert-CaptureDesktop $facts
            $scale = [Math]::Min(1.0, 1280.0 / $bmp.Width)
            $w = [Math]::Max(1, [int]($bmp.Width * $scale)); $h = [Math]::Max(1, [int]($bmp.Height * $scale))
            $small = New-Object Drawing.Bitmap $w, $h
            $g = [Drawing.Graphics]::FromImage($small)
            $g.DrawImage($bmp, 0, 0, $w, $h); $g.Dispose(); $g = $null
            $file = 'frame-{0:D6}.png' -f $count
            $dest = Join-Path $Directory $file
            $small.Save("$dest.tmp", [Drawing.Imaging.ImageFormat]::Png)
            [IO.File]::Move("$dest.tmp", $dest)
            $frame = @{ file = $file; timestamp = [DateTime]::UtcNow.ToString('o'); elapsedMs = $clock.ElapsedMilliseconds
                left = $facts.left; top = $facts.top; width = $facts.width; height = $facts.height
                imageWidth = $w; imageHeight = $h; scale = $scale; foregroundWindow = $facts.foregroundWindow }
            [IO.File]::AppendAllText((Join-Path $Directory 'frames.jsonl'), ($frame | ConvertTo-Json -Compress -Depth 4) + "`n", $utf8)
            $count++
            if ($count -eq 1) { [IO.File]::WriteAllText((Join-Path $Directory 'started'), 'ready', $utf8) }
        } finally {
            if ($g) { $g.Dispose() }; if ($small) { $small.Dispose() }; if ($bmp) { $bmp.Dispose() }
        }
        $due = $count * 1000.0 / $Fps - $clock.ElapsedMilliseconds
        if ($due -gt 0) { Start-Sleep -Milliseconds ([int]$due) }
    }
} catch { $errorText = $_.Exception.Message }
finally {
    $status = @{ frames = $count; durationMs = $clock.ElapsedMilliseconds; error = $errorText }
    $statusPath = Join-Path $Directory 'status.json'
    [IO.File]::WriteAllText("$statusPath.tmp", ($status | ConvertTo-Json -Compress), $utf8)
    [IO.File]::Move("$statusPath.tmp", $statusPath)
}
