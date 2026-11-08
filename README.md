# sandbox-mcp

## Give your AI agent a brand-new Windows PC. Then throw it away.

Not your desktop. Not a container pretending to be Windows. **A real, disposable Windows 11 machine**:
boot it, deploy your app, drive the controls, catch the crash, keep the evidence, delete the PC.
One MCP tool call or `sbx run`. The measured GUI samples take roughly **40-50 seconds** end to end.

![Real offline Sandbox: Haptics app UI Automation, light-to-dark theme, app exit and guest teardown](docs/sandbox-teaser.gif)

*Real app, real guest: Haptics Everywhere's self-contained WPF/WinForms desktop app in a fresh, network-off Sandbox.
UIA selects the Inspector, the guest switches light to dark, the app relaunches and exits, then the guest is destroyed.
10-second, 183 KB edited footage: light Inspector slowed for readability, repeated dark frames trimmed.
Boot/teardown title cards summarize actual logs, not filmed boot/shutdown.
No guest runtime installation or haptic-hardware claim. [Fresh dark lab screenshot](docs/haptics-teaser.png) ·
[Earlier light-theme inspector](docs/haptics-inspector.png).*

### 🤖 Let your agent set it up

Give this to your bot. It checks the PC, verifies the download, preserves your MCP configuration and asks before
admin changes or a restart:

```text
Set up Windows Sandbox MCP by following:
https://raw.githubusercontent.com/shanselman/sandbox-mcp/main/docs/agent-setup.md
Install the latest verified release; ask before admin changes or a restart.
```

