// Input-control laboratory: boots this fork's MCP server over stdio and runs a battery of
// UI-control experiments, recording per call which strategy worked (UIA pattern vs raw input).
// Experiment failures are DATA, not lab failures: the lab exits 0 if it ran to completion.
//
// Usage: node test/lab/input-lab.js [--tag exp1] [--only charmap,regedit,edge] [--keep]
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1]?.startsWith('--') ? true : process.argv[i + 1]) ?? true : def;
};
const TAG = String(arg('tag', 'run'));
const ONLY = String(arg('only', 'charmap,regedit,edge,acid')).split(',');
const KEEP = Boolean(arg('keep', false));
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const report = { lab: 'input-lab', tag: TAG, startedAt: new Date().toISOString(), server: null, boot: null, targets: [], teardown: null };
let client = null;
let seq = 0;

async function call(name, args = {}, { timeoutMs = 120_000, note = '' } = {}) {
  const t = Date.now();
  const rec = { seq: ++seq, tool: name, args, note };
  try {
    const r = await client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs });
    const txt = r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    rec.ok = !r.isError;
    rec.ms = Date.now() - t;
    rec.text = txt.slice(0, 500);
    // Machine-readable strategy capture: input tools report "did:" / strategy fields.
    const did = txt.match(/^(?<d>[\w ]+): (?:pending|Button|Edit|CheckBox||TreeItem|ListItem|MenuItem|ComboBox|Text|TitleBar|Hyperlink|TabItem|Document|Pane|Custom)/m);
    if (did) rec.did = did.groups.d.trim();
    if (!rec.ok) rec.error = txt.slice(0, 300);
    return txt;
  } catch (e) {
    rec.ok = false; rec.ms = Date.now() - t; rec.error = String(e.message).slice(0, 300);
    throw Object.assign(e, { labRecord: rec });
  } finally {
    report.targets.at(-1)?.steps.push(rec);
    console.log(`  [${rec.ms}ms] ${name}${note ? ` (${note})` : ''} ${rec.ok ? 'ok' : 'FAIL'}${rec.did ? ` did=${rec.did}` : ''}${rec.ok ? '' : ` :: ${rec.error ?? ''}`}`);
  }
}

async function tryCall(name, args, opts) { try { return await call(name, args, opts); } catch { return null; } }

function parseJson(txt) { try { return JSON.parse(txt); } catch { return null; } }

/** UIA tree nodes carry rect: [left, top, width, height] in screen pixels. */
function rectCenter(n) {
  if (!Array.isArray(n?.rect) || n.rect.length < 4 || n.rect.some((v) => !Number.isFinite(v))) return null;
  const [x, y, w, h] = n.rect;
  if (w <= 0 || h <= 0) return null;
  return { cx: Math.round(x + w / 2), cy: Math.round(y + h / 2) };
}

// ---------- targets ----------

