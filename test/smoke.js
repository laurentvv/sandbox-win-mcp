// End-to-end smoke test: drives the real MCP server over stdio through the full
// build -> start -> copy in -> launch -> type -> click -> screenshot -> verify -> copy out -> stop loop.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appDir = path.join(root, 'samples', 'HelloSandbox', 'bin');
const t0 = Date.now();
const say = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);

say('building HelloSandbox on the host');
execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'samples', 'HelloSandbox', 'build.ps1')], { stdio: 'inherit' });

const client = new Client({ name: 'smoke', version: '1.0.0' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'src', 'server.js')], stderr: 'inherit', env: { ...process.env } }));
say(`tools: ${(await client.listTools()).tools.map((t) => t.name).join(', ')}`);

async function call(name, args = {}) {
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 600_000 });
  const txt = r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  const imgs = r.content.filter((c) => c.type === 'image').length;
  say(`${name} ${r.isError ? 'ERROR' : 'ok'}${imgs ? ` [${imgs} image]` : ''}: ${txt.slice(0, 400)}`);
  if (r.isError) throw new Error(`${name} failed`);
  return { r, txt };
}

let failed = false;
try {
  const start = JSON.parse((await call('sandbox_start', { window: 'normal' })).txt);
  await call('sandbox_exec', { command: '[Environment]::OSVersion.VersionString; whoami; Test-Path D:\\github' });
  await call('sandbox_copy_in', { hostPath: appDir, sandboxPath: 'C:\\apps\\HelloSandbox' });
  await call('sandbox_launch', { path: 'C:\\apps\\HelloSandbox\\HelloSandbox.exe', waitForWindowSec: 20 });
  // Click into the text box (top of the client area), type, then click the big Greet button.
  const win = JSON.parse((await call('sandbox_windows')).txt).find((w) => w.title === 'Hello Sandbox');
  await call('sandbox_click', { x: win.left + win.width / 2, y: win.top + win.height * 0.16, coordinates: 'screen' });
  await call('sandbox_type', { keys: 'Scott (from an MCP server)' });
  await call('sandbox_click', { x: win.left + win.width / 2, y: win.top + win.height * 0.8, coordinates: 'screen' });
  await call('sandbox_screenshot', { windowTitle: 'Hello Sandbox', name: 'after-greet' });
  await call('sandbox_screenshot', { name: 'desktop' });

  const check = await call('sandbox_exec', { command: 'Get-Content C:\\apps\\HelloSandbox\\greeting.txt' });
  if (!check.txt.includes('Hello, Scott (from an MCP server)!')) throw new Error('greeting.txt has unexpected content');

  // Same flow again by control name, through UI Automation instead of pixels.
  const tree = (await call('sandbox_ui_tree', { windowTitle: 'Hello Sandbox' })).txt;
  if (!tree.includes('#GreetButton')) throw new Error('UI tree is missing GreetButton');
  await call('sandbox_ui_action', { windowTitle: 'Hello Sandbox', automationId: 'NameBox', action: 'setvalue', value: 'UIA' });
  await call('sandbox_ui_action', { windowTitle: 'Hello Sandbox', name: 'Greet', controlType: 'Button' });
  await call('sandbox_ui_wait', { windowTitle: 'Hello Sandbox', automationId: 'Output', name: 'Hello, UIA!', timeoutSec: 10 });

  const out = JSON.parse((await call('sandbox_copy_out', { sandboxPath: 'C:\\apps\\HelloSandbox\\greeting.txt' })).txt);
  const copied = fs.readFileSync(out.hostPath, 'utf8');
  say(`host copy: ${copied}`);
  if (!copied.includes('Hello, UIA!')) throw new Error('copied greeting.txt has unexpected content');
  say(`boot took ${start.bootSeconds}s`);
} catch (e) {
  failed = true;
  console.error(e);
} finally {
  try { await call('sandbox_stop'); } catch (e) { failed = true; console.error('Sandbox teardown failed:', e); }
  await client.close();
}
say(failed ? 'SMOKE TEST FAILED' : 'SMOKE TEST PASSED');
process.exit(failed ? 1 : 0);
