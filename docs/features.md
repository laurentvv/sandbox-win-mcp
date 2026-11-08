# Feature catalog — sandbox-win-mcp 2.0.0-alpha.2 (34 MCP tools + sbx CLI)

Every feature below is implemented on this fork and verified by execution; the evidence column
points at sanitized artifacts under `docs/evidence/`. Upstream v1.2.0 behavior is preserved
unless a row says otherwise.

## Lifecycle & host readiness

| Tool / CLI | What it does | Verified by |
|---|---|---|
| `sandbox_start { network, memoryMB, vGpu, window, idleMinutes }` / `sbx start` | Boot a fresh hardened guest; idle auto-stop per call (1-1440 min) | features-verify.json (-IdleMinutes 7 on the agent command line) |
| `sandbox_status` / `sbx status` | Id, epoch, agent identity (protocol + SHA-256), desktop, recording | every lab run |
| `sandbox_stop { force }` / `sbx stop` | Destroy + publish recordings, keep artifacts | e2e (stop-on-disconnect too) |
| `sandbox_janitor { fix }` / `sbx janitor [--fix]` | Detect/clear headless orphans; graceful ladder then exact elevated command | janitor-1/2/3 JSONs: real orphan created, flagged, elevation path proven |
| `sandbox_guest_reboot` / `sbx reboot` | Reboot the guest IN PLACE: state persists, new IP learned, agent re-injected and verified on the same epoch | batch-d-verify.json: 24s full ladder, file + registry markers survive; reboot-probe.json exploration |
| `sbx doctor` (v2) | Pending-reboot as a DISTINCT check (CBS/packages/WU/file-rename sources); wsb resolution says App-Execution-Alias vs PATH | doctor-v2-host.json (caught a real pending file rename) |
| boot telemetry | `start` returns `stages[]` (wsb-start, network-ready, shares, user-session, agent, desktop) | features-verify boot entries |

Conflict errors carry `code` `SBX_CONFLICT` / `SBX_ORPHAN` and embed host process facts + janitor hint.

## Files & code

| Tool | What it does | Verified by |
|---|---|---|
| `sandbox_copy_in` / `sandbox_copy_out` | Move files in/out; outputs land under the run's out/ (untrusted data) | e2e, battery |
| `sandbox_deploy` | Hash-verified incremental warm deploys (only changed bytes move) | deploy-recording-battery.json: cold 2 → warm 0 → 1 changed 37 B |
| `sandbox_exec` / `sandbox_launch` / `sandbox_process` / `sandbox_process_kill` | Run commands, start GUI apps, poll, kill by pid/name | batch-b-verify.json (kill by name + pid) |
| `sandbox_deps` / `sandbox_provision` | Static dependency scan; OPT-IN verified runtime installs | upstream suite (unit tests) |

## Input engine (UIA-first, lesson 4/5 fixes)

| Tool | What it does | Verified by |
|---|---|---|
| `sandbox_smart_click { selector, verify }` | Ladder: Invoke/Toggle/Select/ExpandCollapse → LegacyIAccessible → UIA focus+Enter → focus-verified SendInput; per-rung report + effect check | exp2: consent wall dismissed in ONE call (uia-invoke, 12ms); rungs B/C live on pattern-less elements |
| `sandbox_type { mode: text\|keys }` | Explicit modes; ambiguous literal default removed (legacy `literal` warns) | smart-input tests (unit), smoke |
| `sandbox_click` / `sandbox_drag` / `sandbox_scroll` | Pixel click; animated drag (window move verified 22,65→112,125); wheel scroll (CDP oracle: scrollY 487→1087) | features-verify, batch-b-verify |
| `sandbox_ui_tree` / `sandbox_ui_action` / `sandbox_ui_wait` | Inspect/act/wait on controls by name/automationId/type | every lab run |

## Observation & evidence

| Tool | What it does | Verified by |
|---|---|---|
| `sandbox_screenshot` / `sandbox_windows` | Capture with captureId coordinate mapping; window list | labs |
| `sandbox_record_start/stop` | Guest-side recorder → HTML flipbook + MP4 | battery: 18 frames → recording.html + .mp4 |
| `sandbox_app_errors` | Application event log since a timestamp | install-test |
| `sandbox_snapshot` / `sandbox_diff` | Files/registry/services/autoruns/programs diff | install-test-leaky.json (task+startup+registry caught) |

## One-shot flows

| Tool | What it does | Verified by |
|---|---|---|
| `sandbox_run` | Copy in → launch → observe → crash check → report.md | smoke (PASS) |
| `sandbox_install_test` | Snapshot → install → uninstall → leftovers report | install-test-leaky.json: PASS 42s |
| `sandbox_detonate` | Audited execution of an untrusted file (heuristics, no verdict) | detonate-suspicious.json: 3 high findings |

## Browser control (Chromium / Edge)

| Tool | What it does | Verified by |
|---|---|---|
| `sandbox_edge_debug { port, startUrl }` | Guest Edge with CDP relayed to the sandbox IP (own profile, portproxy + firewall) | features-verify + batch-b: /json/version, /json/list, Runtime.evaluate |
| DOM-level driving | Host agents use the returned URL with any CDP client (native WebSocket suffices) | batch-b-verify.json: navigated to Wikipedia, read window.scrollY |

## Known follow-ups

- Publishing (remote, tags, GitHub releases) awaits an explicit instruction; the local release
  artifact pipeline is validated (`npm run package:win` + `node test/package-smoke.js <zip>`).
- A scripted live regression suite chaining the acid test (today: lab targets
  `npm run lab:input -- --tag <t> --only edge,acid`).
