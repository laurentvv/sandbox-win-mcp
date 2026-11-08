# Input lab findings — baseline vs UIA-first engine (M2 first cut)

Experiments run 2026-11-08 on Windows 11 Pro build 26300, host Node 26.13.0, guest Windows
Sandbox 0.8.107.0 (guest locale follows the host: French). Harness: `test/lab/input-lab.js`
(spawns this fork's MCP server over stdio; every call timed and recorded; failures are data).
Evidence: `docs/evidence/lab/` (paths sanitized). Runs cited: `exp1` (baseline, pre-change),
`exp1c` (consent probe), `exp2` (engine), `exp2-rung` (ladder probe).

## 1. Baseline matrix (before any engine change)

| Target | Action | UIA pattern | Raw SendInput |
|---|---|---|---|
| charmap (Win32 dialog) | click Button "Select" | **invoke, ok** (128 ms) | — |
| charmap | click CheckBox "Advanced view" | toggle available | **pixel click WORKED** (state flipped, readback-verified) |
| regedit (Win32 tree) | select / expand TreeItem HKLM→SOFTWARE | **select ok, expand ok** (67-97 ms) | — |
| Edge (Chromium UI) | setvalue address bar `google.com` + Enter | **setvalue ok + Enter ok** (documented workaround revalidated; address bar = Edit `#view_1017`, name localized) |
| Edge (web content) | click consent "Tout refuser" | see §2 | see §2 |

Takeaway: **native Win32 is fully drivable both ways; web content is where it breaks.**

## 2. The consent wall, solved — and why lesson 4 existed

Fresh guest → Edge → `google.com` (EU egress) → French consent dialog. Findings:

1. The real button **is** exposed: `Button "Tout refuser" rect=[278,849,227,49] actions=["invoke"]`.
2. A loose name selector (`name contains "Tout refuser"`) matches the **explanatory Text
   paragraph** first — a node with no patterns. Clicking it (UIA mouse fallback) does nothing.
   This selector trap, not a UIA limitation, reproduced the pre-fork "UIA Invoke failed"
   observation (`did=mouse click` was the tell).
3. Chromium activates its accessibility tree **lazily**: a tree query (or any element resolve)
   wakes it. Acting blind on a never-queried window is unreliable.
4. With the button correctly selected and accessibility awake: **UIA InvokePattern dismisses the
   wall** — reproduced 3/3 runs (exp1c, exp2 twice), in 12-79 ms.

## 3. The engine (what shipped as `sandbox_smart_click`, v2.0.0-alpha.2)

Guest-side ladder in `agent/uia.cs::SmartClick`, one guest op, full report per action:

1. **UIA patterns**: Invoke → Toggle → Select → ExpandCollapse → LegacyIAccessible default
   action. A pattern that executes without throwing ends the ladder (patterns are authoritative).
2. **focus-enter**: UIA SetFocus + Enter — activates web content that swallows mouse input.
3. **sendinput-click**: focus-verified SendInput click at the element (focusVerified reported;
   honest false when the foreground could not be confirmed).

Every rung is recorded with ms and outcome; the winner gets an **effect check**
(verify: auto = element gone or state changed / gone / state / none). Machine-readable fields:
`strategy`, `attempts[]`, `verified`, `verifyNote`, `focusVerified`, `element`.

Also shipped: `sandbox_type` now takes an explicit `mode: "text" | "keys"` (lesson 5's ambiguous
`literal=true` default is gone; legacy `literal` maps for one release with a deprecation note;
unit-tested — 5 new tests, suite 102/102).

## 4. EXP-2 results (engine) and the acid test

- No regression on charmap/regedit/Edge vs baseline; boot 11.6 s (budget ≤15 s, baseline 9.98 s).
- **Acid test (definition of done for M2)**: fresh guest → Edge → google.com → consent wall →
  **dismissed in 1 tool call** (`smart_click "Tout refuser"` → `uia-invoke`, verified: element
  gone, 12 ms). Bar was ≤3 calls. Post-checks: button absent from tree; screenshot visually
  confirmed (google.com fully loaded, no dialog).
- Ladder probe on a pattern-less Text element (exp2-rung): rungs B and C execute, effect-check
  correctly rejects no-op attempts, `focusVerified: false` is reported honestly, overall
  `UNVERIFIED` — the engine never claims an effect it did not observe.

## 5. Follow-ups (M2 second cut candidates)

- Rung C focus: `SetForegroundWindow` can be denied to a background agent — consider
  `AttachThreadInput` or the Alt-key unlock trick when `focusVerified` is false.
- Auto-selector hardening: when several nodes match a name, prefer actionable ones
  (Button + invoke) before Text — currently the caller must pass `controlType`.
- The acid flow is a lab target today; promote it to a scripted regression
  (`test/consent-wall.js`) once M1's reliability work lands.
- Edge second-instance pitfall: Chromium hands new launches to the existing process and exits;
  resolve the live pid (the lab does; `sandbox_launch` callers should know).
