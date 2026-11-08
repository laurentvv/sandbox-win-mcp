import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';
const root = 'D:/GIT/sandbox-win-mcp';
const client = new Client({ name: 'probe', version: '1.0.0' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'src/server.js')], stderr: 'inherit' }));
const call = async (name, args = {}) => (await client.callTool({ name, arguments: args }, undefined, { timeout: 180_000 }))
  .content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
try {
  await call('sandbox_start', { window: 'normal' });
  const ltxt = await call('sandbox_launch', { path: 'C:\Windows\System32\SndVol.exe', waitForWindowSec: 20 });
  console.log('LAUNCH RAW:', ltxt.slice(0, 300));
  const l = JSON.parse(ltxt);
  await new Promise((r) => setTimeout(r, 1500));
  const wtxt = await call('sandbox_windows');
  console.log('WINDOWS:', wtxt.split('\n').slice(0, 8).join(' | '));
  const ttxt = await call('sandbox_ui_tree', { pid: l.pid, json: true, depth: 12 });
  console.log('TREE RAW (first 200):', ttxt.slice(0, 200));
  const nodes = JSON.parse(ttxt).nodes ?? [];
  console.log('== sndvol tree (' + nodes.length + ' nodes) ==');
  for (const n of nodes) console.log(`${'  '.repeat(n.depth)}${n.type} ${JSON.stringify(n.name ?? '')} ${n.value !== undefined ? '= ' + JSON.stringify(n.value) : ''} ${n.actions ? '{' + n.actions.join(',') + '}' : ''} rect=${JSON.stringify(n.rect)}`);
} catch (e) { console.error('PROBE ERROR:', e.message); }
finally { await call('sandbox_stop'); process.exit(0); }