async function targetCharMap() {
  const T = { name: 'charmap', steps: [], verdicts: [] };
  report.targets.push(T);
  console.log('\n== charmap (pure Win32 dialog) ==');
  const launch = parseJson(await call('sandbox_launch', { path: 'C:\\Windows\\System32\\charmap.exe', waitForWindowSec: 20 })) ?? {};
  const pid = launch.pid;
  await call('sandbox_screenshot', { pid, name: 'charmap-before' });
  const tree = parseJson(await tryCall('sandbox_ui_tree', { pid, json: true, depth: 8 }));
  const nodes = tree?.nodes ?? [];
  T.verdicts.push({ what: 'uia tree visible', result: `${nodes.length} nodes`, sample: nodes.slice(0, 8) });
  const find = (re, types) => nodes.find((n) => types.includes(n.type) && re.test(n.name || ''));

  // 1. UIA click on the Select button (expect InvokePattern).
  const select = find(/^(Select|Sélectionner)$/, ['Button']);
  if (select) {
    const r = await tryCall('sandbox_ui_action', { pid, name: select.name, controlType: 'Button' }, { note: 'UIA click Select' });
    T.verdicts.push({ what: 'UIA click on Win32 Button', result: r ? 'ok' : 'failed', detail: r?.slice(0, 120) });
  } else T.verdicts.push({ what: 'UIA click on Win32 Button', result: 'skipped: Select button not found in tree' });

  // 2. UIA toggle Advanced view ON (needed for the Search edit), then setvalue + readback.
  const adv = find(/(Advanced view|Affichage avancé)/, ['CheckBox']);
  if (adv) {
    const before = await tryCall('sandbox_ui_action', { pid, name: adv.name, controlType: 'CheckBox', action: 'read' });
    let on = /\[x\]/.test(before ?? '');
    if (!on) { await tryCall('sandbox_ui_action', { pid, name: adv.name, controlType: 'CheckBox', action: 'toggle' }, { note: 'UIA toggle Advanced view on' }); await sleep(400); on = true; }
    const tree2 = parseJson(await tryCall('sandbox_ui_tree', { pid, json: true, depth: 8 })) ?? { nodes: [] };
    const edit = (tree2.nodes ?? []).find((n) => n.type === 'Edit' && /(Search|Rechercher)/i.test(n.name || ''));
    if (edit) {
      await tryCall('sandbox_ui_action', { pid, name: edit.name, controlType: 'Edit', action: 'setvalue', value: 'alpha' }, { note: 'UIA setvalue Search' });
      const read = await tryCall('sandbox_ui_action', { pid, name: edit.name, controlType: 'Edit', action: 'read' });
      T.verdicts.push({ what: 'UIA setvalue + readback on Win32 Edit', result: /alpha/.test(read ?? '') ? 'WORKED' : 'NO EFFECT', detail: read?.slice(0, 100) });
    } else T.verdicts.push({ what: 'UIA setvalue + readback on Win32 Edit', result: 'skipped: Search edit not found' });

    // 3. SendInput baseline on the checkbox, verified by toggle-state readback (then restore).
    const c = rectCenter(adv);
    if (c) {
      const pre = await tryCall('sandbox_ui_action', { pid, name: adv.name, controlType: 'CheckBox', action: 'read' });
      const preOn = /\[x\]/.test(pre ?? '');
      await tryCall('sandbox_click', { x: c.cx, y: c.cy, coordinates: 'screen' }, { note: `SendInput click on ${adv.name} @${c.cx},${c.cy}` });
      await sleep(400);
      const post = await tryCall('sandbox_ui_action', { pid, name: adv.name, controlType: 'CheckBox', action: 'read' });
      const postOn = /\[x\]/.test(post ?? '');
      T.verdicts.push({ what: 'SendInput pixel click on Win32 CheckBox (state readback)', result: preOn !== postOn ? 'WORKED (state flipped)' : 'NO EFFECT', detail: `${pre?.slice(0, 60)} -> ${post?.slice(0, 60)}` });
      if (preOn !== postOn) await tryCall('sandbox_ui_action', { pid, name: adv.name, controlType: 'CheckBox', action: 'toggle' }, { note: 'restore state' });
    } else T.verdicts.push({ what: 'SendInput pixel click on Win32 CheckBox', result: 'skipped: node carried no rect', node: adv });
  } else T.verdicts.push({ what: 'SendInput pixel click on Win32 CheckBox', result: 'skipped: Advanced view checkbox not found (locale?)' });

  // 4. Ladder exercise on a pattern-less element (static Text): rungs B (focus+Enter) and
  //    C (focus-verified SendInput) must run and report, since no pattern can win.
  const label = nodes.find((n) => n.type === 'Text' && (n.name || '').length > 5);
  if (label) {
    const r = await tryCall('sandbox_smart_click', { pid, name: label.name, controlType: 'Text' }, { note: 'ladder on pattern-less Text' });
    T.verdicts.push({ what: 'smart_click ladder on pattern-less Text (rungs B/C live)', result: (r ?? 'error').split('\n').slice(0, 4).join(' | ').slice(0, 320) });
  }

  await call('sandbox_screenshot', { pid, name: 'charmap-after' });
  await tryCall('sandbox_exec', { command: `Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue` });
}

