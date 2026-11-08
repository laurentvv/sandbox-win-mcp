// Real Sandbox proof. Caller must acquire the host-wide Sandbox coordination lock first.
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import * as sbx from '../src/core.js';
import path from 'node:path';
import { atomicJson, readJson, withStateLock } from '../src/coordination.js';
import { protocolProof } from './protocol-proof.js';

const run = promisify(execFile);
const cli = (command, ...args) => run(process.execPath, [path.join(sbx.ROOT, 'src', 'cli.js'), command, '--json', ...args], { timeout: 120_000 });
execFileSync('powershell.exe', ['-NoProfile', '-File', path.join(sbx.ROOT, 'samples', 'HelloSandbox', 'build.ps1')], { stdio: 'inherit' });
for (const network of ['on', 'firewall', 'off']) {
  const client = new Client({ name: 'coordination-smoke', version: '1' });
  await client.connect(new StdioClientTransport({
    command: process.execPath, args: [path.join(sbx.ROOT, 'src', 'server.js')], stderr: 'inherit',
    env: { ...process.env },
  }));
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 180_000 });
    const text = r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    assert.ok(!r.isError, text);
    return text;
  };
  let started = false;
  try {
    const start = await sbx.startSandbox({ network });
    started = true;
    await protocolProof(await sbx.current());
    assert.equal(JSON.parse(await call('sandbox_status')).running, true);
    await Promise.all(Array.from({ length: 5 }, (_, i) => i % 2
      ? call('sandbox_exec', { command: `"mcp-${i}"` })
      : cli('exec', `"cli-${i}"`)));
    if (network === 'off') {
      withStateLock(sbx.HOME, () => {
        const file = path.join(sbx.HOME, 'current.json');
        const state = readJson(file);
        state.mailboxSeq++; // Simulate a writer killed after its durable reservation.
        atomicJson(file, state);
      });
      const gapStart = Date.now();
      assert.match(await call('sandbox_exec', { command: '"after-gap"' }), /after-gap/);
      assert.ok(Date.now() - gapStart < 30_000, 'crashed-writer gap did not recover within 30 seconds');
      console.log(`offline crashed-writer gap recovered in ${Date.now() - gapStart}ms`);
    }
    await Promise.all([
      call('sandbox_copy_in', { hostPath: path.join(sbx.ROOT, 'samples', 'HelloSandbox', 'bin'), sandboxPath: 'C:\\apps\\hello' }),
      cli('push', path.join(sbx.ROOT, 'LICENSE'), 'C:\\apps\\license.txt'),
    ]);
    await call('sandbox_launch', { path: 'C:\\apps\\hello\\HelloSandbox.exe' });
    await call('sandbox_ui_action', { windowTitle: 'Hello Sandbox', automationId: 'NameBox', action: 'setvalue', value: 'Shared guest' });
    await call('sandbox_ui_action', { windowTitle: 'Hello Sandbox', name: 'Greet', controlType: 'Button' });
    await call('sandbox_screenshot', { windowTitle: 'Hello Sandbox', name: `coordination-${network}` });
    await call('sandbox_desktop_release');
    await cli('ui', 'set', '--window', 'Hello Sandbox', '--id', 'NameBox', '--value', 'CLI turn');
    assert.match(await call('sandbox_ui_tree', { windowTitle: 'Hello Sandbox' }), /CLI turn/);
    console.log(JSON.stringify({ network, bootSeconds: start.bootSeconds, runDir: start.runDir, sharedCliMcp: 'pass' }));
  } finally {
    if (started) await sbx.stopSandbox();
    await client.close();
  }
}
