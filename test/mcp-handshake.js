// MCP stdio handshake smoke: spawn the real server, initialize, list tools, close.
// Boots NO sandbox — this proves the server wire-up (name, version, tool registry) only,
// so it can run anywhere Node runs, including CI-less gates. Counterpart of the live
// test/smoke.js which drives a real guest end to end.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION } from '../src/core.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const client = new Client({ name: 'handshake-smoke', version: '1.0.0' });
await client.connect(new StdioClientTransport({
  command: process.execPath,
  args: [path.join(root, 'src', 'server.js')],
  stderr: 'inherit',
}));

const server = client.getServerVersion();
if (server.name !== 'sandbox-win-mcp') throw new Error(`unexpected server name: ${JSON.stringify(server.name)}`);
if (server.version !== VERSION) throw new Error(`server version ${server.version} != package ${VERSION}`);

const { tools } = await client.listTools();
if (tools.length < 25) throw new Error(`expected at least 25 tools, got ${tools.length}`);
const names = tools.map((t) => t.name);
for (const expected of ['sandbox_start', 'sandbox_stop', 'sandbox_ui_action', 'sandbox_type', 'sandbox_click', 'sandbox_detonate']) {
  if (!names.includes(expected)) throw new Error(`tool registry is missing ${expected}`);
}

await client.close();
console.log(`server ${server.name} ${server.version}; ${tools.length} tools registered:`);
console.log(names.join(', '));