async function targetRegEdit() {
  const T = { name: 'regedit', steps: [], verdicts: [] };
  report.targets.push(T);
  console.log('\n== regedit (Win32 tree view) ==');
  const launch = parseJson(await call('sandbox_launch', { path: 'regedit.exe', waitForWindowSec: 20 })) ?? {};
  const pid = launch.pid;
  await sleep(1500);
  const tree = parseJson(await tryCall('sandbox_ui_tree', { pid, json: true, depth: 6 })) ?? { nodes: [] };
  const hklm = (tree.nodes ?? []).find((n) => n.type === 'TreeItem' && /HKEY_LOCAL_MACHINE/i.test(n.name || ''));
  T.verdicts.push({ what: 'tree items exposed via UIA', result: hklm ? 'HKLM TreeItem found' : 'NOT FOUND', nodes: (tree.nodes ?? []).length });

  if (hklm) {
    const sel = await tryCall('sandbox_ui_action', { pid, name: hklm.name, controlType: 'TreeItem', action: 'select' }, { note: 'UIA select HKLM' });
    T.verdicts.push({ what: 'UIA SelectionItemPattern on TreeItem', result: sel ? 'ok' : 'failed', detail: sel?.slice(0, 120) });
    const exp = await tryCall('sandbox_ui_action', { pid, name: hklm.name, controlType: 'TreeItem', action: 'expand' }, { note: 'UIA expand HKLM' });
    T.verdicts.push({ what: 'UIA ExpandCollapsePattern on TreeItem', result: exp ? 'ok' : 'failed', detail: exp?.slice(0, 120) });
    await sleep(500);
    const tree2 = parseJson(await tryCall('sandbox_ui_tree', { pid, json: true, depth: 7 })) ?? { nodes: [] };
    const soft = (tree2.nodes ?? []).find((n) => n.type === 'TreeItem' && /(^|\\)SOFTWARE$/i.test(n.name || ''));
    if (soft) {
      const sel2 = await tryCall('sandbox_ui_action', { pid, name: soft.name, controlType: 'TreeItem', action: 'select' });
      T.verdicts.push({ what: 'UIA select child TreeItem (SOFTWARE)', result: sel2 ? 'ok' : 'failed' });
    }
  }
  await call('sandbox_screenshot', { pid, name: 'regedit-after' });
  await tryCall('sandbox_exec', { command: `Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue` });
}

