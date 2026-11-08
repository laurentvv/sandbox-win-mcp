// Batch B live verification: scroll (oracle = CDP window.scrollY over the guest's own Edge)
// and process_kill (launch charmap, kill by name and by pid, watch it disappear).
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

async function cdpEvaluate(base, expression) {
  const targets = await (await fetch(`${base}/json/list`, { signal: AbortSignal.timeout(4000) })).json();
  const page = targets.find((t) => t.type === 'page' && !/^devtools/i.test(t.url));
  if (!page) throw new Error('no page target');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = (e) => rej(new Error('ws error')); });
  const value = await new Promise((res, rej) => {
    ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id === 1) res(d.result?.result?.value); };
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
    setTimeout(() => rej(new Error('cdp eval timeout')), 5000);
  });
  ws.close();
  return { url: page.url, value };
}

try {
  client = new Client({ name: 'batch-b', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'src', 'server.js')], stderr: 'inherit' }));
  const boot = parse(await call('sandbox_start', { window: 'normal' }));
  report.outDir = boot?.outDir;
  V('boot', `${boot?.bootSeconds}s`);

  // --- scroll, oracle = CDP window.scrollY on a long real page ---
  const edge = parse(await call('sandbox_edge_debug', { port: 9222, startUrl: 'https://en.wikipedia.org/wiki/Windows_Sandbox' }));
  V('edge_debug', `${edge.url} (${edge.version})`);
  let page = null;
  for (let i = 0; i < 20 && !page; i++) {
    await sleep(1000);
    try { page = await cdpEvaluate(edge.url, 'window.scrollY'); } catch {}
  }
  V('cdp page', page ? `${page.url.slice(0, 60)} scrollY=${page.value}` : 'page never answered');
  if (page) {
    const beforeY = page.value ?? 0;
    const win = parse(await call('sandbox_windows'))?.find((w) => w.pid === edge.pid);
    const cx = Math.round((win?.left ?? 400) + (win?.width ?? 1200) / 2);
    const cy = Math.round((win?.top ?? 200) + (win?.height ?? 800) / 2);
    const scr = parse(await call('sandbox_scroll', { x: cx, y: cy, notches: -6 }));
    await sleep(800);
    const after = await cdpEvaluate(edge.url, 'window.scrollY');
    V('sandbox_scroll executed', JSON.stringify(scr));
    V('scroll moves a real web page', (after.value ?? 0) > beforeY
      ? `WORKED (scrollY ${beforeY} -> ${after.value})` : `NO EFFECT (scrollY ${beforeY} -> ${after?.value})`);
  }
  await call('sandbox_process_kill', { pid: edge.pid }).catch(() => {});

  // --- process_kill: by name, then by pid ---
  const c1 = parse(await call('sandbox_launch', { path: 'C:\\Windows\\System32\\charmap.exe', waitForWindowSec: 20 }));
  await sleep(500);
  const killedByName = parse(await call('sandbox_process_kill', { name: 'charmap' }));
  await sleep(400);
  const aliveAfterName = parse(await call('sandbox_process', { pid: c1.pid }));
  V('process_kill by name', killedByName?.stopped?.length && aliveAfterName?.hasExited
    ? `WORKED (stopped ${JSON.stringify(killedByName.stopped)}, pid ${c1.pid} exited)` : `FAILED (${JSON.stringify(killedByName)} / ${JSON.stringify(aliveAfterName)})`);

  const c2 = parse(await call('sandbox_launch', { path: 'C:\\Windows\\System32\\charmap.exe', waitForWindowSec: 20 }));
  await sleep(500);
  const killedByPid = parse(await call('sandbox_process_kill', { pid: c2.pid }));
  await sleep(400);
  const aliveAfterPid = parse(await call('sandbox_process', { pid: c2.pid }));
  V('process_kill by pid', killedByPid?.stopped?.length === 1 && aliveAfterPid?.hasExited
    ? 'WORKED' : `FAILED (${JSON.stringify(killedByPid)} / ${JSON.stringify(aliveAfterPid)})`);
} catch (e) {
  report.fatal = String(e.message);
  console.error(`VERIFY FATAL: ${e.message}`);
} finally {
  try { report.teardown = parse(await call('sandbox_stop')); } catch (e) { report.teardown = { error: String(e.message) }; }
  const fs = await import('node:fs');
  const out = path.join(report.outDir ?? root, 'batch-b-verify.json');
  try { fs.writeFileSync(out, JSON.stringify(report, null, 2)); console.log(`report: ${out}`); } catch {}
  process.exit(report.fatal ? 1 : 0);
}
