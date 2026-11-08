---
name: windows-sandbox-app-test
description: Test a Windows desktop or console app, or its installer, on a fresh, throwaway Windows machine (Windows Sandbox) through the sandbox-mcp tools or the sbx CLI. Use when asked to "try my build on a clean machine", check that an exe runs without the dev box's installed runtimes, smoke-test a GUI with screenshots and UI Automation, check what an installer changes or what its uninstaller leaves behind, find out what an untrusted file or script does when run, reproduce "works on my machine" bugs, or run something risky where it can't touch the real PC.
---

# Testing apps in Windows Sandbox

This skill documents v1.2.0. Use the matching release ZIP or source commit; older ZIPs do not contain every tool below.
Follow the README's edition/virtualization, administrator
feature-enable, restart and first-launch instructions, then run `sbx doctor` before any guest work.

Windows Sandbox is a clean Windows 11 VM that boots in ~15-20 s and is **destroyed on stop**. Only **one** can run at a
time. Nothing from the host is installed in it: no dev tools, no Store apps (no Notepad, Calculator, Terminal),
no winget. It has Windows PowerShell 5.1 and .NET Framework 4.8. Treat it like a brand-new customer PC.

## Pick the shortest path

Use `sandbox_deps` / `sbx deps <path>` first for a host-only dependency diagnosis. This does not execute the app
or install anything. The default run remains a clean-machine test; missing runtimes are findings, not permission
to install them. Static scan limitations and uncertain optional components are included in the output.
Only when the user explicitly requests runtime installation, pass `provision: "auto"` / `--provision auto`
or a list such as `desktop:10.0:x64,vcredist:x64`. The host verifies and caches official Microsoft installers,
then copies them in, so guest networking can stay off. Label the result **provisioned, not a clean-machine pass**.
For a guest already started with the step tools, use `sandbox_provision` / `sbx provision <host app path>
--provision <auto|list>`; it never boots or adopts a guest.

1. **"Does my build run on a clean machine?"** -> `sandbox_run` (or `sbx run <app.exe|folder>`). One call boots,
   copies the app in, launches it, screenshots it, checks the event log for crashes, optionally runs a test script,
   copies files out, destroys the sandbox and writes `report.md`. `pass` / the exit code is the verdict.
2. **"Does my installer work? Does the uninstaller clean up?"** -> `sandbox_install_test` (or
   `sbx install-test setup.msi`). Snapshots, installs silently, snapshots, uninstalls via Add/Remove Programs,
   snapshots, and reports what was added and what was left behind (files, registry, services, tasks, autoruns).
   `.msi` gets `/qn` automatically; for `.exe` pass the silent switch in `args` (`/S` NSIS, `/VERYSILENT` Inno).
   A hung install comes back with a screenshot of the dialog it was waiting on.
3. **"What does this file do? Is it safe to run?"** -> `sandbox_detonate` (or `sbx detonate <file>`). Runs it with no
   network (by default), Windows auditing on, and reports processes with command lines, names looked up, connections
   tried (`network: "firewall"` to see addresses), autoruns, scheduled tasks, services and files it planted, plus
   screenshots and findings. Findings are heuristics: tell the user what it did, not "it's safe".
4. **Interactive exploration or multi-step UI testing** -> `sandbox_start`, the step tools below, `sandbox_stop`.
   `sandbox_snapshot` before and after anything + `sandbox_diff` shows what it changed on the system.

## Step-by-step loop

1. `sandbox_start` (`network: "off"` when the app must not reach the internet; `"firewall"` is weaker).
2. `sandbox_copy_in` the build output folder (it lands in `C:\apps\<name>` by default).
3. `sandbox_launch` the exe (GUI) or `sandbox_exec` it (console; returns stdout/stderr/exit code).
4. Look and drive, **preferring UI Automation over pixels**:
   - `sandbox_ui_tree` with the pid -> one line per control: `Button "Save" #SaveButton {invoke}`.
   - `sandbox_ui_action` by `name` / `automationId` / `controlType`: `click`, `setvalue` (+ `value`), `toggle`,
     `select`, `expand`, `read`, ... Returns `{pending:true}` if a modal dialog opened; that is normal.
   - `sandbox_ui_wait` for a result label, dialog or state to appear.
   - `sandbox_screenshot` for visual checks; `sandbox_click` / `sandbox_type` only when UIA can't see the control
     (custom-drawn, games, some Chromium content). Click coordinates refer to the last screenshot by default;
     pass its `captureId` when using an older image. Out-of-image points and moved/resized captured windows
     fail explicitly: take a new screenshot. CLI: `sbx click x y --coordinates screenshot --capture-id <id>`.
   - Start waits for the Default input desktop, explorer and a successful capture. Status reports these facts.
     Screenshot, click, type and UI actions fail closed on a locked or secure desktop (including UAC).
   - To preserve a session visually, `sandbox_record_start` / `sandbox_record_stop` (CLI: `sbx record start|stop`).
     Defaults: 2 fps, 120 seconds; caps: 5 fps, 300 seconds, 600 frames. A separate guest process streams PNGs
     and timestamp/bounds/scale/foreground metadata to the host share even during long exec calls.
     Stop publishes a self-contained HTML flipbook, plus MP4 if host ffmpeg is already available.
     Partial frames survive crashes. One-shot `sandbox_run` accepts `record: true` (`sbx run --record`);
     its report links the evidence. No extra software is installed in the guest.
     Reservations are shared across clients and bound to the boot epoch/recording ID. Publication failures keep
     recovery metadata for retry; confirmed inactive zero-frame starts are released with an explicit error.