async function targetEdge() {
  const T = { name: 'edge', steps: [], verdicts: [] };
  report.targets.push(T);
  console.log('\n== edge (Chromium: UI chrome + web content) ==');
  const pathOut = await tryCall('sandbox_exec', { command:
    `@("\${env:ProgramFiles(x86)}\\Microsoft\\Edge\\Application\\msedge.exe", "$env:ProgramFiles\\Microsoft\\Edge\\Application\\msedge.exe", "$env:LOCALAPPDATA\\Microsoft\\Edge\\Application\\msedge.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1; if (-not ($?)) { '' }` });
  const edgePath = (pathOut ?? '').split('--- stdout ---')[1]?.trim().split('\n')[0]?.trim();
  if (!edgePath) { T.verdicts.push({ what: 'edge', result: 'msedge.exe not found in guest' }); return; }
  T.verdicts.push({ what: 'msedge path', result: edgePath });

  const launch = parseJson(await call('sandbox_launch',
    { path: edgePath, args: '--no-first-run --no-default-browser-check about:blank', waitForWindowSec: 30 })) ?? {};
  const pid = launch.pid;
  await sleep(3000);
  await call('sandbox_screenshot', { pid, name: 'edge-blank' });

  // Phase A - the documented workaround: UIA setvalue on the address bar + Enter.
  const tree = parseJson(await tryCall('sandbox_ui_tree', { pid, json: true, depth: 10 })) ?? { nodes: [] };
  const nodes = tree.nodes ?? [];
  T.verdicts.push({ what: 'edge UI tree size', result: `${nodes.length} nodes`, truncated: !!tree.truncated });
  const addr = nodes.find((n) => n.type === 'Edit' && /(address|search|adresse|rechercher)/i.test(n.name || ''))
    ?? nodes.find((n) => n.type === 'Edit' && /view_1013/.test(n.automationId || ''))
    ?? nodes.find((n) => n.type === 'Edit');
  if (addr) {
    const set = await tryCall('sandbox_ui_action', { pid, name: addr.name || undefined, automationId: addr.automationId, controlType: 'Edit', action: 'setvalue', value: 'google.com' }, { note: 'UIA setvalue address bar' });
    T.verdicts.push({ what: 'UIA setvalue on Edge address bar', result: set ? 'ok' : 'failed', detail: set?.slice(0, 120) });
    const enter = await tryCall('sandbox_type', { keys: '{ENTER}', mode: 'keys', pid }, { note: 'Enter via keys mode' });
    T.verdicts.push({ what: 'keys-mode Enter to focused Edge window', result: enter ? 'ok' : 'failed' });
  } else T.verdicts.push({ what: 'UIA setvalue on Edge address bar', result: 'skipped: no Edit found in tree' });

  await sleep(9000); // let google.com load (and the EU consent wall appear, if any)
  await call('sandbox_screenshot', { pid, name: 'edge-google-loaded' });
  if (addr) {
    const url = await tryCall('sandbox_ui_action', { pid, name: addr.name || undefined, automationId: addr.automationId, controlType: 'Edit', action: 'read' });
    T.verdicts.push({ what: 'current URL via address-bar readback', result: (url ?? '').slice(0, 160) });
  }

  // Phase B - the acid scenario: dismiss the consent wall.
  const scan = () => tryCall('sandbox_ui_tree', { pid, json: true, depth: 16, maxNodes: 1200 }).then((t) => (parseJson(t) ?? { nodes: [] }).nodes ?? []);
  const REJECT = /(Reject all|Tout refuser|Refuser tout)/i;
  const n2 = await scan();
  const hits = n2.filter((n) => REJECT.test(n.name || ''));
  T.verdicts.push({ what: 'consent wall nodes matching reject-terms (ALL types)', result: `${hits.length} node(s)`, nodes: hits.map(({ type, name, rect, actions, automationId }) => ({ type, name: (name || '').slice(0, 70), rect, actions, automationId })).slice(0, 20) });
  // Actionable candidate: exact-name Button first, then contains-name Button, then Hyperlink with invoke.
  const btn = hits.find((n) => n.type === 'Button' && REJECT.test(n.name || '') && (n.actions ?? []).includes('invoke'))
    ?? hits.find((n) => n.type === 'Button' && REJECT.test(n.name || ''))
    ?? hits.find((n) => n.type === 'Hyperlink' && REJECT.test(n.name || ''));
  if (!btn) {
    T.verdicts.push({ what: 'consent wall actionable button', result: 'NO actionable Button/Hyperlink node in tree (iframe bridging gap?)' });
    await call('sandbox_screenshot', { pid, name: 'edge-consent-state' });
    return;
  }
  T.verdicts.push({ what: 'consent wall actionable button', result: `selected ${btn.type}: ${JSON.stringify(btn.name?.slice(0, 50))} rect=${JSON.stringify(btn.rect)} actions=${JSON.stringify(btn.actions)}` });
  const stillUp = async () => (await scan()).some((n) => REJECT.test(n.name || ''));

  // B1: UIA pattern click (lesson 4 predicts failure on the consent iframe).
  const uiaClick = await tryCall('sandbox_ui_action', { pid, name: btn.name, controlType: btn.type }, { note: 'UIA click Reject-all' });
  await sleep(3000);
  const b1gone = !(await stillUp());
  T.verdicts.push({ what: 'B1 UIA pattern click on consent button', result: b1gone ? 'WORKED (dialog gone)' : 'NO EFFECT (still present)', detail: uiaClick?.slice(0, 140) });
  await call('sandbox_screenshot', { pid, name: 'edge-after-B1-uia' });

  // B2: verified pixel click at the button's screen rect.
  if (!b1gone) {
    const c = rectCenter(btn);
    if (c) {
      await tryCall('sandbox_click', { x: c.cx, y: c.cy, coordinates: 'screen' }, { note: `SendInput click @${c.cx},${c.cy}` });
      await sleep(4000);
      const b2gone = !(await stillUp());
      T.verdicts.push({ what: 'B2 SendInput pixel click on consent button', result: b2gone ? 'WORKED (dialog gone)' : 'NO EFFECT' });
      await call('sandbox_screenshot', { pid, name: 'edge-after-B2-pixel' });

      // B3: keyboard activation - UIA SetFocus on the button + Enter (the setvalue+Enter analogue).
      if (!b2gone) {
        await tryCall('sandbox_ui_action', { pid, name: btn.name, controlType: btn.type, action: 'focus' }, { note: 'UIA SetFocus on consent button' });
        await tryCall('sandbox_type', { keys: '{ENTER}', literal: false, pid }, { note: 'Enter after UIA focus' });
        await sleep(4000);
        const b3gone = !(await stillUp());
        T.verdicts.push({ what: 'B3 UIA SetFocus + Enter on consent button', result: b3gone ? 'WORKED (dialog gone)' : 'NO EFFECT' });
        await call('sandbox_screenshot', { pid, name: 'edge-after-B3-focus-enter' });
      }
    } else T.verdicts.push({ what: 'B2 SendInput pixel click on consent button', result: 'skipped: no rect on button node' });
  }
  await tryCall('sandbox_exec', { command: 'Stop-Process -Name msedge -Force -ErrorAction SilentlyContinue' }, { note: 'edge cleanup' });
  await sleep(1000);
}

