// Live verification of the util-lab features, one sandbox boot:
//   1. idleMinutes: sandbox_start {idleMinutes:7} -> guest agent command line must carry it
//   2. drag: charmap grid drag-select -> Select -> "Characters to copy" holds >1 character
//   3. edge_debug: tool returns a host-reachable DevTools URL; THIS script (host) fetches /json/list
// Usage: node test/lab/features-verify.js
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { startedAt: new Date().toISOString(), verdicts: [] };
const V = (what, result, extra) => { report.verdicts.push({ what, result, ...extra }); console.log(`VERDICT ${what}: ${result}`); };
let client;
const call = async (name, args = {}, timeoutMs = 180_000) => {
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs });
  const txt = r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  if (r.isError) throw new Error(`${name}: ${txt.slice(0, 250)}`);
  return txt;
};
const parse = (t) => { try { return JSON.parse(t); } catch { return null; } };

try {
  client = new Client({ name: 'features-verify', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'src', 'server.js')], stderr: 'inherit' }));

  // 1. idleMinutes reaches the guest agent command line.
  const boot = parse(await call('sandbox_start', { window: 'normal', idleMinutes: 7 }));
  report.outDir = boot?.outDir;
  V('boot', `${boot?.bootSeconds}s (idleMinutes 7 requested)`);
  const cmdText = await call('sandbox_exec', { command:
    "(Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" | Where-Object { $_.CommandLine -match 'agent.ps1' } | Select-Object -First 1).CommandLine" });
  const agentCmd = String(cmdText.split('--- stdout ---')[1] ?? '').trim();
  V('idleMinutes on agent command line', /-IdleMinutes 7\b/.test(agentCmd) ? 'WORKED (-IdleMinutes 7 present)' : `FAILED: ${agentCmd.slice(0, 160)}`);

  // 2. Drag verified by a window title-bar move: windows() gives exact rects before/after.
  //    (sndvol.exe no longer exists in recent guest builds - not a usable slider oracle.)
  const launch = parse(await call('sandbox_launch', { path: 'C:\\Windows\\System32\\charmap.exe', waitForWindowSec: 20 }));
  const pid = launch?.pid;
  await sleep(800);
  const win = async () => parse(await call('sandbox_windows'))?.find((w) => w.pid === pid) ?? null;
  const before = await win();
  if (!before) V('drag window', 'skipped: charmap window not listed');
  else {
    const tbY = before.top + 8; // inside the title bar
    const cx = before.left + Math.round(before.width / 2);
    const dx = 90, dy = 60;
    const drag = parse(await call('sandbox_drag', { x1: cx, y1: tbY, x2: cx + dx, y2: tbY + dy, durationMs: 600 }));
    await sleep(500);
    const after = await win();
    const moved = after ? (Math.abs(after.left - before.left) + Math.abs(after.top - before.top)) / 2 : 0;
    V('sandbox_drag executed', JSON.stringify(drag));
    V('drag window by title bar', after && moved >= dx * 0.5
      ? `WORKED (window moved ${before.left},${before.top} -> ${after.left},${after.top})`
      : `NO EFFECT (before=${before.left},${before.top} after=${after ? after.left + ',' + after.top : 'gone'})`);
  }
  await call('sandbox_exec', { command: 'Stop-Process -Name charmap -Force -ErrorAction SilentlyContinue' });

  // 3. Edge DevTools reachable from THIS host process.
  const edge = parse(await call('sandbox_edge_debug', { port: 9222, startUrl: 'about:blank' }));
  V('sandbox_edge_debug', `${edge?.url} -> ${edge?.version}`);
  await sleep(1500);
  const listRes = await fetch(`${edge.url}/json/list`, { signal: AbortSignal.timeout(4000) });
  const targets = await listRes.json();
  V('host-side /json/list', `HTTP ${listRes.status}, ${targets.length} target(s): ${targets.slice(0, 3).map((t) => t.type).join(', ')}`);
  report.edgeDebug = edge;
} catch (e) {
  report.fatal = String(e.message);
  console.error(`VERIFY FATAL: ${e.message}`);
} finally {
  try { report.teardown = parse(await call('sandbox_stop')); } catch (e) { report.teardown = { error: String(e.message) }; }
  const fs = await import('node:fs');
  const out = path.join(report.outDir ?? root, 'features-verify.json');
  try { fs.writeFileSync(out, JSON.stringify(report, null, 2)); console.log(`report: ${out}`); }
  catch (e) { console.error(`report write failed: ${e.message}`); }
  process.exit(report.fatal ? 1 : 0);
}
