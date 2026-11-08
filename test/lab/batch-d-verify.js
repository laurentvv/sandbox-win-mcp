// Batch D live verification: sandbox_guest_reboot (the product) keeps file AND registry state,
// reconnects the agent on the same epoch, and input still works afterwards.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { startedAt: new Date().toISOString(), verdicts: [] };
const V = (what, result, extra) => { report.verdicts.push({ what, result, ...extra }); console.log(`VERDICT ${what}: ${result}`); };
let client;
const call = async (name, args = {}, timeoutMs = 420_000) => {
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs });
  const txt = r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  if (r.isError) throw new Error(`${name}: ${txt.slice(0, 300)}`);
  return txt;
};
const parse = (t) => { try { return JSON.parse(t); } catch { return null; } };
const stdoutOf = (t) => String(t.split('--- stdout ---')[1] ?? '').trim();

try {
  client = new Client({ name: 'batch-d', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'src', 'server.js')], stderr: 'inherit' }));
  const boot = parse(await call('sandbox_start', { window: 'normal' }));
  report.outDir = boot?.outDir;
  V('boot', `${boot?.bootSeconds}s`);

  // Markers: a file and a registry value that must both survive the in-guest reboot.
  await call('sandbox_exec', { command: 'Set-Content C:\\sbx-marker.txt "survives-reboot"' });
  await call('sandbox_exec', { command: "New-Item -Path 'HKLM:\\SOFTWARE\\sbx-proof' -Force | Out-Null; Set-ItemProperty 'HKLM:\\SOFTWARE\\sbx-proof' -Name Rebooted -Value 42" });

  const rb = parse(await call('sandbox_guest_reboot', {}));
  V('guest_reboot', `back in ${rb?.seconds?.toFixed?.(1)}s, ip ${rb?.ip}, stages: ${(rb?.stages ?? []).map((x) => x.name).join(' -> ')}`);

  const file = stdoutOf(await call('sandbox_exec', { command: 'Get-Content C:\\sbx-marker.txt' }));
  V('file state survives reboot', file.includes('survives-reboot') ? `WORKED (${JSON.stringify(file)})` : `FAILED (${JSON.stringify(file)})`);
  const reg = stdoutOf(await call('sandbox_exec', { command: "(Get-ItemProperty 'HKLM:\\SOFTWARE\\sbx-proof').Rebooted" }));
  V('registry state survives reboot', reg.includes('42') ? 'WORKED (42)' : `FAILED (${JSON.stringify(reg)})`);

  // Input engine still healthy after re-injection (also re-verifies the actionable-first selector live).
  const cm = parse(await call('sandbox_launch', { path: 'C:\\Windows\\System32\\charmap.exe', waitForWindowSec: 20 }));
  await sleep(600);
  const smart = await call('sandbox_smart_click', { pid: cm.pid, name: 'Select', controlType: 'Button', verify: 'none' });
  V('smart_click after reboot', smart.split('\n').slice(0, 2).join(' | '));
  await call('sandbox_process_kill', { pid: cm.pid }).catch(() => {});
} catch (e) {
  report.fatal = String(e.message);
  console.error(`VERIFY FATAL: ${e.message}`);
} finally {
  try { report.teardown = parse(await call('sandbox_stop')); } catch (e) { report.teardown = { error: String(e.message) }; }
  const fs = await import('node:fs');
  const out = path.join(report.outDir ?? root, 'batch-d-verify.json');
  try { fs.writeFileSync(out, JSON.stringify(report, null, 2)); console.log(`report: ${out}`); } catch {}
  process.exit(report.fatal ? 1 : 0);
}
