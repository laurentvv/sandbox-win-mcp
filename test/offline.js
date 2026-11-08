// End-to-end: network 'firewall' and 'off' (no adapter, mailbox transport) both isolate the guest while the
// agent keeps working; then verifies stop-on-disconnect (closing the MCP client destroys the sandbox).
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const running = () => JSON.parse(execFileSync('wsb', ['list', '--raw'], { encoding: 'utf8' }) || '{}').WindowsSandboxEnvironments?.length ?? 0;
const failures = [];
const check = (cond, what) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${what}`); if (!cond) failures.push(what); };

async function connect() {
  const client = new Client({ name: 'offline-test', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'src', 'server.js')], stderr: 'inherit', env: { ...process.env } }));
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 600_000 });
    const txt = r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    console.log(`  ${name}${r.isError ? ' (isError)' : ''}: ${txt.slice(0, 200).replace(/\s+/g, ' ')}`);
    if (r.isError) throw new Error(`${name}: ${txt}`);
    return { r, txt };
  };
  return { client, call };
}

const probe = "try { (Invoke-WebRequest https://example.com -UseBasicParsing -TimeoutSec 10).StatusCode } catch { 'BLOCKED' }";

for (const network of ['firewall', 'off']) {
  console.log(`\n== network ${network} ==`);
  const { client, call } = await connect();
  try {
    await call('sandbox_start', { network, window: 'minimized' });
    check((await call('sandbox_exec', { command: probe })).txt.includes('BLOCKED'), `${network}: internet blocked`);
    if (network === 'off') {
      const adapters = await call('sandbox_exec', { command: '@(Get-NetAdapter -ErrorAction SilentlyContinue).Count' });
      check(/--- stdout ---\n0\s*$/.test(adapters.txt.trim()), 'off: no network adapter');
      const t0 = Date.now();
      for (let i = 0; i < 5; i++) await call('sandbox_windows');
      const per = (Date.now() - t0) / 5;
      console.log(`  mailbox round trip: ${per.toFixed(0)}ms`);
      check(per < 1500, 'off: mailbox round trip under 1.5s');
    }
    check(!(await call('sandbox_screenshot', { maxWidth: 400 })).r.isError, `${network}: screenshot works`);
    check(!(await call('sandbox_copy_in', { hostPath: path.join(root, 'package.json'), sandboxPath: 'C:\\t\\package.json' })).r.isError, `${network}: copy in`);
    check((await call('sandbox_exec', { command: "(Get-Content C:\\t\\package.json -Raw | ConvertFrom-Json).name" })).txt.includes('sandbox-mcp'), `${network}: copied file readable`);
  } finally {
    if (network === 'firewall') {
      try { await call('sandbox_stop'); } finally { await client.close(); }
    }
    else {
      // Leave it running and just disconnect: the server must tear the sandbox down on its own.
      await client.close();
      let n = running();
      for (let i = 0; i < 30 && n; i++) { await sleep(1000); n = running(); }
      check(n === 0, 'stop-on-disconnect: sandbox destroyed after client closed');
    }
  }
  await sleep(3000);
}

console.log(failures.length ? `\nOFFLINE TEST FAILED: ${failures.join('; ')}` : '\nOFFLINE TEST PASSED');
process.exit(failures.length ? 1 : 0);
