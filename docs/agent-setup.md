# Set up Windows Sandbox MCP for a user

These are instructions for an AI agent, not permission to elevate, restart Windows, replace another server,
close someone else's Sandbox or change organizational policy. Do the work with the user's existing tools.
Stop and explain a blocked prerequisite rather than silently treating it as configured.

## 1. Choose the right build and MCP destination

Confirm which **client, harness and configuration scope** you are running in. Do not infer `.vscode\mcp.json`
just because the editor is VS Code: modern Copilot sessions can use **Copilot Global**.

- **Normal install:** use the latest public stable release. Version 1.2.0 includes recording, deployment,
  dependency diagnosis, explicit provisioning and package activation. Freeze the resolved release/version
  before download; do not silently substitute an older release when a requested version is unavailable.
- **Developer build only:** a successful manual `Release` workflow artifact is an optional preview, not a
  stable release. Use it only when the user explicitly requests preview/development source; see step 3's
  optional developer block. GitHub artifact downloads require an authorized GitHub account.
- **Matching source:** clone with `git clone https://github.com/shanselman/sandbox-mcp`,
  verify the intended tag/commit, then `npm ci --omit=dev` and
  `npm run package:win` on Windows x64 with Node 20+. Prefer the portable artifact so the user needs no Node install.

Do not read credentials or unrelated client configuration. Never add keys, secrets or a transport token.

## 2. Check Windows before making system changes

Run read-only checks: Windows edition/build, CPU architecture, RAM and virtualization/hypervisor state.
This package requires Windows x64, Windows 11 24H2/build 26100 or newer, Pro/Enterprise/Education,
hardware virtualization enabled in UEFI/BIOS, at least 4 GB RAM (8 GB recommended), two CPU cores,
and 1 GB free disk. Home and Windows Server are not supported. A VM needs nested virtualization.

The definitive project check is `sbx doctor --json` after extraction. A failed optional probe is **unknown**,
not a reason to claim the machine is ready. Preserve and explain the facts and failed checks.

If Sandbox is disabled, **show this command and ask before running anything elevated**:

```powershell
# The user runs this in Administrator PowerShell after approving the change.
Enable-WindowsOptionalFeature -Online -FeatureName Containers-DisposableClientVM -All
```

Explain that a restart is required; never silently elevate or reboot. Resume only after the user restarts.
Have the user open Windows Sandbox from Start once, allow its normal update, then close **that** window.
This installs the Store Sandbox's `wsb.exe` alias. Do not close another workflow's guest. Re-run `doctor`;
if `wsb` is missing, check `%LOCALAPPDATA%\Microsoft\WindowsApps` and the app execution alias, not a fake fallback.

## 3. Download, verify and extract to a stable per-user path

Only use `shanselman/sandbox-mcp` GitHub release/workflow assets. Do not execute an unverified archive.
Resolve a version once so "latest" cannot change between metadata, checksum and download.

For a **stable** install, this PowerShell block uses GitHub's asset SHA256 digest (or its published checksum
asset), compares the actual ZIP and extracts into `%LOCALAPPDATA%\sandbox-mcp\releases\<tag>`.
It fails closed when no SHA256 is available. Tell the user which version they got.

