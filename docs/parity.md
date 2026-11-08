# Parity notes — this fork vs upstream sandbox-mcp v1.2.0

Baseline: upstream tag `v1.2.0`, commit `b5ea2b2`, imported **verbatim** in `8719b3a`
(verified: `git archive` tree diff against the upstream checkout = 0 lines, excluding the
declared exclusions below). Everything listed here lives on top of that commit.

## Identical (untouched from upstream)

- The whole guest agent pipeline except `agent/uia.cs`, `agent/agent.ps1`, `agent/SbxUi.psm1`:
  `snap.cs`, `protocol.cs`, `activation.cs`, `desktop.ps1`, `record*.ps1`, `watch.ps1`,
  `deploy.ps1`, `package.ps1`.
- Host `src/`: `protocol.js` (wire crypto — `PROTOCOL_VERSION` still 2, interop with the
  upstream guest intact), `coordination.js`, `capture.js`, `recording.js`, `deps.js`,
  `provision.js`, `packaged.js`; `install.js`/`detonate.js`/`run.js` differ only by the report
  envelope call; `deploy.js` unchanged (the warning is added by the core wrapper).
- Hardened `.wsb` defaults, evidence pipeline (runDir/out + audit.jsonl), idle auto-stop
  mechanics, one-shot flows' logic, `test/unit` upstream suite (one doctor regex updated for
  the new resolution detail, one offline assertion updated for the fork package name),
  `samples/`, `skills/`, `scripts/sbx.cmd` shims.

## Added by the fork (7 MCP tools; 34 total)

| Tool | Purpose |
|---|---|
| `sandbox_smart_click` | UIA-first activation ladder with per-rung strategy reporting + effect checks |
| `sandbox_drag` / `sandbox_scroll` | mouse gestures (window-move / CDP-oracle verified) |
| `sandbox_process_kill` | terminate guest processes (pid or name) |
| `sandbox_janitor` | orphan detection + teardown ladder + elevation path |
| `sandbox_edge_debug` | guest Edge CDP relayed to the sandbox IP (DOM-level host control) |
| `sandbox_guest_reboot` | in-place guest reboot: state persists, agent re-injected same epoch |

Plus: per-call `idleMinutes`, explicit `sandbox_type` modes, `stages[]` boot telemetry,
versioned report envelopes, doctor v2 checks, ALLOWED_ROOTS warnings/confinement,
`SBX_*` error codes, `scripts/check-uia.ps1` compile gate, the `test/lab/` experiment suite,
this documentation set (audit / lab findings / research / features / parity).

## Changed behavior (breaking or visible)

1. **`sandbox_type` mode is explicit** (`text` | `keys`). Upstream callers passing only `keys`
   now get a clear error instead of silent literal typing; `literal` still maps for one release.
2. Package / MCP server name / state home are `sandbox-win-mcp`; state lives in
   `%LOCALAPPDATA%\sandbox-win-mcp` so the fork never shares `current.json` with an upstream
   install (`SANDBOX_MCP_HOME` overrides both tools alike).
3. `copy_out` results gained `untrusted: true` + `note`; `copy_in`/`deploy` may carry a
   `warning` — additive fields, existing parsers unaffected.
4. `report.json` files are envelopes (`schema`, `schemaVersion`, `kind`, `generatedAt`,
   `result`) — consumers reading the raw result must read `.result` now.
5. `sbx doctor` output has two more checks (restart pending, wsb resolution detail).

## Excluded at import

`.github/workflows/ci.yml`, `.github/workflows/release.yml` (this fork runs no CI on GitHub
infrastructure; gates are `npm test`, `test/mcp-handshake.js`, `scripts/check-uia.ps1`,
`npm run e2e` locally) and upstream's `PLAN.md` (superseded by `docs/upstream-audit.md`).

## Scale (real numbers)

`git diff --stat 8719b3a..HEAD`: 56 files, +6523/−783 overall; code areas (`src/`, `agent/`,
`test/`) 24 files, +1715/−54 — the fork evolves upstream's architecture, it does not replace it.
