# sandbox-win-mcp

## A hardened Windows Sandbox MCP server. Give your AI agent a brand-new Windows PC — then throw it away.

**A real, disposable Windows 11 machine**: boot it, deploy your app, drive the controls, catch the
crash, keep the evidence, delete the PC. One MCP tool call or `sbx run`.

This is the **hardened edition** of [shanselman/sandbox-mcp](https://github.com/shanselman/sandbox-mcp)
v1.2.0 (MIT), evolved — not rewritten — from the upstream codebase after live testing on
Windows 11 Pro build 26300 surfaced concrete gaps (see [docs/upstream-audit.md](docs/upstream-audit.md)
for the full per-file audit and the ten live lessons that drive the roadmap).

### What it keeps from upstream

- stdio MCP server (Node 20+) with 34 tools + the `sbx` CLI sharing the same state
- guest agent = PowerShell + native UI Automation (zero runtime installs in the guest)
- control channel: TCP (network on) or HKDF-encrypted shared-folder mailbox (offline)
- hardened `.wsb` defaults: no clipboard/printer/mic/camera redirection, Protected Client
- evidence pipeline: screenshots, HTML/MP4 recordings, `audit.jsonl`, reports under a per-run
  `out/` directory with a manifest — everything survives guest teardown

### What the hardening adds (roadmap)

| Milestone | Theme | Highlights |
|-----------|-------|-----------|
| M0 ✅ | Bootstrap | fork + audit + reproducible smoke tests (`doctor`, MCP stdio handshake) |
| M1 ✅ | Reliability | doctor v2 (App-Execution-Alias resolution, **pending-reboot state**, caught a real one live), **janitor** for headless `vmmemWindowsSandbox` orphans (real orphan created + detected + elevation path proven), conflict taxonomy (`SBX_CONFLICT`/`SBX_ORPHAN`), per-stage boot telemetry, per-call `idleMinutes` |
| M2 🟢 | Input engine | `sandbox_smart_click` UIA-first ladder with per-action strategy reporting + effect checks; explicit `mode: text\|keys` typing; **acid test passed** (consent wall dismissed in 1 call — [lab findings](docs/lab-input-findings.md)); drag + scroll verified with CDP/window oracles |
| M3 ✅ | Power features | **CDP passthrough** (`sandbox_edge_debug` + DOM-level driving proven from the host), `sandbox_process_kill`, **`sandbox_guest_reboot`** (in-guest reboot, state persists, agent re-injected on the same epoch — 24 s measured), versioned report envelopes (`…-report@1`), ALLOWED_ROOTS hardening (unrestricted warning + untrusted-marked copy_out) |
| M4 🟡 | Delivery | [feature catalog](docs/features.md) with per-feature evidence; docs pages, CHANGELOG, releases + parity notes pending |

Non-goals: multi-guest concurrency (Windows allows one sandbox — we queue politely), malware
verdicts (detonate stays heuristic), non-Windows hosts.

## Quick start

Requirements: Windows 11 Pro/Enterprise/Education 24H2+ (build 26100+), Windows Sandbox enabled,
Node.js 20+. Run `sbx doctor` first — it checks all of this and tells you how to fix what's missing.

```bash
npm install
npm test                 # unit suite (no sandbox needed)
npm run test:handshake   # MCP stdio handshake: initialize + tools/list (no sandbox needed)
node src/cli.js doctor   # is this PC ready?
```

Live smoke (boots a real sandbox, ~1 min): `npm run smoke`.

### MCP configuration

```json
{
  "mcpServers": {
    "sandbox-win-mcp": {
      "command": "node",
      "args": ["D:/GIT/sandbox-win-mcp/src/server.js"]
    }
  }
}
```

Or the CLI: `node src/cli.js help`.

## Security posture

- **Guest outputs are untrusted data, always.** Everything written to the run `out/` folder is
  guest-writable; treat copied-out files as attacker-controlled.
- `SANDBOX_MCP_ALLOWED_ROOTS` (semicolon-separated) restricts which host paths may be copied
  **into** a sandbox. **Empty means unrestricted** — and says so: while it is empty, every
  `sandbox_copy_in`/`sandbox_deploy` result carries an explicit unrestricted-roots warning.
  Host-side reads of guest output are always confined to the run directory; `sandbox_copy_out`
  results are marked `untrusted: true`.
- One-shot reports (`sandbox_run`, `sandbox_install_test`, `sandbox_detonate`) write BOTH
  report.md and a versioned report.json envelope (`sandbox-win-mcp/<flow>-report@1`).
- The offline control channel is HKDF-derived, AES-256-CBC + HMAC-SHA256 framed, with replay
  protection and agent identity pinning (protocol version + SHA-256 of staged agent files).
- Detonate reports are heuristics, never a safety verdict.

## Upstream attribution

Forked from [sandbox-mcp](https://github.com/shanselman/sandbox-mcp) v1.2.0
(commit `b5ea2b2`), MIT — copyright and license terms in [LICENSE](LICENSE). The original architecture,
guest agent and evidence pipeline are preserved deliberately; upstream's docs and compatibility
measurements remain under [docs/](docs/). This project's changes are tracked in the fork's
history and summarized per release in parity notes (M4).

## License

MIT — see [LICENSE](LICENSE).
