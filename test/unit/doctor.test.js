import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkSandbox, sandboxChecks, formatChecks, ENABLE_SANDBOX } from '../../src/core.js';

const ready = {
  caption: 'Windows 11 Pro', build: 26100, edition: 'Professional', feature: 1, hypervisor: true, vt: false,
  wsb: 'C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\wsb.exe', alias: null, version: '0.8.107.0', node: '22.11.0',
};
const failing = (f) => sandboxChecks(f).filter((c) => !c.ok);

test('a ready PC passes every check', () => {
  const checks = sandboxChecks(ready);
  assert.ok(checks.every((c) => c.ok));
  assert.match(formatChecks(checks), /✅ wsb command-line tool: .*wsb\.exe \(Windows Sandbox 0\.8\.107\.0\)/);
});

test('Home editions stop at the edition check', () => {
  const checks = sandboxChecks({ ...ready, caption: 'Windows 11 Home', edition: 'CoreSingleLanguage', feature: null, wsb: null });
  assert.equal(checks.length, 1);
  assert.match(checks[0].detail, /Home/);
  assert.match(checks[0].fix, /Pro, Enterprise or Education/);
});

test('Windows Server has no Windows Sandbox', () => {
  const checks = sandboxChecks({ ...ready, caption: 'Windows Server 2025 Datacenter', edition: 'ServerDatacenter', feature: null, wsb: null });
  assert.equal(checks.length, 1);
  assert.match(checks[0].detail, /Server 2025 Datacenter doesn't include Windows Sandbox/);
  assert.match(checks[0].fix, /Pro, Enterprise or Education/);
});

test('a probe that could not run is one failed check, not a crash', () => {
  const checks = sandboxChecks({ probeError: 'PowerShell timed out', node: '22.11.0' });
  assert.equal(checks.length, 1);
  assert.equal(checks[0].ok, false);
  assert.match(checks[0].detail, /PowerShell timed out/);
  assert.match(checks[0].fix, /sbx doctor/);
});

test('feature off gives the one-line enable command', () => {
  const bad = failing({ ...ready, feature: 2, hypervisor: false, vt: true, wsb: null, version: '' });
  assert.deepEqual(bad.map((c) => c.detail), ['Windows Sandbox feature is off', "The wsb command-line tool isn't installed"]);
  assert.ok(bad[0].fix.includes(ENABLE_SANDBOX));
  assert.match(bad[1].fix, /Start menu once/);
});

test('virtualization off in firmware, or a restart still pending', () => {
  assert.match(failing({ ...ready, feature: 2, hypervisor: false, vt: false })[1].fix, /VT-x or AMD-V/);
  assert.deepEqual(failing({ ...ready, hypervisor: false, vt: true }).map((c) => c.fix), ['Restart Windows.']);
});

// Runs the real PowerShell probe, with LOCALAPPDATA pointed at an empty folder so the wsb alias is certainly absent.
test('the real probe reports well-formed facts even without the wsb alias', { skip: process.platform !== 'win32' }, async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-doctor-'));
  const saved = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = empty;
  try {
    const r = await checkSandbox();
    assert.equal(r.facts.probeError, undefined, `probe failed: ${r.facts.probeError}`);
    assert.equal(typeof r.ok, 'boolean');
    assert.ok(r.checks.length > 0 && r.checks.every((c) => typeof c.ok === 'boolean' && typeof c.detail === 'string'));
    assert.equal(typeof r.facts.build, 'number');
    assert.equal(typeof r.facts.hypervisor, 'boolean');
    for (const k of ['caption', 'edition', 'wsb', 'alias', 'version']) {
      assert.ok(r.facts[k] == null || typeof r.facts[k] === 'string', `facts.${k} should be text or absent, got ${JSON.stringify(r.facts[k])}`);
    }
    assert.ok(!r.facts.alias, 'the wsb alias cannot exist in an empty LOCALAPPDATA');
  } finally {
    process.env.LOCALAPPDATA = saved;
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

test('old builds, wsb not on PATH, old Node', () => {
  assert.match(failing({ ...ready, build: 22631 })[0].fix, /24H2/);
  assert.equal(failing({ ...ready, wsb: null, alias: 'C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\wsb.exe' })[0].fix,
    'Add C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps to PATH.');
  assert.match(failing({ ...ready, node: '18.19.0' })[0].fix, /Node\.js 20/);
});
