# Behavior collection for `sbx detonate`, run inside the sandbox through the agent's exec (elevated).
#   -Arm      turn on process-creation auditing (with command lines), WFP connection auditing and the DNS client log;
#             prints the guest time to collect from.
#   -Since    print JSON: processes started, connections attempted and DNS names looked up since that guest time.
param([switch]$Arm, [string]$Since, [int]$MaxEvents = 5000)
$ErrorActionPreference = 'Stop'

if ($Arm) {
    # Subcategory GUIDs, because the names are localized: Process Creation, Filtering Platform Connection.
    auditpol.exe /set /subcategory:"{0CCE922B-69AE-11D9-BED3-505054503030}" /success:enable | Out-Null
    auditpol.exe /set /subcategory:"{0CCE9226-69AE-11D9-BED3-505054503030}" /success:enable /failure:enable | Out-Null
    $k = 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Policies\System\Audit'
    New-Item -Path $k -Force | Out-Null
    Set-ItemProperty -Path $k -Name ProcessCreationIncludeCmdLine_Enabled -Value 1 -Type DWord
    wevtutil.exe sl Microsoft-Windows-DNS-Client/Operational /e:true /q:true
    Start-Sleep -Milliseconds 500
    (Get-Date).ToString('o')
    return
}

$t0 = [datetime]::Parse($Since)
function EventData($e) {
    $d = @{}
    foreach ($x in ([xml]$e.ToXml()).Event.EventData.Data) { $d[$x.Name] = [string]$x.'#text' }
    $d
}
function Events($filter) {
    try { @(Get-WinEvent -FilterHashtable $filter -MaxEvents $MaxEvents -ErrorAction Stop) } catch { @() }
}
function Num([string]$s) { if ($s -match '^0x') { [Convert]::ToInt64($s.Substring(2), 16) } elseif ($s) { [int64]$s } else { 0 } }

$procs = foreach ($e in Events @{ LogName = 'Security'; Id = 4688; StartTime = $t0 }) {
    $d = EventData $e
    [pscustomobject]@{
        time = $e.TimeCreated.ToString('o'); pid = Num $d.NewProcessId; ppid = Num $d.ProcessId
        path = $d.NewProcessName; commandLine = $d.CommandLine; parentPath = $d.ParentProcessName; user = $d.SubjectUserName
    }
}

# 5156 = allowed, 5157 = blocked. Outbound only (%%14593); the agent's own inbound traffic is not interesting.
$conns = foreach ($e in Events @{ LogName = 'Security'; Id = 5156, 5157; StartTime = $t0 }) {
    $d = EventData $e
    if ($d.Direction -ne '%%14593' -or $d.DestAddress -match '^(127\.|::1$|0\.0\.0\.0$)') { continue }
    [pscustomobject]@{
        time = $e.TimeCreated.ToString('o'); pid = Num $d.ProcessID; blocked = ($e.Id -eq 5157)
        path = ($d.Application -replace '^\\device\\harddiskvolume\d+', 'C:'); address = $d.DestAddress; port = [int]$d.DestPort
        protocol = @{ '6' = 'TCP'; '17' = 'UDP'; '1' = 'ICMP' }[$d.Protocol]
    }
}

# 3006 = query issued, 3008 = query finished; both are logged in the calling process, so ProcessId is the real caller.
$dns = foreach ($e in Events @{ LogName = 'Microsoft-Windows-DNS-Client/Operational'; Id = 3006, 3008; StartTime = $t0 }) {
    $d = EventData $e
    if (-not $d.QueryName) { continue }
    [pscustomobject]@{ time = $e.TimeCreated.ToString('o'); pid = [int64]$e.ProcessId; name = $d.QueryName; status = $d.QueryStatus }
}

$alive = @(Get-Process | ForEach-Object { $_.Id })
ConvertTo-Json -Depth 4 -Compress @{ processes = @($procs); connections = @($conns); dns = @($dns); alive = $alive; now = (Get-Date).ToString('o') }
