import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { planProvision, selectDotnetFile, recordProvisioning } from '../../src/provision.js';

const core = { component: 'Microsoft.NETCore.App', version: '10.0.0', architecture: 'x64', status: 'missing' };
const desktop = { ...core, component: 'Microsoft.WindowsDesktop.App', rollForward: 'Minor' };
test('provisioning is explicit and validates list components/versions/architectures', () => {
  assert.throws(() => planProvision({}, undefined), /requires/);
  assert.throws(() => planProvision({}, 'bogus'), /Unknown/);
  assert.throws(() => planProvision({}, 'desktop:10.0:unknown'), /architecture/);
  assert.throws(() => planProvision({}, 'desktop:latest'), /version/);
  assert.deepEqual(planProvision({}, 'vcredist:x86'), [{ component: 'VC++ redistributable', architecture: 'x86' }]);
  assert.equal(planProvision({}, 'windows-app-runtime:1.8:x64')[0].version, '1.8');
});
test('auto combines desktop/core bundle but does not hide unsupported missing dependencies', () => {
  assert.deepEqual(planProvision({ requirements: [core, desktop] }, 'auto'), [{
    component: desktop.component, version: desktop.version, architecture: 'x64', rollForward: 'Minor', applyPatches: undefined,
  }]);
  assert.throws(() => planProvision({ requirements: [{ component: 'Java', status: 'missing', remediation: 'Install JRE' }] }, 'auto'), /Cannot auto-provision Java/);
  assert.throws(() => planProvision({ requirements: [{ ...core, architecture: 'unknown' }] }, 'auto'), /unknown architecture/);
  assert.deepEqual(planProvision({ requirements: [{ ...core, status: 'app-local' }] }, 'auto'), []);
});
test('auto refuses ambiguous Windows App Runtime bootstrap version', () => {
  assert.throws(() => planProvision({ requirements: [{ component: 'Windows App Runtime', status: 'unknown' }] }, 'auto'), /cannot be inferred/);
  assert.throws(() => planProvision({ requirements: [{ component: 'Packaged application dependencies', status: 'unknown',
    remediation: 'Inspect the package manifest.' }] }, 'auto'), /unknown requirement/);
  assert.throws(() => planProvision({ requirements: [{ component: '.NET Framework', version: '4.8.1', status: 'unknown',
    remediation: 'Verify the actual guest.' }] }, 'auto'), /unknown requirement/);
});
test('auto preserves exact requirements regardless of scan order and rejects conflicting bundle policies', () => {
  const exact = { ...core, rollForward: 'Disable', applyPatches: false };
  for (const requirements of [[core, exact], [exact, core]]) {
    const plan = planProvision({ requirements }, 'auto');
    assert.equal(plan.length, 1);
    assert.equal(plan[0].rollForward, 'Disable');
    assert.equal(plan[0].applyPatches, false);
  }
  assert.throws(() => planProvision({ requirements: [exact, desktop] }, 'auto'), /Conflicting auto runtime policies/);
  assert.throws(() => planProvision({ requirements: [exact, { ...core, version: '10.0.1' }] }, 'auto'), /Conflicting/);
  assert.equal(planProvision({ requirements: [exact, { ...desktop, rollForward: 'Disable', applyPatches: false }] }, 'auto').length, 1);
});
const release = (version, hash = 'a'.repeat(128), url = 'https://builds.dotnet.microsoft.com/runtime.exe') => ({
  windowsdesktop: { version, files: [{ name: 'windowsdesktop-runtime-win-x64.exe', rid: 'win-x64', url, hash }] },
});
test('resolves latest compatible patch from official metadata and enforces hash/URL', () => {
  const metadata = { releases: [release('10.0.1'), release('10.0.8'), release('11.0.0')] };
  assert.equal(selectDotnetFile(metadata, desktop).version, '10.0.8');
  assert.throws(() => selectDotnetFile(metadata, { ...desktop, rollForward: 'Disable' }), /No compatible/);
  assert.throws(() => selectDotnetFile(metadata, { ...desktop, applyPatches: false }), /No compatible/);
  assert.throws(() => selectDotnetFile({ releases: [release('10.0.8', 'bad')] }, desktop), /SHA-512/);
  assert.throws(() => selectDotnetFile({ releases: [release('10.0.8', 'a'.repeat(128), 'https://example.com/a.exe')] }, desktop), /approved Microsoft/);
});
test('provenance is persistent and explicitly non-clean before and after installation', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-provision-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  recordProvisioning(dir, 'auto', []);
  const read = () => JSON.parse(fs.readFileSync(path.join(dir, 'provisioning.json'), 'utf8'));
  assert.equal(read().cleanMachine, false);
  assert.deepEqual(read().provisioned, []);
  recordProvisioning(dir, 'auto', [{ component: 'Microsoft.WindowsDesktop.App', version: '10.0.14' }]);
  assert.equal(read().provisioned.length, 1);
  assert.equal(fs.readdirSync(dir).length, 1);
});

test('independent provenance writers retain all installations and sticky non-clean state', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-provision-writers-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const module = new URL('../../src/provision.js', import.meta.url).href;
  await Promise.all(['desktop', 'vcredist'].map((component) => new Promise((resolve, reject) => {
    const code = `import { recordProvisioning } from ${JSON.stringify(module)};
      for (let i=0;i<20;i++) recordProvisioning(${JSON.stringify(dir)}, 'auto', [{component:${JSON.stringify(component)},version:String(i)}]);
      recordProvisioning(${JSON.stringify(dir)}, 'auto', []);`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', code]);
    let stderr = '';
    child.stderr.on('data', (data) => stderr += data);
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(stderr)));
  })));
  const result = JSON.parse(fs.readFileSync(path.join(dir, 'provisioning.json'), 'utf8'));
  assert.equal(result.cleanMachine, false);
  assert.equal(result.provisioned.length, 40);
  assert.equal(new Set(result.provisioned.map((r) => `${r.component}:${r.version}`)).size, 40);
});
