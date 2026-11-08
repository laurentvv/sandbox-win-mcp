// Utility battery: warm deploy loop (hash-verified incremental transfer) plus a recording
// round-trip around a real UI drive, in ONE sandbox boot. Reports every step as evidence.
// Usage: node test/lab/util-battery.js
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { lab: 'util-battery', startedAt: new Date().toISOString(), steps: [] };
let client;

async function call(name, args = {}, { timeoutMs = 180_000 } = {}) {
  const t = Date.now();
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs });
  const txt = r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  if (r.isError) throw new Error(`${name}: ${txt.slice(0, 200)}`);
  const rec = { tool: name, args, ms: Date.now() - t, text: txt.slice(0, 400) };
  report.steps.push(rec);
  console.log(`  [${rec.ms}ms] ${name}: ${txt.split('\n')[0].slice(0, 140)}`);
  return txt;
}
const parse = (t) => { try { return JSON.parse(t); } catch { return null; } };

// Stage a scratch host build dir: HelloSandbox binary + a marker file we will mutate.
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-deploy-'));
fs.cpSync(path.join(root, 'samples', 'HelloSandbox', 'bin'), stage, { recursive: true });
fs.writeFileSync(path.join(stage, 'marker.txt'), 'v1\n');

try {
  client = new Client({ name: 'util-battery', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'src', 'server.js')], stderr: 'inherit' }));
  const server = client.getServerVersion();
  if (server.name !== 'sandbox-win-mcp') throw new Error(`wrong server: ${server.name}`);
  report.server = server;

  const boot = parse(await call('sandbox_start', { window: 'normal' }));
  report.boot = boot;
  console.log(`boot ${boot?.bootSeconds}s -> ${boot?.outDir}`);

  // 1. Deploy cold (everything is new), then warm (nothing), then changed (marker v1 -> v2).
  const d1 = parse(await call('sandbox_deploy', { hostPath: stage, sandboxPath: 'C:\\apps\\HelloSandbox' }));
  report.deployCold = d1;
  const d2 = parse(await call('sandbox_deploy', { hostPath: stage, sandboxPath: 'C:\\apps\\HelloSandbox' }));
  report.deployWarm = d2;
  fs.writeFileSync(path.join(stage, 'marker.txt'), 'v2 - changed for the warm-loop proof\n');
  const d3 = parse(await call('sandbox_deploy', { hostPath: stage, sandboxPath: 'C:\\apps\\HelloSandbox' }));
  report.deployChanged = d3;
  report.deployVerdict = {
    cold: `${d1?.added} added, verified=${d1?.verified}`,
    warmNoop: `${d2?.changed} changed (expect 0), verified=${d2?.verified}`,
    changedOne: `${d3?.changed} changed (expect 1), verified=${d3?.verified}, ${d3?.bytesTransferred} B`,
  };

  // 2. Recording around a real UI drive: launch, smart-click Greet, screenshot, publish.
  const rec = parse(await call('sandbox_record_start', { fps: 2, maxDurationSec: 25 }));
  const launch = parse(await call('sandbox_launch', { path: 'C:\\apps\\HelloSandbox\\HelloSandbox.exe', waitForWindowSec: 20 }));
  await call('sandbox_smart_click', { pid: launch?.pid, automationId: 'NameBox', controlType: 'Edit', verify: 'state' }).catch(() => {});
  await call('sandbox_ui_action', { pid: launch?.pid, automationId: 'NameBox', action: 'setvalue', value: 'util-battery' });
  await call('sandbox_smart_click', { pid: launch?.pid, name: 'Greet', controlType: 'Button' });
  await sleep(1500);
  await call('sandbox_screenshot', { pid: launch?.pid, name: 'battery-after-greet' });
  await call('sandbox_exec', { command: 'Stop-Process -Name HelloSandbox -Force -ErrorAction SilentlyContinue' });
  const pub = parse(await call('sandbox_record_stop'));
  report.recording = { started: !!rec?.recordingId, published: pub?.htmlPath, frames: pub?.frames, mp4: pub?.mp4Path ?? null };
  console.log(`recording published: ${pub?.htmlPath}`);
} catch (e) {
  report.fatal = String(e.message);
  console.error(`BATTERY FATAL: ${e.message}`);
} finally {
  try { report.teardown = parse(await call('sandbox_stop')); } catch (e) { report.teardown = { error: String(e.message) }; }
  const file = path.join(report.boot?.outDir ?? root, 'util-battery.json');
  try { fs.writeFileSync(file, JSON.stringify(report, null, 2)); console.log(`report: ${file}`); } catch {}
  console.log('VERDICT deploy:', JSON.stringify(report.deployVerdict));
  console.log('VERDICT recording:', JSON.stringify(report.recording));
  process.exit(report.fatal ? 1 : 0);
}
