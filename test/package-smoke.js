import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

if (process.platform !== 'win32') throw new Error('The portable package smoke test requires Windows.');
const archive = process.argv[2];
if (!archive) throw new Error('Usage: node test/package-smoke.js <portable-package.zip>');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-mcp-package-'));
const unpacked = path.join(temp, 'unpacked');
fs.mkdirSync(unpacked);
const systemRoot = process.env.SystemRoot || 'C:\\Windows';
const ps = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const expand = spawnSync(ps, [
  '-NoProfile', '-NonInteractive', '-Command',
  `Expand-Archive -LiteralPath '${path.resolve(archive).replaceAll("'", "''")}' -DestinationPath '${unpacked.replaceAll("'", "''")}' -Force`,
], { encoding: 'utf8' });
assert.equal(expand.status, 0, `Could not extract package: ${expand.stderr || expand.stdout}`);

const node = path.join(unpacked, 'node.exe');
const cli = path.join(unpacked, 'sbx.cmd');
const packageMetadata = JSON.parse(fs.readFileSync(path.join(unpacked, 'package.json'), 'utf8'));
const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
for (const directory of ['src', 'agent', 'skills', 'docs']) {
  const source = path.join(sourceRoot, directory);
  for (const relative of fs.readdirSync(source, { recursive: true })) {
    const original = path.join(source, relative);
    if (!fs.statSync(original).isFile()) continue;
    const packaged = path.join(unpacked, directory, relative);
    assert.ok(fs.existsSync(packaged), `Package is missing ${directory}\\${relative}`);
    const digest = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    assert.equal(digest(packaged), digest(original), `Packaged ${directory}\\${relative} differs from the tested source.`);
  }
  for (const relative of ['README.md', 'LICENSE', 'package.json']) {
    assert.deepEqual(fs.readFileSync(path.join(unpacked, relative)), fs.readFileSync(path.join(sourceRoot, relative)),
      `Packaged ${relative} differs from the tested source.`);
  }
  assert.match(fs.readFileSync(path.join(unpacked, 'BUILD-INFO.txt'), 'utf8'), /Source commit: [a-f0-9]{40}/);
}
assert.ok(fs.existsSync(node), 'Bundled Node.js runtime is missing.');
assert.ok(fs.existsSync(path.join(unpacked, 'NODE-LICENSE.txt')), 'Node.js license is missing.');
assert.ok(fs.existsSync(path.join(unpacked, 'agent', 'agent.ps1')), 'Guest agent is missing.');
assert.ok(fs.existsSync(path.join(unpacked, 'skills', 'windows-sandbox-app-test', 'SKILL.md')), 'Agent skill is missing.');
assert.ok(fs.existsSync(path.join(unpacked, 'node_modules', '@modelcontextprotocol', 'sdk', 'package.json')), 'MCP runtime dependencies are missing.');
assert.ok(fs.existsSync(path.join(unpacked, 'docs', 'hello-after-test.png')), 'README image resource is missing.');

const isolatedPath = [
  path.join(systemRoot, 'System32'),
  path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0'),
].join(path.delimiter);
const env = { ...process.env, PATH: isolatedPath };
const cmd = path.join(systemRoot, 'System32', 'cmd.exe');
const where = spawnSync(path.join(systemRoot, 'System32', 'where.exe'), ['node'], { env, encoding: 'utf8' });
assert.equal(where.status, 1, `Host Node is still visible on the isolated PATH: ${where.stdout}`);
const invokeCli = (...args) => spawnSync(cmd, ['/d', '/c', `sbx.cmd ${args.join(' ')}`], {
  cwd: unpacked, env, encoding: 'utf8', timeout: 90_000,
});