<!-- setup-test: download-stable -->
```powershell
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Utility') -Force
Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Archive') -Force
$release = Invoke-RestMethod 'https://api.github.com/repos/shanselman/sandbox-mcp/releases/latest'
$asset = @($release.assets | Where-Object name -eq "sandbox-mcp-win-x64-$($release.tag_name).zip")
if ($asset.Count -ne 1) { throw 'No unique Windows x64 portable ZIP in this release.' }
$asset = $asset[0]
$expected = if ($asset.digest -match '^sha256:([a-fA-F0-9]{64})$') { $Matches[1] } else { $null }
$staging = Join-Path $env:TEMP ("sandbox-mcp-download-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $staging | Out-Null
$zip = Join-Path $staging $asset.name
Invoke-WebRequest -UseBasicParsing $asset.browser_download_url -OutFile $zip
if (-not $expected) {
    $checksum = @($release.assets | Where-Object name -eq "$($asset.name).sha256")
    if ($checksum.Count -ne 1) { throw 'No published SHA256; retain the ZIP, do not run it.' }
    $text = (Invoke-WebRequest -UseBasicParsing $checksum[0].browser_download_url).Content
    if ($text -notmatch '^([a-fA-F0-9]{64})  ([^\r\n]+)\r?\n?$' -or $Matches[2] -ne $asset.name) {
        throw 'Invalid published checksum filename/format.'
    }
    $expected = $Matches[1]
}
if ((Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash -ne $expected) { throw 'ZIP SHA256 mismatch.' }
$Install = Join-Path $env:LOCALAPPDATA "sandbox-mcp\releases\$($release.tag_name)"
if (Test-Path -LiteralPath $Install) { throw "Already installed at $Install; verify/reuse it, do not overwrite." }
Expand-Archive -LiteralPath $zip -DestinationPath $Install
$package = Get-Content -LiteralPath (Join-Path $Install 'package.json') -Raw | ConvertFrom-Json
if ("v$($package.version)" -ne $release.tag_name) { throw 'Release package version mismatch; do not run it.' }
if ([version]$package.version -ge [version]'1.2.0') {
    $info = Get-Content -LiteralPath (Join-Path $Install 'BUILD-INFO.txt') -Raw
    if ($info -notmatch '(?m)^Source commit: ([a-f0-9]{40})\r?$' -or $info -notmatch '(?m)^Build channel: release\r?$') {
        throw 'Missing release source/channel provenance; do not run it.'
    }
    Write-Output $info
}
Write-Output "Verified $($release.tag_name) at $Install; SHA256 $expected"
& (Join-Path $Install 'sbx.cmd') doctor --json
if ($LASTEXITCODE -notin @(0, 1)) { throw 'doctor failed to return a readiness result.' }
```

### Optional developer preview (not the normal installation)

For an explicitly requested **developer preview**, discover the newest successful manual build of the named branch, not `releases/latest`.
If the newest branch commit has no successful build, report that the selected artifact represents an older
commit; do not promise it contains unbuilt changes. This freezes the selected run and verifies the actual
ZIP, filename, source commit and channel. Missing/expired artifacts are a visible failure.

<!-- setup-test: download-candidate -->
```powershell
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Utility') -Force
Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Archive') -Force
$runs = gh run list --repo shanselman/sandbox-mcp --workflow release.yml `
    --branch shanselman-sandbox-feature-integration --event workflow_dispatch --status success `
    --limit 1 --json databaseId,headSha,url | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or @($runs).Count -ne 1) { throw 'No accessible successful candidate build; do not substitute stable.' }
$run = @($runs)[0]
if ($run.headSha -notmatch '^[a-f0-9]{40}$') { throw 'Invalid candidate source commit.' }
$staging = Join-Path $env:TEMP ("sandbox-mcp-candidate-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $staging | Out-Null
gh run download $run.databaseId --repo shanselman/sandbox-mcp --name sandbox-mcp-win-x64 --dir $staging
if ($LASTEXITCODE -ne 0) { throw 'Candidate artifact missing, expired or inaccessible.' }
$zips = @(Get-ChildItem -LiteralPath $staging -Filter '*.zip' -File)
if ($zips.Count -ne 1) { throw 'Expected exactly one candidate ZIP.' }
$zip = $zips[0]
$expectedName = "sandbox-mcp-feature-preview-1.2.0-$($run.headSha.Substring(0,7))-win-x64.zip"
if ($zip.Name -ne $expectedName) { throw 'Candidate ZIP name does not match selected source/version.' }
$checksum = Get-Content -LiteralPath "$($zip.FullName).sha256" -Raw
if ($checksum -notmatch '^([a-fA-F0-9]{64})  ([^\r\n]+)\r?\n?$' -or $Matches[2] -ne $zip.Name) {
    throw 'Candidate checksum name/format mismatch.'
}
$expected = $Matches[1]
if ((Get-FileHash -LiteralPath $zip.FullName -Algorithm SHA256).Hash -ne $expected) { throw 'Candidate ZIP SHA256 mismatch.' }
$Install = Join-Path $env:LOCALAPPDATA "sandbox-mcp\candidates\$($run.headSha)"
if (Test-Path -LiteralPath $Install) { throw "Already installed at $Install; verify/reuse it, do not overwrite." }
Expand-Archive -LiteralPath $zip.FullName -DestinationPath $Install
$info = Get-Content -LiteralPath (Join-Path $Install 'BUILD-INFO.txt') -Raw
if ($info -notmatch "(?m)^Source commit: $($run.headSha)\r?$" -or $info -notmatch '(?m)^Build channel: feature-preview\r?$') {
    throw 'Candidate source/channel mismatch; do not run it.'
}
Write-Output "Verified candidate $($run.headSha) from $($run.url); SHA256 $expected at $Install"
& (Join-Path $Install 'sbx.cmd') version
if ($LASTEXITCODE -ne 0) { throw 'Candidate runtime failed.' }
& (Join-Path $Install 'sbx.cmd') doctor --json
if ($LASTEXITCODE -notin @(0, 1)) { throw 'doctor failed to return a readiness result.' }
```

