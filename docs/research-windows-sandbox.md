# Windows Sandbox — capability research (pinned sources)

Researched 2026-11-08 while scoping feature work. Sources pinned at fetch time; claims below
quote them. Local ground truth beats memory: the `wsb` CLI surface was enumerated on this host.

## Pinned sources

1. Microsoft Learn, "Windows Sandbox" (overview), ms.date 2026-03-29, updated 2026-10-08:
   https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/
2. Microsoft Learn, "Use and configure Windows Sandbox" (.wsb reference), ms.date 2026-03-29:
   https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-configure-using-wsb-file
3. Local: `wsb.exe --help` on host build 26300 (Windows Sandbox 0.8.107.0), captured below.
4. Upstream repo (fork parent): https://github.com/shanselman/sandbox-mcp @ v1.2.0.

## The wsb CLI surface (complete, local capture)

`StartSandbox/start`, `ListRunningSandboxes/list`, `Execute/exec`, `ShareFolder/share`,
`StopSandbox/stop`, `ConnectToSandbox/connect`, `GetIpAddress/ip` + global `--raw` (JSON).
That is the entire command set — our core.js already drives all of them except `connect`
(used implicitly via the detached `wsb connect` spawn for the interactive session).

## Configuration surface (.wsb XML, from source 2)

`vGPU`, `Networking`, `MappedFolders` (`HostFolder`/`SandboxFolder`/`ReadOnly`, env vars in
paths since 23H2), `LogonCommand`, `AudioInput`, `VideoInput`, `PrinterRedirection`,
`ProtectedClient` (AppContainer isolation), `ClipboardRedirection`, `MemoryInMB` (auto-bumped
to 2048 minimum if too low). Window size is NOT configurable.

Notes vs our fork: our `configXml()` hardens beyond Windows defaults (clipboard/printer/mic/
camera off, ProtectedClient on) — Windows defaults ship clipboard ON. We map folders with
`wsb share` (post-boot, per-run) rather than `MappedFolders` (pre-boot, config-bound) — ours
die with the run folder, theirs would linger in a .wsb file. LogonCommand exists but `wsb exec`
is strictly more flexible; we keep exec.

## Findings that shape features

- **In-guest restarts persist state** (source 1: "Starting with Windows 11, version 22H2, data
  persists through restarts initiated within the sandbox"). Implication: installers demanding a
  reboot become testable — reboot the guest, keep the same sandbox. Our agent does not survive
  a guest reboot today (no re-injection path) → future feature: `sandbox_guest_reboot` that
  restarts the guest, waits, re-shares and re-launches the agent, same epoch rules.
- **One instance only** (source 1: "doesn't allow multiple instances") — confirmed hard limit;
  our queue-politely stance stands.
- Hyper-V default switch for networking; `--network firewall` mode of ours layers guest
  firewall policy on top (platform has no native middle ground).
- Dev-environment use case (source 1) matches our `deploy` warm loop; "secure web browsing /
  untrusted files" matches detonate defaults (networking off) — both validated by the utility
  battery in docs/evidence/util/.

## Feature decisions from this research (this sprint)

| Feature | Rationale |
|---|---|
| `sandbox_start { idleMinutes }` | lesson 9; agent already takes `-IdleMinutes`, expose it per call |
| `sandbox_drag` | pilotage completeness (mouse-down → move → up); charmap grid drag-select gives a verifiable demo |
| `sandbox_edge_debug` (CDP) | DOM-level control of guest Edge from the host per mission M3: launch with `--remote-debugging-port` + `--user-data-dir` (own profile, avoids Chromium's delegate-to-existing-instance pitfall), `netsh portproxy` the port (CDP binds 127.0.0.1 in the guest), host fetches `/json/version` |
| guest-reboot survival | documented as follow-up (needs agent re-injection design) |
