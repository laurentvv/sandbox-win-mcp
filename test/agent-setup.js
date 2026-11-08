// Exercise the README's agent instructions without changing the user's client configuration.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const doc = fs.readFileSync('docs\\agent-setup.md', 'utf8');
const snippet = (name) => {
  const match = doc.match(new RegExp(`<!-- setup-test: ${name} -->\\s*\`\`\`powershell\\r?\\n([\\s\\S]*?)\`\`\``));
  assert.ok(match, `Missing executable setup documentation: ${name}`);
  return match[1];
};
const q = (value) => `'${value.replaceAll("'", "''")}'`;
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-agent-setup-'));
let client;
try {
  let install = process.argv.find((arg) => arg.startsWith('--portable='))?.slice('--portable='.length);
  if (process.argv.includes('--download') || process.argv.includes('--candidate')) {
    const candidate = process.argv.includes('--candidate');
    const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', snippet(candidate ? 'download-candidate' : 'download-stable')], {
      env: { ...process.env, LOCALAPPDATA: temporary, TEMP: temporary }, encoding: 'utf8', timeout: 180_000, windowsHide: true,
    });
    console.log(output.trim());
    const releases = path.join(temporary, 'sandbox-mcp', candidate ? 'candidates' : 'releases');
    const tags = fs.readdirSync(releases);
    assert.equal(tags.length, 1);
    install = path.join(releases, tags[0]);
  }
  assert.ok(install, 'Use --download, --candidate or --portable=<extracted-path>.');
  install = path.resolve(install);
  for (const shell of ['powershell.exe', 'pwsh']) {
    for (const kind of ['copilot-global', 'vscode-local', 'claude']) {
      const config = path.join(temporary, `${shell}-${kind}`, 'config.json');
      fs.mkdirSync(path.dirname(config), { recursive: true });
      const key = kind === 'vscode-local' ? 'servers' : 'mcpServers';
      const initial = { theme: 'preserve-this', [key]: { existing: { command: 'existing-server', args: ['untouched'] } } };
      const raw = JSON.stringify(initial, null, 2);
      fs.writeFileSync(config, raw);
      const command = `${snippet('merge-config')}\nMerge-SandboxMcpConfig -ConfigPath ${q(config)} -Install ${q(install)} -Client '${kind}'`;
      execFileSync(shell, ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', timeout: 30_000, windowsHide: true });
      const added = JSON.parse(fs.readFileSync(config, 'utf8'));
      assert.equal(added.theme, initial.theme);
      assert.deepEqual(added[key].existing, initial[key].existing);
      assert.equal(added[key]['windows-sandbox'].command, path.join(install, 'node.exe'));
      assert.deepEqual(added[key]['windows-sandbox'].args, [path.join(install, 'src', 'server.js')]);
      if (kind === 'claude') assert.ok(!added[key]['windows-sandbox'].type);
      else assert.equal(added[key]['windows-sandbox'].type, 'stdio');
      const backups = fs.readdirSync(path.dirname(config)).filter((file) => file.includes('.backup-'));
      assert.equal(backups.length, 1);
      assert.equal(fs.readFileSync(path.join(path.dirname(config), backups[0]), 'utf8'), raw);
      execFileSync(shell, ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', timeout: 30_000, windowsHide: true });
      assert.equal(fs.readdirSync(path.dirname(config)).filter((file) => file.includes('.backup-')).length, 1);
      added[key]['windows-sandbox'].command = 'do-not-replace';
      fs.writeFileSync(config, JSON.stringify(added));
      assert.throws(() => execFileSync(shell, ['-NoProfile', '-NonInteractive', '-Command', command], { stdio: 'pipe', timeout: 30_000, windowsHide: true }));
      assert.equal(JSON.parse(fs.readFileSync(config, 'utf8'))[key]['windows-sandbox'].command, 'do-not-replace');
      const commented = '// preserve this comment\n' + raw;
      fs.writeFileSync(config, commented);
      assert.throws(() => execFileSync(shell, ['-NoProfile', '-NonInteractive', '-Command', command], { stdio: 'pipe', timeout: 30_000, windowsHide: true }));
      assert.equal(fs.readFileSync(config, 'utf8'), commented, 'JSONC must be retained for a native client edit');
      for (const malformed of ['true', '42', '[{}]', JSON.stringify({ [key]: true }), JSON.stringify({ [key]: 42 }), JSON.stringify({ [key]: [{}] })]) {
        fs.writeFileSync(config, malformed);
        assert.throws(() => execFileSync(shell, ['-NoProfile', '-NonInteractive', '-Command', command], { stdio: 'pipe', timeout: 30_000, windowsHide: true }));
        assert.equal(fs.readFileSync(config, 'utf8'), malformed, 'malformed scalar configuration must not be rewritten');
      }
      console.log(`${shell} ${kind}: preserved settings/server, backup, idempotence and replacement refusal PASS`);
    }
  }
  // The documented native command is tested against an isolated COPILOT_HOME as well.
  const copilotHome = path.join(temporary, 'copilot-command');
  fs.mkdirSync(copilotHome);
  fs.writeFileSync(path.join(copilotHome, 'mcp-config.json'), JSON.stringify({ mcpServers: { existing: { command: 'untouched' } } }));
  execFileSync('copilot.exe', ['mcp', 'add', 'windows-sandbox', '--', path.join(install, 'node.exe'), path.join(install, 'src', 'server.js')], {
    env: { ...process.env, COPILOT_HOME: copilotHome }, encoding: 'utf8', timeout: 30_000, windowsHide: true,
  });
  const native = JSON.parse(fs.readFileSync(path.join(copilotHome, 'mcp-config.json'), 'utf8'));
  assert.equal(native.mcpServers.existing.command, 'untouched');
  assert.equal(native.mcpServers['windows-sandbox'].command, path.join(install, 'node.exe'));
  console.log('Documented copilot mcp add with isolated COPILOT_HOME PASS');
  client = new Client({ name: 'agent-setup-proof', version: '1.0.0' });
  await client.connect(new StdioClientTransport({
    command: path.join(install, 'node.exe'), args: [path.join(install, 'src', 'server.js')],
    env: { ...process.env, SANDBOX_MCP_HOME: path.join(temporary, 'state') }, stderr: 'inherit',
  }));
  const result = await client.callTool({ name: 'sandbox_status', arguments: {} });
  assert.ok(!result.isError, JSON.stringify(result));
  const status = JSON.parse(result.content.find((part) => part.type === 'text').text);
  assert.equal(status.running, false);
  assert.ok(Array.isArray(status.otherSandboxes));
  console.log('Verified runtime, actual MCP initialization and sandbox_status tool result PASS');
} finally {
  if (client) await client.close();
  fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