Checksums verify artifact bytes, not a signed publisher attestation; the GitHub repository/run identity
still matters. Preserve the selected run URL, full SHA and checksum in the setup summary.

## 4. Register without clobbering existing configuration

Review the absolute `node.exe` and `src\server.js` paths. The portable server uses its private Node runtime;
do not rely on a GUI client's PATH. Configuration is per client, not one universal JSON format.

| Destination | File / documented registration |
|---|---|
| Copilot CLI or modern VS Code **Copilot Global** | `$COPILOT_HOME\mcp-config.json`, otherwise `%USERPROFILE%\.copilot\mcp-config.json`; top-level `mcpServers`. Prefer `copilot mcp add windows-sandbox -- <absolute-node.exe> <absolute-server.js>` when supported. |
| VS Code **Local harness**, workspace scope | `.vscode\mcp.json`; top-level `servers`, `type: "stdio"`. This is the compatibility/local format, not automatically the right destination for every VS Code session. |
| Claude Desktop | `%APPDATA%\Claude\claude_desktop_config.json`; `mcpServers`, command/args, no `type` or `tools`. |

Before a client command, back up its existing config with a timestamp/GUID suffix. If `windows-sandbox`
already exists, compare it; reuse an identical registration, or ask before replacing different paths.
Respect organization policies and server-trust prompts; do not bypass them.

For a JSON-file destination, the following function merges **one entry**, preserves other servers and
top-level settings, refuses to replace a different registration, and backs up an existing file. It works
with Windows PowerShell 5.1 as well as PowerShell 7. A commented/JSONC file should be edited with the client's
native JSONC-aware configuration command instead; do not strip its comments or rewrite it as plain JSON.

