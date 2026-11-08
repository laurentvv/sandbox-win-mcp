# Shared by the serial agent and the independent recording process.
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
if (-not ('SbxDesktop' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class SbxDesktop {
    [DllImport("user32.dll")] public static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern bool GetUserObjectInformation(IntPtr h, int index, StringBuilder value, int size, out int needed);
    [DllImport("user32.dll")] public static extern bool CloseDesktop(IntPtr h);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern IntPtr GetThreadDesktop(uint threadId);
    [DllImport("user32.dll")] public static extern IntPtr GetProcessWindowStation();
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder text, int count);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
'@
}
[SbxDesktop]::SetProcessDPIAware() | Out-Null

function Get-DesktopObjectName([IntPtr]$handle) {
    if ($handle -eq [IntPtr]::Zero) { return '' }
    $text = New-Object Text.StringBuilder 256; $needed = 0
    if ([SbxDesktop]::GetUserObjectInformation($handle, 2, $text, 512, [ref]$needed)) { return $text.ToString() }
    ''
}

function Get-DesktopFacts {
    $name = ''; $captureWorks = $false; $captureError = $null
    $h = [SbxDesktop]::OpenInputDesktop(0, $false, 1)
    if ($h -ne [IntPtr]::Zero) {
        try {
            $name = Get-DesktopObjectName $h
        } finally { [SbxDesktop]::CloseDesktop($h) | Out-Null }
    }
    $b = [Windows.Forms.SystemInformation]::VirtualScreen
    $station = Get-DesktopObjectName ([SbxDesktop]::GetProcessWindowStation())
    $threadDesktop = Get-DesktopObjectName ([SbxDesktop]::GetThreadDesktop([SbxDesktop]::GetCurrentThreadId()))
    $sessionId = [Diagnostics.Process]::GetCurrentProcess().SessionId
    $interactive = $sessionId -gt 0 -and $station -eq 'WinSta0' -and $name -eq 'Default' -and $threadDesktop -eq $name
    $shell = [bool](Get-Process explorer -ErrorAction SilentlyContinue)
    if ($interactive -and $shell -and $b.Width -gt 0 -and $b.Height -gt 0) {
        $bmp = $null; $g = $null
        try {
            $bmp = New-Object Drawing.Bitmap $b.Width, $b.Height
            $g = [Drawing.Graphics]::FromImage($bmp)
            $g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
            $captureWorks = $true
        } catch { $captureError = $_.Exception.Message }
        finally { if ($g) { $g.Dispose() }; if ($bmp) { $bmp.Dispose() } }
    }
    $foreground = [SbxDesktop]::GetForegroundWindow()
    $title = New-Object Text.StringBuilder 1024
    [SbxDesktop]::GetWindowText($foreground, $title, $title.Capacity) | Out-Null
    @{ ready = ($interactive -and $shell -and $captureWorks); inputDesktop = $name
       windowStation = $station; threadDesktop = $threadDesktop; sessionId = $sessionId
       shellRunning = $shell; captureWorks = $captureWorks; captureError = $captureError
       left = $b.Left; top = $b.Top; width = $b.Width; height = $b.Height
       foregroundWindow = @{ handle = $foreground.ToInt64().ToString(); title = $title.ToString() } }
}

function Assert-InteractiveDesktop {
    $facts = Get-DesktopFacts
    if (-not $facts.ready) {
        throw "desktop not interactive (locked / secure desktop / UAC): $($facts | ConvertTo-Json -Compress -Depth 4)"
    }
}

function Read-DesktopSharedText([string]$path) {
    $stream = [IO.File]::Open($path, 'Open', 'Read', 'ReadWrite, Delete')
    try { (New-Object IO.StreamReader($stream)).ReadToEnd() } finally { $stream.Dispose() }
}

function Assert-CaptureDesktop($before) {
    $after = Get-DesktopFacts
    if (-not $before.ready -or -not $after.ready -or $before.left -ne $after.left -or $before.top -ne $after.top -or
        $before.width -ne $after.width -or $before.height -ne $after.height) {
        throw 'desktop not interactive (locked / secure desktop / UAC), or display bounds changed during capture; retry on a stable desktop'
    }
}