async function targetAcid() {
  // The product path, no hand-holding: Edge -> google.com -> consent wall -> sandbox_smart_click.
  // Counts tool calls from the moment the wall is up: the acid bar is <=3.
  const T = { name: 'acid', steps: [], verdicts: [] };
  report.targets.push(T);
  console.log('\n== acid: Edge -> google.com -> consent -> sandbox_smart_click ==');
  const pathOut = await tryCall('sandbox_exec', { command:
    `@("\${env:ProgramFiles(x86)}\\Microsoft\\Edge\\Application\\msedge.exe", "$env:ProgramFiles\\Microsoft\\Edge\\Application\\msedge.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1` });
  const edgePath = (pathOut ?? '').split('--- stdout ---')[1]?.trim().split('\n')[0]?.trim();
  if (!edgePath) { T.verdicts.push({ what: 'acid', result: 'msedge.exe not found' }); return; }
  const launch = parseJson(await call('sandbox_launch', { path: edgePath, args: '--no-first-run --no-default-browser-check about:blank', waitForWindowSec: 30 })) ?? {};
  let pid = launch.pid;
  await sleep(2500);
  pid = (await liveEdgePid()) ?? pid; // the launcher pid may have handed off to an existing instance
  T.verdicts.push({ what: 'acid live edge pid', result: String(pid) });
  const tree = parseJson(await tryCall('sandbox_ui_tree', { pid, json: true, depth: 10 })) ?? { nodes: [] };
  const addr = (tree.nodes ?? []).find((n) => n.type === 'Edit' && /(address|search|adresse|rechercher)/i.test(n.name || ''))
    ?? (tree.nodes ?? []).find((n) => n.type === 'Edit');
  if (!addr) { T.verdicts.push({ what: 'acid navigation', result: 'no address bar found' }); return; }
  await tryCall('sandbox_ui_action', { pid, name: addr.name || undefined, automationId: addr.automationId, controlType: 'Edit', action: 'setvalue', value: 'google.com' });
  await tryCall('sandbox_type', { keys: '{ENTER}', mode: 'keys', pid });
  await sleep(9000);
  await call('sandbox_screenshot', { pid, name: 'acid-wall-up' });

  let dismissalCalls = 0, winner = null;
  for (const candidate of ['Tout refuser', 'Reject all', 'Refuser tout']) {
    dismissalCalls++;
    const r = await tryCall('sandbox_smart_click', { pid, name: candidate, controlType: 'Button', verify: 'gone' }, { note: `smart_click "${candidate}"` });
    if (r) {
      const strat = (r.match(/^(?<s>\S+) \((?:verified|UNVERIFIED)/) ?? {}).groups?.s;
      const verified = !/UNVERIFIED/.test(r.split('\n')[0]);
      T.verdicts.push({ what: `smart_click candidate "${candidate}"`, result: r.split('\n').slice(0, 3).join(' | ').slice(0, 220) });
      if (verified) { winner = { candidate, strategy: strat, text: r }; break; }
      // Element may genuinely not exist for this candidate (locale) - keep trying the next name.
    } else dismissalCalls--; // errored (no match): doesn't count as an attempt on the wall
  }
  T.verdicts.push({ what: 'ACID RESULT', result: winner
    ? `DISMISSED in ${dismissalCalls} dismissal call(s); strategy=${winner.strategy} candidate="${winner.candidate}" (${dismissalCalls <= 3 ? 'WITHIN <=3 bar' : 'over bar'})`
    : `NOT dismissed after ${dismissalCalls} call(s)` });

  const after = parseJson(await tryCall('sandbox_ui_tree', { pid, json: true, depth: 14, maxNodes: 800 })) ?? { nodes: [] };
  const stillThere = (after.nodes ?? []).some((n) => /(Reject all|Tout refuser|Refuser tout)/i.test(n.name || ''));
  T.verdicts.push({ what: 'post-check: reject-button still in tree', result: String(stillThere) });
  await call('sandbox_screenshot', { pid, name: 'acid-final' });
}

/** Chromium hands a second launch to the existing instance and exits: resolve the live pid. */
async function liveEdgePid() {
  const out = await tryCall('sandbox_exec', { command:
    '(Get-Process msedge -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1).Id' });
  const id = Number((out ?? '').split('--- stdout ---')[1]?.trim().split('\n')[0]);
  return Number.isFinite(id) && id > 0 ? id : null;
}

// ---------- main ----------

try {
  client = new Client({ name: 'input-lab', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'src', 'server.js')], stderr: 'inherit' }));
  const server = client.getServerVersion();
  if (server.name !== 'sandbox-win-mcp') throw new Error(`wrong server: ${server.name}`);
  report.server = server;
  console.log(`input-lab [${TAG}] against ${server.name} ${server.version}`);

  const boot = parseJson(await call('sandbox_start', { window: 'normal' }));
  report.boot = boot;
  report.outDir = boot?.outDir;
  console.log(`boot: ${boot?.bootSeconds}s; out: ${boot?.outDir}`);

  if (ONLY.includes('charmap')) await targetCharMap();
  if (ONLY.includes('regedit')) await targetRegEdit();
  if (ONLY.includes('edge')) await targetEdge();
  if (ONLY.includes('acid')) await targetAcid();
} catch (e) {
  report.fatal = String(e.message);
  console.error(`LAB FATAL: ${e.message}`);
} finally {
  if (!KEEP) {
    try { report.teardown = parseJson(await call('sandbox_stop')) ?? {}; } catch (e) { report.teardown = { error: String(e.message) }; }
  } else report.kept = true;
  const file = path.join(report.outDir ?? root, `lab-${TAG}.json`);
  try { fs.writeFileSync(file, JSON.stringify(report, null, 2)); console.log(`\nreport: ${file}`); } catch (e) { console.error(`report write failed: ${e.message}`); }
  const verdicts = report.targets.flatMap((t) => t.verdicts.map((v) => `[${t.name}] ${v.what}: ${v.result}`));
  console.log('\n== VERDICTS ==\n' + verdicts.join('\n'));
  process.exit(report.fatal ? 1 : 0);
}