<!-- setup-test: merge-config -->
```powershell
function Merge-SandboxMcpConfig {
    param([string]$ConfigPath, [string]$Install, [ValidateSet('copilot-global', 'vscode-local', 'claude')][string]$Client)
    $ErrorActionPreference = 'Stop'
    $node = Join-Path $Install 'node.exe'
    $server = Join-Path $Install 'src\server.js'
    if (-not (Test-Path $node -PathType Leaf) -or -not (Test-Path $server -PathType Leaf)) {
        throw 'The verified portable runtime/server is missing.'
    }
    $key = if ($Client -eq 'vscode-local') { 'servers' } else { 'mcpServers' }
    $entry = [ordered]@{ command = $node; args = @($server) }
    if ($Client -ne 'claude') { $entry.type = 'stdio' }
    if ($Client -eq 'copilot-global') { $entry.tools = @('*') }
    $desired = [pscustomobject]$entry
    $exists = Test-Path -LiteralPath $ConfigPath
    $raw = if ($exists) { Get-Content -LiteralPath $ConfigPath -Raw } else { '{}' }
    $tokens = [regex]::Matches($raw, '"(?:\\.|[^"\\])*"|//[^\r\n]*|/\*[\s\S]*?\*/')
    if (@($tokens | Where-Object { $_.Value.StartsWith('//') -or $_.Value.StartsWith('/*') }).Count) {
        throw 'JSONC/comments detected; use the client configuration editor instead.'
    }
    if (-not $raw.TrimStart().StartsWith('{')) { throw 'Expected a JSON configuration object.' }
    $config = $raw | ConvertFrom-Json
    # Windows PowerShell wraps scalar JSON in PSObject too; require its underlying custom-object type.
    if ($null -eq $config -or $config.GetType() -ne [System.Management.Automation.PSCustomObject]) { throw 'Expected a JSON configuration object.' }
    if (-not $config.PSObject.Properties[$key]) { $config | Add-Member NoteProperty $key ([pscustomobject]@{}) }
    $servers = $config.$key
    if ($null -eq $servers -or $servers.GetType() -ne [System.Management.Automation.PSCustomObject]) { throw 'Expected a server configuration object.' }
    if ($servers.PSObject.Properties['windows-sandbox']) {
        $current = $servers.'windows-sandbox'
        if (($current | ConvertTo-Json -Depth 30 -Compress) -eq ($desired | ConvertTo-Json -Depth 30 -Compress)) {
            Write-Output 'Identical registration already exists.'; return
        }
        throw 'A different windows-sandbox registration exists; ask before replacing it.'
    }
    $servers | Add-Member NoteProperty 'windows-sandbox' $desired
    $parent = Split-Path -Parent $ConfigPath
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
    if ($exists) {
        $backup = "$ConfigPath.backup-$([DateTime]::UtcNow.ToString('yyyyMMddTHHmmss'))-$([guid]::NewGuid().ToString('N'))"
        Copy-Item -LiteralPath $ConfigPath -Destination $backup
    }
    $text = $config | ConvertTo-Json -Depth 100
    [IO.File]::WriteAllText($ConfigPath, $text, [Text.UTF8Encoding]::new($false))
    Write-Output "Registered windows-sandbox in $ConfigPath"
}
```

Call it with the **discovered** client/scope and verified `$Install`; do not copy another client's config.
For example, `Merge-SandboxMcpConfig -ConfigPath <absolute-config-path> -Install $Install -Client copilot-global`.
If using `copilot mcp add`, first check `copilot mcp add --help`; honor `COPILOT_HOME`. Back up the file first
and verify that unrelated entries are unchanged afterward.

## 5. Prove a tool works, not just that JSON exists

Tell the user to reload/restart the client or reconnect this server, and approve the client server-trust prompt.
From the intended client, call `sandbox_status`: require a real structured tool result, not merely a registration
or tools-list success. If another guest is running, report it and do not stop it.

When the singleton Sandbox slot is free and `doctor` is ready, run a harmless offline smoke:

```powershell
& (Join-Path $Install 'sbx.cmd') run C:\Windows\System32\charmap.exe --network off
```

For an MCP-enabled agent, perform the same via `sandbox_run` with
`app: "C:\\Windows\\System32\\charmap.exe"` and `network: "off"`. Require `pass: true`, a screenshot
and an existing `out\report.md`; confirm `wsb list --raw` is empty after **your** guest's teardown.
Do not claim a tool was usable in the user's current session if it needs a reload you cannot perform.

Reports survive under `%LOCALAPPDATA%\sandbox-mcp\runs\<timestamp>\out` (or `SANDBOX_MCP_HOME`).
Do not automatically install ffmpeg or app runtimes. Version 1.2.0 supports `record: true`, dependency diagnosis
and explicit provisioning; a smoke test against an older version does not prove those additions.

Summarize: exact version/commit, checksum, install path, config destination and backup, first real tool result,
smoke report/screenshot, remaining readiness/reload steps. Never say an admin/restart step happened unless it did.

## Client references

- [Copilot CLI MCP registration](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers)
- [VS Code harness and MCP destination selection](https://code.visualstudio.com/docs/agent-customization/mcp-servers)
- [Claude Desktop local server configuration](https://modelcontextprotocol.io/docs/develop/connect-local-servers)