5. `sandbox_app_errors` (since `launchedAt`) to catch crashes and .NET unhandled exceptions.
6. `sandbox_copy_out` logs, output files, crash dumps.
7. `sandbox_stop`. Everything inside is gone; artifacts stay on the host in the run's `out` folder.

## Tips

- CLI and MCP can share one guest. Desktop-changing commands take cooperative turns (four-second idle grace
  for MCP or `SANDBOX_MCP_WORKFLOW`); observations and `exec` do not reserve the desktop. Use
  `sandbox_desktop_release` / `sbx desktop-release` when done with a turn. A competing workflow waits up to
  60 seconds before a clear desktop-busy error. Do not use `exec` to bypass a turn for UI input.
- For a warm build/deploy/relaunch loop, start once and use `sandbox_deploy` with `hostPath`, optional `sandboxPath`,
  `launch: "MyApp.exe"` and `restart: true` (`sbx deploy <hostDir> [guestDir] --launch MyApp.exe --restart`).
  It hashes the source and destination, transfers only changed files, removes deleted files and verifies every hash.
  Use a dedicated guest directory (extra guest files are deleted); rebuild only before the deploy, not during it.
  This is explicit reuse of your running sandbox, not a clean-machine test. `sandbox_copy_in` remains full replacement.
- `sandbox_status` includes the boot epoch and verified agent protocol/version/hash. Both TCP and offline
  mailbox traffic are encrypted and authenticated; stale boot/protocol errors mean start a fresh sandbox.
  Never copy the key from the read-only agent share into logs, command lines or tool arguments.
- For `.msix`, `.msixbundle`, `.appx` or `.appxbundle`, use `sandbox_run` with `app`, optional public `cert`
  (`.cer`, guest TrustedPeople only), optional `deps` folder (default adjacent `deps`), and `appId` if the
  manifest has multiple applications. It installs offline dependencies and activates the AUMID, then follows
  the same screenshot/UIA/report flow. No Store or package download is required or attempted. CLI equivalents:
  `sbx run app.msix --cert devcert.cer --deps Dependencies\x64 --app-id App --network off`.
  `sandbox_launch` also accepts `aumid: "PackageFamilyName!AppId"` for an already-installed app;
  `sbx launch 'PackageFamilyName!AppId'` does the same. Package tests get `$env:SBX_APP_AUMID`.
  The package's install directory is read-only; write files to `$env:SBX_OUT` or app data.

- If a tool says "Windows Sandbox isn't ready on this PC", pass its fix list on to the user (it usually needs an
  admin command and a restart); don't try to work around it. `sbx doctor` re-checks.
- One sandbox at a time: if `sandbox_start` says one is running, stop only a guest you own;
  otherwise ask its owner or the user rather than interrupting it.
- Boot is fresh every time. Diagnose missing prerequisites first; do not install them without explicit user opt-in.
  A missing prerequisite is often exactly the bug being hunted.
- `sandbox_exec` runs Windows PowerShell 5.1 as an admin user in the interactive session. Use `shell: "cmd"` for
  batch syntax. Long-running or GUI processes belong in `sandbox_launch`.
- In `sbx run --test script.ps1`, the script runs inside the sandbox with `$env:SBX_APP_PID`, `$env:SBX_APP_DIR`,
  `$env:SBX_OUT` and the `Invoke-SbxUi`, `Wait-SbxUi`, `Get-SbxUiTree` commands already imported. Throw or exit
  non-zero to fail.
- WinForms, WPF, Win32 and WinUI controls all show up in the UI tree (native UI Automation is used).
- The sandbox shuts itself down after 30 idle minutes. MCP disconnect cleanup stops only the boot started
  by that client, unless `SANDBOX_MCP_KEEP_ON_EXIT=1`; joining a CLI-started guest does not transfer ownership.