**[Download v1.2.0](https://github.com/shanselman/sandbox-mcp/releases/tag/v1.2.0)**: portable CLI + MCP server,
bundled Node.js, guest agent and setup instructions. No Node/npm installation needed.

### “Works on my machine.” Caught in 30 seconds.

The dev box had Visual C++ installed. The fresh, **network-off** customer PC did not:

```text
FAIL  NativeProof.exe on a fresh Windows Sandbox (29.8s)
  why      exited with code -1073741515; Missing dependency: VC++ redistributable.
```

Opt in to the verified runtime install, then repeat on another fresh guest:

```text
PASS  NativeProof.exe on a fresh Windows Sandbox (30.9s)
  baseline PROVISIONED (not a clean-machine pass): VC++ redistributable  x64
  process  exited with code 0
```

Those are [actual measured results](docs/compatibility.md#combined-feature-verification), not illustrative output.
The installer was Microsoft-signed **14.51.36247.0**, downloaded and verified on the host. Guest networking stayed
off. `sbx deps app.exe` diagnoses; `sbx run app.exe --provision auto` installs **only when explicitly requested**.

### What your agent gets

| A clean customer PC | A real desktop to drive | Evidence that survives |
|---|---|---|
| Fresh on every boot; no implicit app-runtime installs | Native UIA: inspect, type, click, toggle, wait | PNGs, bounded recordings, self-contained HTML, optional MP4 |
| Dependency diagnosis; explicit verified provisioning | WinUI, WPF, WinForms, Win32; MSIX/AUMID activation | Process state, exit codes, crash events, reports |
| Network **off / firewall / on** | CLI + MCP share state; verified warm incremental deploy | Installer/uninstaller diffs; detonation observations |

Same clean-machine loop, different frameworks:

| WinUI 3, packaged | WPF, self-contained | Native Win32, packaged |
|---|---|---|
| ![WinUI greeting and counter after final integrated MCP test](docs/integration-winui-msix.png) | ![WPF greeting after final integrated UIA test](docs/integration-wpf.png) | ![Native Win32 greeting after UIA](docs/compatibility/native-msix.png) |

These are real offline-guest screenshots, not host mockups. WinUI/WPF were refreshed against the final integrated
source; the full matrix covers seven configurations. Exact builds, timings, startup defects
found and remaining coverage gaps are in the [compatibility evidence](docs/compatibility.md).

[Download/setup](#download-and-try-it-no-nodejs-install) · [Agent setup guide](docs/agent-setup.md) ·
[Measured compatibility and honest limits](docs/compatibility.md) · [MCP tools](#mcp-tools)

<details>
<summary>See a fresh, recorded UI Automation session</summary>

![UI Automation changes real WinUI controls inside a network-off Sandbox](docs/sandbox-in-action.gif)

This 138 KB animation comes from a new 74-frame guest recording: UIA changes the text, invokes buttons and
increments the counter. The guest was stopped afterward; the HTML viewer, MP4 and frames remained on the host.
No synthetic screenshots. This small fixture proves the automation path; the rich app above shows the real-app use case.

</details>

## Why

**A Windows Sandbox showcase, not a framework gate.** WinUI 3 is welcome, but the entry point is a Windows
executable or package, not a particular UI framework. Bring an app that can run in Sandbox and its prerequisites:
Win32, WinForms, WPF, WinUI, console, PyInstaller or Electron builds use the same clean-machine workflow.
Installers and untrusted files have their own audit/detonation workflows. This is not a promise that every
Windows app or hardware-dependent workload works in Sandbox. See the [measured compatibility matrix](docs/compatibility.md)
and [small source samples](samples/README.md) in this matching checkout for the configurations actually exercised.

[winapp CLI's Sandbox execution](https://github.com/microsoft/winappCli/blob/5f379fb55517b7a47f9aad11885a7c1676dcca2e/docs/sandbox-execution.md)
also supports packaged and unpackaged apps: its `--on sandbox` offers a warm, identity-aware developer loop,
runtime preparation and WinUI diagnostics. sandbox-mcp emphasizes **fresh-by-default clean-machine reports**,
network-off shared-folder mailbox transport, installer/uninstaller diffs and detonation. The tools have
overlapping app support but different defaults and goals; sandbox-mcp never implicitly installs app prerequisites.
Inbox Framework/CBS components can exist, but are not proof that an app's requested runtime is available.

"It works on my machine" is usually true: your machine has every runtime, SDK, redistributable, font, registry key
and PATH entry you ever installed. Your users' machines don't. Windows Sandbox is a pristine Windows that boots in
seconds and is **deleted** when it closes, which makes it the perfect "brand-new customer PC". Its supported `wsb`
CLI provides automation; sandbox-mcp adds orchestrated app deployment, UI Automation, clean-machine checks and
durable test evidence around it.

|                              | sandbox-mcp (Windows Sandbox)       | Hyper-V / VMware VM        | Windows containers           | Cloud dev VMs (devvm, Codespaces, Dev Box) |
|------------------------------|-------------------------------------|----------------------------|------------------------------|--------------------------------------------|
| Real Windows desktop + GUI   | ✅                                  | ✅                         | ❌ no desktop                 | Linux mostly / ✅ (Dev Box)                 |
| Clean state every run        | ✅ always, by design                | snapshots to manage        | ✅                            | ❌ persistent                               |
| Startup                      | ~15 s                               | minutes                    | seconds                      | minutes                                    |
| Images to build or download  | none (uses your installed Windows)  | a 20+ GB VHD               | multi-GB base images         | none, but it's someone else's computer     |
| Cost                         | free with Windows Pro/Enterprise    | free-ish + disk            | free                         | 💸                                          |
| Runs offline / local         | ✅                                  | ✅                         | ✅                            | ❌                                          |
| Parallel instances           | ❌ one at a time                    | ✅                         | ✅                            | ✅                                          |
| Persistent environment       | ❌                                  | ✅                         | via volumes                  | ✅                                          |

If you need many machines, persistence, or Linux, use a VM or a cloud box. If you want to know *"does my Windows app
install, launch and work on a clean PC, and what does it look like?"* as quickly and cheaply as possible, this is it.

## What you can do

`sbx deps <app.exe|folder>` (MCP: `sandbox_deps`) inspects dependencies on the host without running or installing
anything: PE architecture/imports, app-local VC++ DLLs, .NET runtime configs, .NET Framework configs, package
dependencies and script interpreters. `sbx run` includes this diagnosis in its report and names likely missing
runtimes after a failed launch. This is a conservative static scan, not proof that every dynamic dependency is
present. Optional guest components such as WebView2 must be checked in the actual guest.

The default never installs dependencies. To **explicitly opt in**, use `sbx run <app> --provision auto`
(`sandbox_run` parameter `provision: "auto"`), or specify a comma-separated list such as
`--provision desktop:10.0:x64,vcredist:x64`. Supported components: `dotnet:<version>:<arch>`,
`desktop:<version>:<arch>`, `aspnetcore:<version>:<arch>`, `vcredist:<arch>` and
`windows-app-runtime:<major.minor>:<arch>`. Architecture is `x86`, `x64` or `arm64` (explicit lists default
to x64). `sbx provision <host app path> --provision <auto|list>` / `sandbox_provision` does the same in
an already-started sandbox; it never starts or adopts a guest. Unknown versions/architectures or unsupported
auto-provision requests fail explicitly; Java and Python require application-specific setup.

Downloads happen on the **host**, are cached under the sandbox-mcp home `cache\redistributables` folder,
verified with published SHA-512 hashes for .NET and a valid Microsoft Authenticode signature for every
installer, then copied in and installed silently. Guest networking can stay **off**. A cached installer
is reverified before reuse; remove its specific cache file to refresh a mutable VC++/Windows App Runtime
download. Reports record the requested provisioning, completed installs, source and verification details
and say **PROVISIONED (not a clean-machine test)**. A provisioned pass never means the original clean machine
had those runtimes. .NET resolution conservatively stays within the requested major/minor channel and
honors exact-version requests (`rollForward: Disable` / `applyPatches: false`) rather than silently changing
the app configuration. A reboot-required installer result fails the run.
Step-by-step provisioning also writes `provisioning.json` in the run folder and marks `sbx status` /
`sandbox_status`, so switching clients does not lose the non-clean-machine provenance. This records explicit
provisioning only, not arbitrary installers a user runs with `exec`. For a live regression, publish a small
framework-dependent .NET desktop app and run `node test\deps-offline.js <publish folder>` with exclusive use
of Windows Sandbox. The observed optional-component baseline for build 26100.9882 is recorded in
`test\fixtures\sandbox-26100.9882.json`; it is evidence for that build, not a promise about future guest images.

- **Clean-machine smoke tests:** does the exe even start without the VC++ runtime / .NET runtime / WebView2 you
  forgot to bundle? `sbx run` tells you, with a screenshot and the crash events.
- **Test installers and uninstallers:** `sbx install-test setup.msi` installs on a clean machine, uninstalls, and
  reports every file, registry key, service, scheduled task and autorun the installer added and the uninstaller
  forgot. Hung installers waiting on a hidden dialog get screenshotted instead of hanging your CI.
- **Drive the UI with UI Automation, not pixels:** read the control tree (`Button "Save" #SaveButton {invoke}`),
  set text, click, toggle, select, wait for results. Works for WinForms, WPF, Win32 and WinUI apps, and things like
  File Explorer. Screenshots, mouse and keyboard are there for everything else.
- **Let an agent close the loop:** "build it, test it on a clean machine, look at the screenshot, fix it, repeat",
  without the agent touching your real desktop.
- **Run things with no network at all:** `--network off` boots the sandbox with no network adapter. Control still
  works (through a shared folder), so you can watch an app's offline behavior or open something you don't trust.
- **See what a file you don't trust actually does:** `sbx detonate invoice.js` runs it in a sandbox with no network
  and reports every process it started (with command lines), the names it looked up, the addresses it tried, and the
  autoruns, scheduled tasks, services and files it planted. Then the whole machine is deleted.
- **Collect evidence:** every run keeps screenshots, copied-out files, a markdown report and an audit log on the
  host after the sandbox is gone.

## Download and try it (no Node.js install)

Download the **Windows x64 portable ZIP** from the [latest GitHub release](https://github.com/shanselman/sandbox-mcp/releases/latest)
and extract it. The ZIP includes `sbx`, the MCP server, their dependencies, the guest agent and skill, and a private
Node.js runtime. You do not need to clone the repo, install Node/npm, or add anything to PATH.
The package is built and tested on native Windows x64; ARM64 is not currently packaged.

Verify the ZIP against its adjacent `.sha256` file before extracting; the [agent setup guide](docs/agent-setup.md)
does that automatically and preserves existing client configuration.

Open PowerShell in the extracted folder and start with the read-only readiness check:

```powershell
.\sbx.cmd doctor
```

`doctor` explains what is missing and how to fix it. It never enables Windows features, elevates, changes PATH, or
restarts the PC for you. Windows Sandbox is only available on Windows Pro, Enterprise or Education; Windows Home
and Windows Server cannot run it.

If the Sandbox feature is off, open **an administrator PowerShell**, run the command below, then restart Windows:

```powershell
Enable-WindowsOptionalFeature -Online -FeatureName Containers-DisposableClientVM -All
```

After restarting, open **Windows Sandbox from the Start menu once**, then close it. This updates Sandbox and installs
the `wsb` command-line tool that `sbx` uses. Run the check again and try a built-in Windows app:

```powershell
.\sbx.cmd doctor
.\sbx.cmd run C:\Windows\System32\charmap.exe --open
```

A passing run leaves `report.md`, `report.json`, screenshots and `audit.jsonl` under
`%LOCALAPPDATA%\sandbox-mcp\runs\<timestamp>` (`out` contains the report and media), even after teardown.
`--open` opens the report. Add `--record` for a self-contained viewer under
`out\recordings\<recordingId>\recording.html` and MP4 when host ffmpeg is available. `SANDBOX_MCP_HOME`
changes the artifact root. No ffmpeg or app runtime is silently installed.

For an MCP client, configure its stdio server with the full paths to the bundled runtime and server. Replace the
example folder with the location where you extracted the ZIP:

```json
{
  "servers": {
    "windows-sandbox": {
      "type": "stdio",
      "command": "C:\\Users\\you\\Downloads\\sandbox-mcp\\node.exe",
      "args": ["C:\\Users\\you\\Downloads\\sandbox-mcp\\src\\server.js"]
    }
  }
}
```

That is the VS Code `.vscode\mcp.json` shape. For GitHub Copilot CLI's
`%USERPROFILE%\.copilot\mcp-config.json`, use:

```json
{
  "mcpServers": {
    "windows-sandbox": {
      "type": "local",
      "command": "C:\\Users\\you\\Downloads\\sandbox-mcp\\node.exe",
      "args": ["C:\\Users\\you\\Downloads\\sandbox-mcp\\src\\server.js"],
      "tools": ["*"]
    }
  }
}
```

For Claude Desktop, use `"mcpServers"` with the same command/args and omit `type` and `tools`.
Restart or reload the client's server configuration, then ask it to run Character Map in a fresh offline Sandbox
and return the report and screenshot. The server writes logs to stderr; stdout is reserved for MCP messages.

## Turn on Windows Sandbox

If you have Windows Pro, Enterprise or Education, you already own one of the best tools in Windows and it's probably
switched off. [Windows Sandbox](https://learn.microsoft.com/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-overview)
is a whole, real Windows desktop that:

- **comes with Windows:** nothing to download, no VHD, no license key. It's built from the Windows you're running.
- **is brand new every time:** it boots as clean as the day Windows was installed, in about 15 seconds.
- **is thrown away when you close it:** guest files, registry keys and installed apps are deleted.
  Explicitly shared output folders remain on the host as test evidence.
- **is properly isolated:** it runs on its own kernel behind the Microsoft hypervisor (the same hardware
  virtualization as Hyper-V), not just a separate user account.
- **is light:** it shares memory and files with your PC where it safely can, and uses your GPU.

Turn it on with one line in an **admin** PowerShell, then restart:

```powershell
Enable-WindowsOptionalFeature -Online -FeatureName Containers-DisposableClientVM -All
```

(Or *Turn Windows features on or off* > tick *Windows Sandbox*.) After the restart, **open Windows Sandbox from the
Start menu once**. That updates it to the Store version, which includes the `wsb` command-line tool this project
drives. Then check everything with:

```powershell
sbx doctor
```

```text
✅ Windows 11 Pro, build 26100
✅ Windows Sandbox feature is on
✅ Virtualization is on
✅ wsb command-line tool: C:\Users\you\AppData\Local\Microsoft\WindowsApps\wsb.exe (Windows Sandbox 0.8.107.0)
✅ Node.js 22.11.0

Ready. Try: sbx run C:\Windows\System32\charmap.exe --open
```

If something's missing, `sbx doctor` says what and how to fix it, and every other command tells you the same thing
if it can't reach Windows Sandbox. The full list of what you need:

- Windows 11 24H2 (build 26100) or later, Pro / Enterprise / Education. Windows Sandbox isn't available on Home or Windows Server.
- Virtualization turned on in your PC's UEFI/BIOS (Intel VT-x or AMD-V). Most PCs ship with it on.
- At least 4 GB of RAM (8 GB recommended), 2 CPU cores and 1 GB of free disk.
- Running inside a VM? Turn on nested virtualization on the host first:
  `Set-VMProcessor -VMName <name> -ExposeVirtualizationExtensions $true`.
- The portable ZIP bundles Node.js for Windows x64. If installing from source, use Node.js 20+ (`winget install OpenJS.NodeJS.LTS`).

## Install from source

The clone command below retrieves the public default branch. Check out `v1.2.0` to reproduce that release's
source and WinUI/WPF samples exactly. Samples are not included in the portable ZIP.

```powershell
git clone https://github.com/shanselman/sandbox-mcp
cd sandbox-mcp
npm ci --omit=dev
npm link            # puts `sbx` and `sandbox-mcp` on your PATH (or use `node src/cli.js`)

sbx doctor                                         # is Windows Sandbox ready? (see above)
sbx run C:\Windows\System32\charmap.exe --open     # try it on something that exists everywhere
```

Try the included sample (needs nothing but Windows; it compiles with the .NET Framework's `csc.exe`):

```powershell
.\samples\HelloSandbox\build.ps1
sbx run .\samples\HelloSandbox\bin --test .\samples\HelloSandbox\test.ps1   # passes
sbx run .\samples\HelloSandbox\bin --args --crash                            # fails, and shows the crash
sbx install-test .\samples\LeakyApp\install.ps1                              # an installer whose uninstaller forgets things
sbx detonate .\samples\Suspicious\suspicious.ps1                             # a harmless script that acts like malware
```

### Use it from an agent (MCP)

For source installs, use the same client-specific shapes above, replacing the bundled command with your
installed Node executable. For example, VS Code (`.vscode\mcp.json`):

```json
{
  "servers": {
    "windows-sandbox": {
      "type": "stdio",
      "command": "node",
      "args": ["C:\\path\\to\\sandbox-mcp\\src\\server.js"]
    }
  }
}
```

Use the Copilot CLI or Claude shape above for those clients; their top-level keys differ from VS Code.
An absolute Node path avoids differences between your terminal PATH and the MCP client's environment.

Then ask: *"Build the app, run it in a fresh Windows Sandbox, type my name in the box, click Greet and show me a
screenshot."*

There's also an agent skill in [`skills/windows-sandbox-app-test`](skills/windows-sandbox-app-test/SKILL.md) that
teaches agents the workflow; copy it into your agent's skills folder (for example `~/.copilot/skills/`).

## Fast inner loop

Start once, then build and deploy repeatedly into that **warm** sandbox (any framework, no guest prerequisites
installed implicitly):

```powershell
sbx start --network off
powershell -File .\samples\HelloSandbox\build.ps1
sbx deploy .\samples\HelloSandbox\bin C:\apps\HelloSandbox --launch HelloSandbox.exe --restart
sbx shot --window "Hello Sandbox"
# Edit, build, deploy --restart, screenshot again; when done:
sbx stop
```

`deploy` transfers only added/changed files through a fresh shared staging folder, removes deleted files, and verifies
the entire destination using SHA256. Its report includes added/changed/removed/unchanged counts, bytes transferred,
elapsed milliseconds and `verified: true`. `--restart` stops processes whose executable is under the destination before
applying and requires `--launch` to relaunch the app; `--launch` alone launches after verification. Arguments use
`--args "..."`. TCP and network-off shared-folder transport both work.

Use a dedicated destination: **extra guest files there are deleted**. Links, junctions and reparse points are rejected.
If a build changes while staging, deployment fails with `build output changed during deploy; rerun` before touching the
destination. Apply/verification failures restore the previous touched files where possible; rollback failures explicitly
identify the retained guest backup. Stopped processes are not automatically restarted after a failed apply.
`push` / `sandbox_copy_in` still perform a full replacement. `run`, `install-test` and `detonate` still start fresh;
incremental deployment never adopts an unrelated sandbox.

## MCP tools

| Tool | What it does |
|---|---|
| `sandbox_deps` | Host-only conservative dependency diagnosis; does not execute or install the app. |
| `sandbox_provision` | Explicit opt-in verified runtime installation into the current owned guest; persists non-clean provenance. |
| `sandbox_run` | The whole loop in one call: boot, copy/install, launch or run, observe, test script, collect, destroy, report. |
| `sandbox_start` | Boot a fresh sandbox (`network`: on / firewall / off, `memoryMB`, `vGpu`). Waits for the agent and an interactive desktop; reports readiness timings. |
| `sandbox_status` | Is one running, its id/IP/network mode, agent health and current interactive-desktop facts. |
| `sandbox_desktop_release` | End this workflow's desktop turn immediately. |
| `sandbox_stop` | Destroy it. Lists the artifacts left on the host. |
| `sandbox_copy_in` | Copy a host file or folder in (default `C:\apps\<name>`). |
| `sandbox_deploy` | Deploy a host directory into an already running sandbox, transfer only changes and verify hashes; optional launch/restart. |
| `sandbox_copy_out` | Copy a sandbox file or folder out to the run's `out\files`. |
| `sandbox_exec` | Run a PowerShell (or `cmd`) command; returns stdout, stderr, exit code. |
| `sandbox_launch` | Start an EXE or installed package AUMID; returns the app pid and main window. |
| `sandbox_process` | Running? Exit code? Window title? |
| `sandbox_windows` | Visible top-level windows with titles, pids and bounds. |
| `sandbox_screenshot` | PNG of the desktop or one window, returned inline (and saved on the host), with its own `captureId`, bounds and scale. |
| `sandbox_record_start` / `sandbox_record_stop` | Bounded desktop recording: frames stream straight to the host share; stop publishes a self-contained HTML flipbook and MP4 if host ffmpeg is available. |
| `sandbox_click` / `sandbox_type` | Mouse and keyboard, in screenshot coordinates / SendKeys syntax. Click accepts `captureId` (default latest); out-of-image points and moved/resized captured windows are rejected. |
| `sandbox_ui_tree` | The UI Automation tree of a window: type, name, automation id, value, state, supported actions. |
| `sandbox_ui_action` | Find a control by name / automation id / type and click, set a value, toggle, select, expand, read... |
| `sandbox_ui_wait` | Wait for a control (a result, a dialog) to appear. |
| `sandbox_app_errors` | Application event log errors: crashes, hangs, .NET unhandled exceptions. |
| `sandbox_install_test` | The installer loop in one call: snapshot, install, snapshot, optional test, uninstall, snapshot, report what was added and left behind. |
| `sandbox_detonate` | Run an untrusted file (no network by default) and report its processes, lookups, connections, persistence and changes. |
| `sandbox_snapshot` | Record files, registry, services, autoruns and installed programs under a name. |
| `sandbox_diff` | Compare two snapshots: what changed in between. |

## CLI

```text
sbx run <app.exe|folder|app.msix> [--exe <name>] [--args "<args>"] [--console] [--wait <sec>]
                         [--cert <file.cer>] [--deps <folder>] [--app-id <id>]
                         [--record] [--provision <auto|list>]
                         [--test <script.ps1>] [--collect <sandbox path>]... [--keep] [--open]
sbx install-test <setup.msi|.exe|.ps1|.cmd> [--args "/S"] [--uninstall auto|none|"<cmd>"]
                         [--uninstall-args "/S"] [--test <script.ps1>] [--fail-on-leftovers] [--exclude <path>]...
sbx detonate <file> [--args "<args>"] [--network off|firewall|on] [--duration <sec>] [--full] [--every <sec>]

sbx start [--network on|firewall|off] [--memory <MB>] [--no-gpu] [--minimized]
sbx deps <host app path>                   sbx provision <host app path> --provision <auto|list>
sbx desktop-release
sbx push <host path> [sandbox path]          sbx pull <sandbox path> [name]
sbx deploy <hostDir> [guestDir] [--launch <exe>] [--args "..."] [--restart]
sbx exec [--cmd] [--cwd <dir>] <command...>  sbx launch <exe|PackageFamilyName!AppId> [--args "..."]
sbx shot [--window <title>|--pid <pid>]      sbx windows   sbx proc <pid>
sbx record start [--fps 2 --duration 120]   sbx record stop
sbx ui [tree] [--pid <pid>]                  sbx ui click --name Save
sbx ui set --id NameBox --value Scott        sbx ui wait --name "Saved" --timeout 10
sbx snapshot <name> [--exclude <path>]...    sbx diff <from> <to>
sbx click <x> <y>   sbx type "text" [--keys] sbx errors   sbx status   sbx stop
sbx doctor                                   # can this PC run Windows Sandbox? how to fix it if not
sbx mcp                                      # run the MCP server
```

`exec` treats the command and everything after it as raw guest input. Put CLI options first:
`sbx exec --json --timeout 30 'Get-Date'`, not `sbx exec 'Get-Date' --json`.

Add `--json` to any command for machine-readable output. `sbx exec` and `sbx run` exit with meaningful codes, so they
drop straight into scripts. `sbx help` has the details.

CLI and MCP processes share locked, atomically written state, including copy and mailbox sequence numbers.
Desktop-changing operations (launch, click, type, UI actions and window-focusing screenshots) take cooperative
FIFO turns; observing windows, UI trees, processes, status and executing commands does not reserve the desktop.
An MCP instance retains its turn for four idle seconds. Set `SANDBOX_MCP_WORKFLOW` to the same identifier across
CLI commands to retain a multi-command turn too; anonymous CLI commands release immediately. End a turn with
`sbx desktop-release` or `sandbox_desktop_release`. A contender waits at most 60 seconds, then reports
`desktop busy: held by <owner>`. These are cooperative turns, not isolation: `exec` can itself start GUI programs.

Each boot has an epoch and a verified agent identity (protocol version, agent version and SHA256 of staged
agent files), included in `status --json`. A stale boot or incompatible protocol is refused: start a new sandbox.
Both TCP and offline mailbox messages use directional HKDF-SHA256 keys, AES-256-CBC encryption and
HMAC-SHA256 authentication with counters, random IVs and timestamp/replay checks. The random transport key
stays in the read-only agent share, never in `current.json`, command-line arguments or request/response messages.
This protects the transport, not against an administrator inside the guest: code there can read its agent share.

## Packaged apps (MSIX and Appx)

`sbx run` also accepts `.msix`, `.msixbundle`, `.appx` and `.appxbundle`. It copies the package into a
**fresh** guest, installs it with `Add-AppxPackage`, resolves its manifest Application Id, and activates the
installed AUMID. Screenshots, UI Automation, crash checks, test scripts and reports use the actual app process,
not the short-lived shell launcher.

```powershell
sbx run .\build\MyApp.msix --cert .\build\devcert.cer --network off --test .\smoke.ps1
sbx run .\build\MyApp.msixbundle --deps .\build\Dependencies\x64 --app-id App --network off
# Inside an already-running sbx session, activate an installed package:
sbx launch 'MyApp_0123456789abc!App'
```

`--cert` explicitly trusts a public `.cer` in **the guest's** `LocalMachine\TrustedPeople` store; it never
installs a certificate on the host. Store-signed/trusted packages do not need it. Provide offline framework
packages in an adjacent `deps` folder, or choose another folder with `--deps`; every package in that folder is
passed as a `DependencyPath`. Nothing is downloaded or preinstalled automatically. Select `--app-id` when
a manifest contains more than one application. Deployment failures include Windows' error and activity log
when available. Package activation is GUI mode, not `--console`.

The equivalent `sandbox_run` inputs are `app`, `cert`, `deps` and `appId`. `sandbox_launch` accepts `aumid`
instead of `path`, and the CLI also recognizes `shell:AppsFolder\PackageFamilyName!ApplicationId`.
Tests receive `$env:SBX_APP_AUMID` as well as the usual process/executable paths. Installed package directories
are read-only: write test output to `$env:SBX_OUT` or an app-data directory, not `$env:SBX_APP_DIR`.

## Recording and capture coordinates

For visual evidence across an entire session, use `sbx run <app> --record` (MCP: `sandbox_run` with
`record: true`), or `sbx record start` / `sbx record stop` for interactive work. Recording runs in a separate
guest process, including while a long command is running. Defaults: 2 fps, 120 seconds; hard limits:
5 fps, 300 seconds, 600 frames. `--max-frames` sets a smaller frame budget. Frames (up to 1280 pixels wide)
and append-only `frames.jsonl` metadata go directly to `out\recordings\<id>`; partial evidence survives
a guest crash or timeout. Stop publishes `recording.html` with embedded images and playback controls,
plus `recording.mp4` when ffmpeg is already on the host PATH. No guest installation or network is needed.
MP4 uses the requested frame rate; the HTML player preserves captured timestamps. Neither format includes audio.
The run report links the artifacts. `sbx stop` also publishes any tracked recording before destroying the guest.
Only one recording can be reserved across CLI/MCP clients. Tracking is bound to the boot epoch and recording ID;
failed publication retains recovery metadata so `sbx record stop` can retry without touching a replacement guest.
Rejected starts release a zero-frame reservation only after confirming that its recorder cannot still be active;
uncertain starts retain tracking and report the error explicitly.
Guest-returned screenshot filenames are checked as confined PNG leaf paths before host reads or cleanup.
After a guest crash or abrupt MCP disconnect, `sbx record stop` can still publish the preserved partial evidence,
even if `sbx status` already noticed the guest is gone. Truncated final recorder status is reported as partial,
not allowed to hide otherwise valid frames; malformed frame metadata is still rejected.

Start verifies the Default input desktop, explorer shell, screen size and a successful capture before declaring
ready. Screenshot, click, type and UI actions reject locked/secure desktops (including UAC) explicitly.
Screenshot coordinates are pixels in the returned preview, not the full-resolution saved PNG.
MCP clicks default to the latest screenshot; use `captureId` to select an earlier image. CLI clicks still default
to raw screen pixels: use `--coordinates screenshot --capture-id <id>` for a preview. Captured windows that
move, resize, minimize or close must be captured again before clicking.

## Test scripts

`sbx run --test smoke.ps1` (or `sandbox_run` with `test`) runs your script **inside** the sandbox after the app
starts, with:

- `$env:SBX_APP_PID`, `$env:SBX_APP_DIR`, `$env:SBX_OUT` (anything you write to `SBX_OUT` comes back to the host),
- these commands already imported:

```powershell
Get-SbxUiTree [-ProcessId <pid>] [-WindowTitle <title>] [-Depth <n>]     # objects: type, name, automationId, value, actions...
Invoke-SbxUi  -Action <click|setvalue|toggle|select|expand|read|...> [-Name <text>] [-AutomationId <id>]
              [-ControlType <Button|Edit|...>] [-Index <n>] [-Value <text>] [-ProcessId <pid>]
Wait-SbxUi    [-Name <text>] [-AutomationId <id>] [-ControlType <type>] [-TimeoutSec <n>] [-ProcessId <pid>]
```

Throw, or exit non-zero, to fail the run. Example ([samples/HelloSandbox/test.ps1](samples/HelloSandbox/test.ps1)):

```powershell
$app = [int]$env:SBX_APP_PID
Invoke-SbxUi -ProcessId $app -AutomationId NameBox -Action setvalue -Value 'Sandbox'
Invoke-SbxUi -ProcessId $app -Name Greet -Action click
Wait-SbxUi   -ProcessId $app -Name 'Hello, Sandbox!' -TimeoutSec 5 | Out-Null
```

## Installer testing

Installers are the part of an app that only ever runs on clean machines, so they're the part you test least.
`sbx install-test` takes a system snapshot of a fresh sandbox, runs your installer silently, snapshots again,
uninstalls it the way Add/Remove Programs would, snapshots a third time and diffs them:

```text
> sbx install-test .\7z2501-x64.msi --offline

PASS  7z2501-x64.msi on a fresh Windows Sandbox (117.5s)
  install    exit 0 in 2.5s
  added      7-Zip 25.01 (x64 edition); 111 files, 18 registry keys, 0 services, 0 autorun/env values
  uninstall  7-Zip 25.01 (x64 edition): exit 0 in 2.3s
  leftovers  none, clean uninstall
```

The report lists what was added (here: `C:\Program Files\7-Zip`, the Start menu folder, the shell extension
CLSIDs and context-menu handlers, App Paths and the uninstall entry) and what's **left behind**. Try the included
deliberately sloppy installer, whose uninstaller only deletes its program folder:

```text
> sbx install-test .\samples\LeakyApp\install.ps1

## Left behind after uninstall
Services:  added service LeakyUpdater "Leaky App Updater", automatic: "C:\Program Files\LeakyApp\updater.exe"
Autoruns:  added HKCU\Software\Microsoft\Windows\CurrentVersion\Run\LeakyUpdater
Files:     C:\ProgramData\LeakyApp\   C:\Users\WDAGUtilityAccount\AppData\Roaming\LeakyApp\
           C:\Windows\System32\Tasks\LeakyApp Daily Check
Registry:  HKLM\SOFTWARE\LeakyApp
```

- `.msi` files get `msiexec /i /qn /norestart` with a verbose log (brought back, with its errors in the report).
  For `.exe` installers pass the silent switch: `--args /S` (NSIS), `/VERYSILENT` (Inno), `--silent` (Squirrel).
- The uninstall uses what the installer registered: `msiexec /x {ProductCode}`, else `QuietUninstallString`, else
  `UninstallString` plus `--uninstall-args`. The run fails if the program is still in Add/Remove Programs afterwards.
- An installer that doesn't exit within `--timeout` is screenshotted (and its new windows' UI Automation tree
  recorded) before it's killed. That's usually a "silent" install that's waiting for someone to click a dialog.
- Processes the installer leaves running (tray apps, updaters) are listed and stopped before uninstalling.
- `--test smoke.ps1` runs between install and uninstall with `$env:SBX_INSTALL_DIR` and `$env:SBX_PROGRAM`.
- `--fail-on-leftovers` turns leftovers into a failure, for CI.
- The snapshots skip the things Windows changes on its own (caches, telemetry, Defender, Windows Update, Start menu
  and Explorer bookkeeping, Windows Installer's internal database), so a 30-second idle sandbox diffs to "No changes".
  `--exclude` adds more.

The same snapshots are available step by step: `sbx snapshot before`, do anything, `sbx snapshot after`,
`sbx diff before after` (or the `sandbox_snapshot` / `sandbox_diff` tools).

## Detonate: what does this file actually do?

Someone sent you `invoice.js`, a "driver update", a script from a forum. `sbx detonate` runs it the way a
double-click would, in a fresh sandbox with **no network adapter**, with Windows' own auditing switched on, and
tells you what it did:

```text
> sbx detonate .\samples\Suspicious\suspicious.ps1 --network firewall

suspicious.ps1: 3 red flag(s) (watched 40s, network firewall)
  findings   🔴 starts itself with Windows: added HKCU\Software\Microsoft\Windows\CurrentVersion\Run\ContosoUpdater =
                powershell.exe -WindowStyle Hidden -ExecutionPolicy Bypass -File "C:\Users\...\ContosoUpdater\updater.ps1"
             🔴 created a scheduled task: ContosoUpdate
             🔴 put something in a Startup folder: C:\Users\...\Start Menu\Programs\Startup\contoso.cmd
             🟠 wrote 2 runnable file(s): C:\Users\...\ContosoUpdater\updater.ps1, ...\Startup\contoso.cmd
             🟠 ran built-in Windows tools that malware often uses: schtasks.exe, whoami.exe, ipconfig.exe, net.exe, net1.exe
             🟠 looked up 1 internet name(s): c2.contoso-updates.example
             🟠 tried to connect to 2 address(es): 198.51.100.7:4444, 203.0.113.10:80
  processes  7 (powershell.exe → conhost.exe → schtasks.exe → whoami.exe → ipconfig.exe …)
  network    1 name lookup(s), 2 connection attempt(s)
  changed    4 files added, 0 changed, 2 registry keys, 1 autorun/env values, 0 services
```

([samples/Suspicious/suspicious.ps1](samples/Suspicious/suspicious.ps1) is harmless; it just behaves like
something that isn't.) The report also has a timeline:

```text
  +0.0s  start    powershell.exe (pid 8180)  ... -File "C:\Users\WDAGUtilityAccount\Downloads\suspicious.ps1"
  +1.5s  start    schtasks.exe (pid 7848)  /Create /F /TN ContosoUpdate /SC ONLOGON /TR "powershell.exe -WindowStyle Hidden ..."
  +1.6s  start    whoami.exe (pid 7616)  /all
  +1.7s  start    net.exe (pid 9064)  user
  +1.7s  start    net1.exe (pid 8096)  C:\Windows\system32\net1 user
 +15.0s  lookup   c2.contoso-updates.example (failed)
 +15.1s  connect  203.0.113.10:80/TCP blocked (powershell.exe)
 +15.2s  connect  198.51.100.7:4444/TCP blocked (powershell.exe)
```

plus the process tree, a before/after diff of files, registry, services and autoruns, the windows it opened,
screenshots, and "everything else that happened" (usually Windows itself, kept separate rather than hidden).

- **How:** process creation auditing with command lines (Security 4688), Windows Filtering Platform connection
  auditing (5156/5157) and the DNS client log, collected from inside the guest, plus the same snapshots as
  `install-test`. Activity is attributed to the file's own process tree, so the agent's own work isn't mixed in.
- **Network:** `off` (default) has no adapter at all. Name lookups are still recorded, but nothing leaves the
  machine. `--network firewall` also shows the IP addresses and ports it tries, blocked by the guest firewall.
  `on` gives it the internet; only use that for things you're prepared to let talk to the world.
- **Runs:** `.exe`, `.msi` (silently), `.ps1`, `.cmd`, `.bat`, `.js`/`.jse`/`.vbs`/`.vbe`/`.wsf` (with `wscript`) and
  `.hta` (with `mshta`), from the user's Downloads folder.
- **Watching:** up to `--duration` seconds (60), stopping early once everything it started has exited, unless
  `--full`. A screenshot every `--every` seconds (15).
- **Findings are heuristics, not a verdict.** Installers add autoruns and services too. Exit code 0 means "it was
  observed", not "it's safe". This is a quick first look on your own PC, not a malware lab: something that checks
  whether it's in a sandbox can just behave nicely.

## Network modes

| Mode | How | Use it for |
|---|---|---|
| `on` (default) | Normal NAT networking. | Apps that need the internet, downloading prerequisites. |
| `firewall` | Guest firewall blocks all outbound traffic (DNS included); only the control channel from the host is allowed. | Testing offline behavior quickly. Admin code in the guest *could* undo it. |
| `off` | The sandbox has **no network adapter**. sandbox-mcp talks to it through a shared-folder mailbox (~100 ms per call). | Untrusted files (the default for `detonate`), and proving an app works with no network at all. |

In `firewall` and `off` mode, sandbox-mcp also switches off Smart App Control in the guest. It ships in evaluation
mode and asks the cloud about every new exe and msi; with no internet each of those lookups hangs for about two
minutes (a 2 MB MSI took 125 s to install instead of 1 s).

## Security notes

- Each sandbox is a separate Hyper-V-isolated kernel. It's thrown away on stop, together with everything that ran in it.
- Hardened defaults: clipboard, printer, microphone and camera redirection are off, and *Protected Client* mode is on.
- The host shares exactly three folders: the guest agent (read-only), a staging folder for files you copy in
  (read-only) and an output folder (read-write). Nothing else from your disk is visible.
- The control channel needs a random per-sandbox token. In `on`/`firewall` mode it's TCP to the sandbox's private
  NAT address; in `off` mode it's the shared folder.
- `SANDBOX_MCP_ALLOWED_ROOTS` limits which host folders can be copied in (handy when an agent is driving).
- Every operation is appended to `audit.jsonl` in the run folder.
- When the MCP client disconnects, only the boot it started is destroyed, unless `SANDBOX_MCP_KEEP_ON_EXIT=1`.
  A client joining a CLI-started guest does not own it. An idle watchdog shuts the guest down after 30 minutes
  with no calls.
- With `network: on` the guest has internet access like any other machine on your network's NAT. Use `off` for
  anything you don't trust.
- The `out` folder is writable from inside the sandbox, so treat what comes back (screenshots, pulled files, logs)
  as untrusted, especially after `detonate`. sandbox-mcp reads data from it but never runs anything from it.
- Windows Sandbox is strong isolation, but not a guarantee: a hypervisor or Windows Sandbox escape would be a
  zero-day. For real malware analysis use a dedicated, disposable analysis machine.

## Configuration

| Environment variable | Default | |
|---|---|---|
| `SANDBOX_MCP_HOME` | `%LOCALAPPDATA%\sandbox-mcp` | Where runs, screenshots and reports are kept. |
| `SANDBOX_MCP_ALLOWED_ROOTS` | (any) | `;`-separated host folders that may be copied into the sandbox. |
| `SANDBOX_MCP_IDLE_MINUTES` | `30` | Guest shuts itself down after this long with no calls. `0` disables. |
| `SANDBOX_MCP_KEEP_ON_EXIT` | (unset) | Set to `1` to leave the sandbox running when the MCP client disconnects. |

## How it works

Since Windows 11 24H2 the Store version of Windows Sandbox ships the supported `wsb.exe` CLI
(`start / stop / list / ip / exec / share / connect`), but `wsb exec` returns only an exit code: no output, no
screenshots, no UI. So:

1. The host creates a run folder and calls `wsb start` with a hardened config (and `<Networking>Disable` in `off` mode).
2. It shares the guest agent folder and starts [`agent/agent.ps1`](agent/agent.ps1) inside with `wsb exec`, in the
   interactive user session (it needs a desktop for windows and screenshots).
3. The agent is a small PowerShell server: exec with real output, file copy, process launch, screenshots, mouse and
   keyboard, window list, event log, and UI Automation through [`agent/uia.cs`](agent/uia.cs). That uses *native* UI
   Automation (the managed `System.Windows.Automation` can't see inside WinForms apps), with an interop assembly
   generated on the fly from the OS type library, so nothing needs installing.
4. With the network on, the host talks to it over TCP. In `off` mode it uses a mailbox in the shared folders.
   (The guest caches "file not found" for ~5 s, so the host bumps a sequence file the guest polls, bringing a round
   trip from 5 s down to ~100 ms.)
5. `wsb stop` destroys the VM. The run folder stays on the host.

## Limits

- **One sandbox at a time.** That's a Windows Sandbox rule. `sbx run` calls queue nothing; they fail fast if one is running.
- Every boot is pristine. Bundle app-local prerequisites or explicitly opt in to provisioning for each fresh guest;
  automatic runtime installation is never the default.
- No Microsoft Store apps, winget, Notepad, Calculator or Windows Terminal inside. Windows PowerShell 5.1 and
  .NET Framework 4.8 are there.
- The first UI Automation call in a sandbox takes ~4 s (it generates the interop); later calls are fast.
- A system snapshot takes 10-20 s (about 11k files, 340k registry keys, 700 services), so `install-test` takes
  roughly two minutes plus your installer's own time.
- The guest desktop gets a plain background so screenshots stay around 100 KB instead of 16 MB.
- Needs a logged-in Windows session on the host (Windows Sandbox is a desktop feature).

## Verifying changes locally

`npm test` checks the host logic and parses/compiles the guest PowerShell and C# helpers without booting a guest.
Real desktop verification requires this Windows host's single Sandbox slot; coordinate with other users first
and never stop somebody else's guest.

```powershell
$env:SANDBOX_MCP_HOME = Join-Path $PWD 'work\integration'
node test\integration.js off
node test\integration.js on
node test\integration.js firewall
node test\evidence.js
npm run package:win
node test\package-smoke.js dist\sandbox-mcp-win-x64-v1.2.0.zip
```

The integration harness drives the actual MCP stdio server and CLI against the same fresh guest, verifies UIA,
copies evidence back, and fails if its guest cannot be torn down. JSON results are saved beneath
`$env:SANDBOX_MCP_HOME\integration`. The package smoke test extracts the ZIP, removes host Node from PATH, checks
CLI/MCP initialization and command surfaces, and compares every shipped source, agent and skill file with the
working tree. It does not boot a Sandbox and is not a substitute for the live tests.

`node test\agent-setup.js --download` follows the stable-download checksum/doctor instructions in a temporary
home, tests all three JSON client destinations on PowerShell 5.1/7, checks native `copilot mcp add` with isolated
`COPILOT_HOME`, and requires an actual MCP `sandbox_status` response. It needs the installed Copilot CLI for
the native-command check. Use `--portable=<extracted-path>` for an already downloaded package, or `--candidate`
to exercise the explicitly optional developer-preview discovery instructions.

For a live extracted-package check, run the integration harness with the extracted `node.exe` and set
`SANDBOX_MCP_TEST_ROOT` to the extracted folder. `SANDBOX_MCP_TEST_SHA` records the source commit when Git is not on
the isolated PATH. Set `SANDBOX_MCP_EXPECT_NO_HOST_NODE=1` to require both the bundled runtime and no `node` on PATH;
keep Windows system directories and the WindowsApps `wsb.exe` alias on PATH.

## Related projects

- [fmuecke/windows-sandbox-mcp](https://github.com/fmuecke/windows-sandbox-mcp) is another MCP server for Windows
  Sandbox, focused on running agent-generated code safely and with `Networking Disable` by default. Its ideas
  (true offline by default, stop on disconnect, an idle watchdog, an audit log, allowed folders) shaped this
  project. sandbox-mcp leans the other way: testing *your* app on a clean machine, with UI Automation, screenshots
  and one-shot reports.
- [devvm.dev](https://devvm.dev/): disposable cloud dev machines for agents. The inspiration for "just give the agent a fresh box".

## License

[MIT](LICENSE)
