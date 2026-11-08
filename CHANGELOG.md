# Changelog

All notable changes to this fork. Evidence pointers resolve under `docs/evidence/`.
Upstream baseline: [shanselman/sandbox-mcp](https://github.com/shanselman/sandbox-mcp) v1.2.0
(`b5ea2b2`), imported verbatim in commit `8719b3a` (0-line diff against the tag).

## 2.0.0-alpha.3

### Added
- `sandbox_guest_reboot` / `sbx reboot` — reboot the guest in place: state persists (22H2+),
  new IP learned into state, agent re-injected and verified against the same pinned identity.
  Live-measured 24 s full ladder; file and registry markers survive (`evidence/util/batch-d-verify.json`).
- `sandbox_janitor { fix }` / `sbx janitor --fix` — headless-sandbox detection (vmmem alive,
  no client, `wsb list` blind) with a graceful teardown ladder and an exact elevated command
  when the session is not admin. Proven on a real orphan (`evidence/util/janitor-*.json`).
- `sandbox_scroll` / `sbx scroll` — mouse wheel (vertical/horizontal, ±30 notches, capture
  mapping). Verified against a CDP oracle: `window.scrollY` 487 → 1087 (`evidence/util/batch-b-verify.json`).
- `sandbox_process_kill` / `sbx kill` — terminate guest processes by pid or name (live-verified both ways).
- `sandbox_start { idleMinutes }` / `sbx start --idle-minutes` — per-call idle auto-stop (1-1440,
  validated; booleans rejected), passed through to the guest agent command line.
- `sandbox_drag` / `sbx drag` — animated mouse drag; verified by an exact title-bar window move
  (requested +90,+60 → window 22,65 → 112,125).
- `sandbox_edge_debug` — guest Edge with `--remote-debugging-port` on its own profile, relayed to
  the sandbox IP (portproxy + firewall). Host-side DOM control proven end to end (navigate +
  `Runtime.evaluate` over native WebSocket).
- Structured boot telemetry: `start` returns `stages[]` alongside the human-readable `steps`.
- Versioned report envelopes: `report.json` for run/install_test/detonate opens with
  `schema: sandbox-win-mcp/<flow>-report@1`.

### Changed
- `sandbox_type` now requires an explicit `mode: "text" | "keys"` (the `literal=true` default
  that silently typed `{ENTER}` as text is gone). Legacy `literal` maps for one release with a
  deprecation note.
- `sandbox_copy_in` / `sandbox_deploy` results carry an unrestricted-roots warning while
  `SANDBOX_MCP_ALLOWED_ROOTS` is empty; configured roots reject outside paths (real-path aware).
- `sandbox_copy_out` is confined under the run out directory and marked `untrusted: true`
  (guest-written data is attacker-controlled).
- `sbx doctor` v2: pending reboots (CBS / packages / Windows Update / file rename) are a
  distinct check naming their sources; `wsb` resolution says App Execution Alias vs PATH.
  Caught a real pending file rename on the dev host the night it shipped.
- `sandbox_smart_click` click ladder orders actionable elements first when a selector matches
  several nodes (`selectorNote` in the result).
- Package/server/state home renamed `sandbox-win-mcp` (state isolated at
  `%LOCALAPPDATA%\sandbox-win-mcp`; `SANDBOX_MCP_HOME` still honored).
- Conflict errors carry codes `SBX_CONFLICT` / `SBX_ORPHAN` with host process facts + janitor hint.

### Fixed
- Google consent wall (acid test): dismissed in **one** tool call (`uia-invoke`, 7-12 ms,
  3/3 runs) — root causes were a selector trap (loose name matching explanatory Text nodes) and
  lazy Chromium accessibility activation; both addressed in the engine and documented in
  `docs/lab-input-findings.md`.

### Removed / excluded vs upstream
- `.github/workflows/` (no GitHub-hosted CI in this fork), upstream `PLAN.md`.

## 2.0.0-alpha.1 / alpha.2

Fork bootstrap (verbatim import, identity, audit `docs/upstream-audit.md`, MCP handshake smoke,
agent-state onboarding) and the first input-engine cut (`sandbox_smart_click` ladder, explicit
type modes, input lab `docs/lab-input-findings.md`).

## 1.2.0

Upstream release, unchanged: see upstream history. Imported here verbatim as the baseline.