const help = invokeCli('help');
assert.equal(help.status, 0, `Packaged CLI help failed: ${help.stderr || help.stdout}`);
assert.match(help.stdout, /Usage: sbx/);
const sourceHelp = spawnSync(process.execPath, [path.join(sourceRoot, 'src', 'cli.js'), 'help'], { encoding: 'utf8' });
assert.equal(sourceHelp.status, 0, `Source CLI help failed: ${sourceHelp.stderr}`);
const withoutHome = (text) => text.replace(/^Data: .*$/m, 'Data: <home>').replaceAll('\r\n', '\n');
assert.equal(withoutHome(help.stdout), withoutHome(sourceHelp.stdout), 'Packaged CLI help does not expose the tested command surface.');
const version = invokeCli('version');
assert.equal(version.status, 0, `Packaged CLI version failed: ${version.stderr || version.stdout}`);
assert.equal(version.stdout.trim(), packageMetadata.version);

const doctor = invokeCli('doctor', '--json');
const doctorOutput = `exit ${doctor.status}${doctor.error ? ` (${doctor.error.message})` : ''}\nstdout: ${doctor.stdout}\nstderr: ${doctor.stderr}`;
assert.ok([0, 1].includes(doctor.status), `Packaged doctor failed unexpectedly: ${doctorOutput}`);
let report;
try { report = JSON.parse(doctor.stdout); } catch { assert.fail(`doctor --json did not print JSON: ${doctorOutput}`); }
assert.ok(Array.isArray(report.checks) && report.checks.length > 0, 'doctor --json did not return structured checks.');
assert.equal(typeof report.ok, 'boolean');
assert.equal(typeof report.facts.node, 'string', 'doctor did not report the bundled Node runtime.');
assert.equal(doctor.status, report.ok ? 0 : 1, 'doctor exit code does not match readiness.');
console.log(`doctor on this machine: ${report.ok ? 'ready' : 'not ready'} ${JSON.stringify(report.facts)}`);

const server = spawn(node, ['src/server.js'], { cwd: unpacked, env, stdio: ['pipe', 'pipe', 'pipe'] });
let stderr = '';
server.stderr.setEncoding('utf8').on('data', (data) => { stderr += data; });
const lines = createInterface({ input: server.stdout });
const responses = new Map();
let parseError;
lines.on('line', (line) => {
  try {
    const message = JSON.parse(line);
    if (message.id !== undefined) responses.set(message.id, message);
  } catch (error) {
    parseError = new Error(`MCP server wrote non-JSON data to stdout: ${line}`, { cause: error });
  }
});
const send = (message) => server.stdin.write(`${JSON.stringify(message)}\n`);
const response = async (id) => {
  const until = Date.now() + 15_000;
  while (Date.now() < until) {
    if (parseError) throw parseError;
    if (responses.has(id)) return responses.get(id);
    if (server.exitCode !== null) throw new Error(`MCP server exited early (${server.exitCode}): ${stderr}`);
    await delay(25);
  }
  throw new Error(`Timed out waiting for MCP response ${id}. stderr: ${stderr}`);
};

try {
  send({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'package-smoke', version: '1.0.0' } },
  });
  const initialized = await response(1);
  assert.ok(initialized.result?.serverInfo, 'MCP initialization did not return server information.');
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const tools = await response(2);
  assert.ok(tools.result?.tools?.some((tool) => tool.name === 'sandbox_start'), 'MCP tools/list did not return sandbox_start.');
  const expectedTools = [...fs.readFileSync(path.join(sourceRoot, 'src', 'server.js'), 'utf8')
    .matchAll(/server\.registerTool\('([^']+)'/g)].map((match) => match[1]).sort();
  assert.ok(expectedTools.length > 0, 'No source MCP tools were found for package comparison.');
  assert.deepEqual(tools.result.tools.map((tool) => tool.name).sort(), expectedTools,
    'Packaged MCP tool surface differs from the tested source.');
  assert.ok(stderr.includes('ready'), 'MCP startup diagnostics were not sent to stderr.');
  console.log('Portable package smoke test passed (CLI without Node on PATH, structured doctor, MCP stdio).');
} finally {
  server.stdin.end();
  await Promise.race([
    new Promise((resolve) => server.once('exit', resolve)),
    delay(2_000),
  ]);
  if (server.exitCode === null) server.kill();
  lines.close();
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
