# Upstream audit — sandbox-mcp v1.2.0 (import baseline)

Audited 2026-11-08 before any modification, at tag `v1.2.0`, commit `b5ea2b2`
(source: the secu-tools local checkout of the upstream submodule). Method: full read of
`src/` (core, server, cli, protocol), signature-level mapping of `agent/`, review of test
patterns and packaging. This document is the fork's founding map: every milestone PR links back
to a row here.

## Architecture in one paragraph

The host drives the `wsb` CLI (Windows Sandbox's official command line, JSON via `--raw`).
`src/core.js` owns the single-sandbox lifecycle and state (`%LOCALAPPDATA%\…\current.json`,
lock-protected, epoch-stamped); `src/server.js` maps ~27 operations to MCP tools over stdio;
`src/cli.js` exposes the same core as `sbx`. Inside the guest, `agent/agent.ps1` runs in the
interactive session and answers ops (`exec`, `copy`, `click`, `keys`, `uitree`, `uiaction`,
`snapshot`, …) over TCP :5985, or — with networking off — through HKDF-encrypted
request/response files in the shared `in`/`out` folders. Agent identity is pinned at boot:
protocol version + SHA-256 over the staged agent files, verified on `ping`. Everything the guest
writes lands under the run's `out/` directory and survives teardown; `audit.jsonl` records every
op with timing and outcome.

## Repository map

### src/ (host side, ESM, Node 20+)

| File | Role | Notes for the fork |
|------|------|--------------------|
| `core.js` (698 l.) | Lifecycle + all sandbox ops; `wsb` wrapper; doctor probe; `ALLOWED_ROOTS` guard; diff formatting | Heart of M1: `checkSandbox()` (l. 52-119), conflict path in `startSandbox` (l. 301-306), `type()` literal default (l. 577) |
| `server.js` (418 l.) | MCP stdio server, 27 tools, owned-sandbox shutdown on client disconnect | Tool registry = M2/M3 surface; name now `sandbox-win-mcp` |
| `cli.js` (399 l.) | `sbx` CLI, same core | `--keys` vs literal flags already exist CLI-side; M2 makes modes explicit |
| `protocol.js` (59 l.) | Frame crypto: HKDF-SHA256 → AES-256-CBC + HMAC-SHA256, counters, replay window, ±5 min timestamp | **Invariant**: any wire change bumps `PROTOCOL_VERSION` |
| `coordination.js` (105 l.) | Atomic JSON writes, retries, cross-process state lock, desktop turn arbitration | Untouched in M0 |
| `capture.js` | Screenshot capture-id bookkeeping, preview→screen coordinate mapping | M2 click verification reuses it |
| `recording.js` | Guest recorder reservation, HTML flipbook + MP4 publication | Keep as-is (lesson 8) |
| `deploy.js` | Incremental warm-sandbox deploy with SHA-256 verification | M3 ALLOWED_ROOTS hardening touches `checkAllowed` (core.js l. 457) |
| `deps.js` | Host-only PE/.NET/Appx static dependency scan | — |
| `provision.js` | OPT-IN verified runtime installs (MS-signed, hash-checked) | — |
| `install.js` | Installer test flow: snapshot → silent install → uninstall → snapshot, leftovers report | M3 stabilizes report schema (JSON+md) |
| `detonate.js` | Untrusted-file detonation: audit policies on, process/DNS/connection watch, heuristic findings | M3 stabilizes report schema (JSON+md) |
| `run.js` | App test flow: copy in → launch → observe → crash check → report | M3 stabilizes report schema (JSON+md) |
| `packaged.js` | MSIX/AUMID activation targets | — |

### agent/ (guest side — PowerShell + C# inline, zero installs)

| File | Role |
|------|------|
| `agent.ps1` (21.7 KB) | Guest agent: TCP listener + mailbox poll, op dispatch, idle auto-stop (`-IdleMinutes`), interactive-desktop assertion for input ops |
| `uia.cs` (16 KB) | Native UIA via `CUIAutomation8`: tree walk, selectors (name/automationId/controlType), patterns incl. Invoke/Toggle/Value/Selection/ExpandCollapse, `Do()` returns which pattern fired |
| `snap.cs` (21.7 KB) | Snapshot/diff engine (files, registry, services, autoruns, programs) |
| `SbxUi.psm1` | UIA wrapper with COM unwrapping (cross-thread safety) |
| `protocol.cs` | Frame crypto mirror of protocol.js (C# side of the mailbox channel) |
| `activation.cs` | Packaged-app (MSIX/AUMID) activation helper |
| `desktop.ps1` | Input-desktop checks (Default desktop, not locked/UAC) |
| `record.ps1` | Guest-side single-shot frame recorder entry |
| `recording.ps1` | Guest-side continuous recording loop (frames + manifest to the out share) |
| `watch.ps1` | Detonate support: process/connection/DNS auditing setup in the guest |
| `deploy.ps1` | Guest side of verified incremental deploy (hash manifest apply) |
| `package.ps1` | Guest folder packaging for evidence export |

### test/, scripts/, samples/, skills/, spike/

- `test/unit/*.test.js` — 13 files, pure `node:test` (doctor logic tested via fabricated facts;
  no sandbox needed). Our §3 gate.
- `test/smoke.js` — LIVE end-to-end over real stdio MCP (builds HelloSandbox, boots guest,
  drives UI incl. a UIA pass). `test/offline.js` — LIVE mailbox/offline path. `test/fixtures/`
  — sandbox build manifest.
- `scripts/` — packaging (`package.ps1`, cmd shims). `samples/` — 8 test apps (HelloSandbox,
  NativeWin32, WinUI, Wpf, LeakyApp, Suspicious…). `skills/windows-sandbox-app-test` — shipped
  agent skill. `spike/` — early prototypes (kept for archaeology; not shipped).

### Not imported from upstream

- `.github/workflows/` (ci.yml, release.yml) — agents never run CI on GitHub infrastructure;
  validation stays local (`npm test`, smoke, handshake).
- `PLAN.md` — upstream's own roadmap; superseded by this audit + the milestone ledger.
- `node_modules/`, submodule `.git` link.

## The ten live lessons → code map → milestone

Measured live on Windows 11 Pro build 26300 (secu-tools testing, pre-fork):

| # | Lesson (observed) | Upstream code today | Fork plan | M |
|---|-------------------|---------------------|-----------|---|
| 1 | `wsb` is an App Execution Alias under `%LOCALAPPDATA%\Microsoft\WindowsApps`, appears only after first Sandbox launch; System32 probes give false negatives | Probe already checks alias (core.js l. 61-64) and `wsb.exe` runs from PATH; but no alias-vs-PATH distinction in remedies, no System32 trap documented | doctor v2: report resolution path (PATH/alias/absent) + "launch once from Start" remedy; unit tests cover all three | M1 |
| 2 | After `Enable-WindowsOptionalFeature`, DISM reports Enabled + RestartNeeded=True — invisible today | `sandboxChecks` folds it into "isn't running yet → Restart Windows" only when hypervisor is off | Probe CBS `RebootPending`/`PackagesPending` + WU `RebootRequired`; expose **pending-reboot** as a distinct check with its own remedy | M1 |
| 3 | Killing client processes (WindowsSandboxRemoteSession/Server) leaves `vmmemWindowsSandbox` headless, holding the singleton slot; needs elevation to kill | Nothing detects orphans; `startSandbox` throws a generic conflict (l. 301-306) | Janitor op: detect orphan (wsb list vs processes), clean teardown (client shutdown, `Restart-Service CmService` fallback, elevation when needed); wire into the conflict error | M1 |
| 4 | SendInput clicks work on native UI but were ignored 4/4 on Edge web content (Google consent iframe); UIA Invoke on that dialog also failed; UIA setvalue + real Enter worked | `uia.cs Do()` already returns the winning pattern, but `click` is SendInput-only and `uiAction` reports nothing strategic to the caller | Input engine: resolve element → Invoke/Toggle/Select/ExpandCollapse → SendInput only with focus-verify-then-click; every input action reports the strategy that succeeded | M2 |
| 5 | `sandbox_type` defaults `literal=true` — "{ENTER}" silently typed as text | core.js `type()` l. 577, cli.js `--keys` opt-in, server tool schema `literal` default true | Explicit modes (`text` \| `keys`), no ambiguous default; semantic actions preferred; deprecation shim for one release | M2 |
| 6 | Singleton slot is a hard Windows limit; silent "slot busy" is unacceptable | `status()` returns `otherSandboxes`; conflict error exists but no janitor/no taxonomy | Conflict error names owner + offers janitor; error taxonomy (conflict/orphan/not-ready/stale-epoch) shared CLI+MCP | M1 |
| 7 | `copy_out` artifacts are guest-writable → untrusted; `ALLOWED_ROOTS` empty = unrestricted today | `checkAllowed` guards host→guest only (l. 457-465) | Document loudly + safe-default prompt; keep guest→host confined to run dir (already true); M3: optional roots for copy_out destinations | M3 |
| 8 | Evidence pipeline made live debugging possible | runDir/out + audit.jsonl + manifest | Keep untouched; treat as invariant | — |
| 9 | Idle auto-stop (30 min env-fixed) is good, want per-call | `IDLE_MINUTES` read once at process start (core.js l. 23), passed to agent at boot | `sandbox_start { idleMinutes }` → agent arg; validate range | M1 |
| 10 | Boot 10.4 s measured — don't regress; add per-stage telemetry | `steps[]` timestamps exist (startSandbox) | Keep; extend steps with stage breakdown in audit.jsonl | M1 |

## Fork decisions taken at import (M0)

- Package `sandbox-win-mcp` v`2.0.0-alpha.1` (breaking changes planned in M2 justify the major).
- State home renamed `%LOCALAPPDATA%\sandbox-win-mcp` (env `SANDBOX_MCP_HOME` still honored) so
  the fork never shares `current.json`/runs with an existing upstream install.
- MCP server name → `sandbox-win-mcp`; `sbx` CLI name kept for muscle-memory parity.
- LICENSE: upstream MIT line preserved verbatim, fork copyright line added.
- `.gitattributes` added (LF normalization, CRLF for `.ps1`/`.cmd`, binary assets pinned).
- Unit gate = upstream's `node --test` suite unchanged; new `test/mcp-handshake.js` proves the
  stdio server wire-up without booting a guest.
- Host-capability note: `capture.test.js` creates a file symlink, which on Windows requires
  Developer Mode or elevation (upstream's CI ran elevated, so this never surfaced there). This
  dev machine has Developer Mode enabled (2026-11-08); the gate then passes 97/97 unprivileged.
- M0 smoke evidence on this host (build 26300): [docs/evidence/m0-doctor-build26300.json]
  (evidence/m0-doctor-build26300.json) — doctor exit 0; `wsb` resolves through the App Execution
  Alias (`%LOCALAPPDATA%\Microsoft\WindowsApps\wsb.exe`, Windows Sandbox 0.8.107.0), live
  confirmation of lesson 1.

## Acid test (M2 definition of done)

Fresh guest → Edge → google.com → EU consent wall → dismissed in ≤ 3 tool calls, zero manual
intervention, action log names the winning strategy ("UIA InvokePattern on 'Tout refuser'" or a
documented fallback). Scripted and repeatable — becomes `test/consent-wall.js` (live checklist).
