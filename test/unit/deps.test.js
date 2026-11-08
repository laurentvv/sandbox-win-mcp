import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readPe, scanDependencies, classifyDependencyFailure } from '../../src/deps.js';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-deps-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function pe(importName = 'vcruntime140.dll', machine = 0x8664) {
  const b = Buffer.alloc(1024);
  b.write('MZ'); b.writeUInt32LE(64, 60); b.write('PE\0\0', 64);
  b.writeUInt16LE(machine, 68); b.writeUInt16LE(1, 70); b.writeUInt16LE(240, 84);
  b.writeUInt16LE(0x20b, 88);
  b.writeUInt32LE(4096, 208); b.writeUInt32LE(40, 212);
  b.writeUInt32LE(4096, 340); b.writeUInt32LE(512, 344); b.writeUInt32LE(512, 348);
  b.writeUInt32LE(4160, 524); b.write(importName, 576);
  return b;
}
test('reads PE architecture and imports; diagnoses missing and app-local VC runtime', (t) => {
  const dir = fixture(t);
  fs.writeFileSync(path.join(dir, 'app.exe'), pe());
  assert.equal(readPe(pe()).architecture, 'x64');
  assert.deepEqual(readPe(pe()).imports, ['vcruntime140.dll']);
  assert.equal(scanDependencies(dir).requirements[0].status, 'missing');
  fs.writeFileSync(path.join(dir, 'vcruntime140.dll'), pe('kernel32.dll'));
  assert.equal(scanDependencies(dir).requirements[0].status, 'app-local');
});
test('rejects invalid PE offsets and truncated input safely', () => {
  assert.throws(() => readPe(Buffer.alloc(2)), /Truncated/);
  const b = pe(); b.writeUInt32LE(0xffffffff, 60);
  assert.throws(() => readPe(b), /Truncated/);
});
test('detects framework-dependent desktop and self-contained .NET with roll-forward', (t) => {
  const dir = fixture(t);
  fs.writeFileSync(path.join(dir, 'app.exe'), pe('kernel32.dll'));
  fs.writeFileSync(path.join(dir, 'app.runtimeconfig.json'), JSON.stringify({ runtimeOptions: {
    frameworks: [{ name: 'Microsoft.NETCore.App', version: '10.0.0' }, { name: 'Microsoft.WindowsDesktop.App', version: '10.0.0' }], rollForward: 'LatestPatch',
  } }));
  const scan = scanDependencies(dir);
  assert.equal(scan.requirements.length, 2);
  assert.equal(scan.requirements[1].component, 'Microsoft.WindowsDesktop.App');
  assert.equal(scan.requirements[1].architecture, 'x64');
  assert.equal(scan.requirements[1].rollForward, 'LatestPatch');
  fs.writeFileSync(path.join(dir, 'app.runtimeconfig.json'), JSON.stringify({ runtimeOptions: {
    includedFrameworks: [{ name: 'Microsoft.NETCore.App', version: '10.0.0' }],
  } }));
  assert.equal(scanDependencies(dir).requirements[0].status, 'app-local');
});
test('reports invalid runtime config instead of claiming no dependencies', (t) => {
  const dir = fixture(t); fs.writeFileSync(path.join(dir, 'app.runtimeconfig.json'), '{');
  assert.throws(() => scanDependencies(dir), /Invalid runtime configuration/);
});
test('detects Framework, package dependencies and script interpreters', (t) => {
  const dir = fixture(t);
  fs.writeFileSync(path.join(dir, 'app.exe.config'), '<supportedRuntime version="v4.0" sku=".NETFramework,Version=v4.8" />');
  fs.writeFileSync(path.join(dir, 'AppxManifest.xml'), '<PackageDependency Name="Microsoft.WindowsAppRuntime.1.8" MinVersion="8000.0.0.0" />');
  fs.writeFileSync(path.join(dir, 'app.jar'), '');
  fs.writeFileSync(path.join(dir, 'app.py'), '');
  fs.writeFileSync(path.join(dir, 'app.ps1'), '');
  const scan = scanDependencies(dir);
  assert.equal(scan.requirements.find((r) => r.component === '.NET Framework').status, 'satisfied');
  assert.equal(scan.requirements.find((r) => r.component.includes('WindowsAppRuntime')).status, 'unknown');
  assert.equal(scan.requirements.find((r) => r.component === 'Java').status, 'missing');
  assert.equal(scan.requirements.find((r) => r.component === 'Python').status, 'missing');
  assert.equal(scan.requirements.find((r) => r.component === 'Windows PowerShell').status, 'satisfied');
});
test('classifies early exits and no-window launches but not successful console runs', () => {
  const dependencies = { requirements: [{ component: 'Microsoft.WindowsDesktop.App', version: '10.0.0', status: 'missing', remediation: 'Install desktop runtime.', evidence: ['app.runtimeconfig.json'] }] };
  assert.match(classifyDependencyFailure({ dependencies, mode: 'gui', process: { hasWindow: false } })[0].message, /Missing dependency: Microsoft.WindowsDesktop.App 10.0.0/);
  assert.deepEqual(classifyDependencyFailure({ dependencies, mode: 'console', process: { hasExited: true, exitCode: 0 } }), []);
  assert.equal(classifyDependencyFailure({ error: 'You must install or update .NET' })[0].confidence, 'observed');
  assert.deepEqual(classifyDependencyFailure({ dependencies, error: 'Sandbox failed to boot', mode: 'gui' }), []);
  assert.equal(classifyDependencyFailure({ dependencies, mode: 'gui', process: { hasWindow: true }, runtimeDiagnostic: 'You must install or update .NET' })[0].component, 'Microsoft.WindowsDesktop.App');
  assert.deepEqual(classifyDependencyFailure({ dependencies, mode: 'gui', process: { hasWindow: false }, provisioned: [{
    component: 'Microsoft.WindowsDesktop.App', version: '10.0.14', architecture: undefined,
  }] }), []);
});
test('classifies event sources and hostfxr framework/version without a static config', () => {
  const hostfxr = classifyDependencyFailure({ error: "You must install or update .NET. Framework: 'Microsoft.WindowsDesktop.App', version '10.0.0' (x64)" });
  assert.equal(hostfxr[0].component, 'Microsoft.WindowsDesktop.App');
  assert.equal(hostfxr[0].version, '10.0.0');
  const process = { hasExited: true, exitCode: 1 };
  assert.equal(classifyDependencyFailure({ process, errors: [{ source: 'SideBySide', message: 'Activation context generation failed' }] })[0].component, 'Side-by-side runtime');
  assert.equal(classifyDependencyFailure({ process, errors: [{ source: '.NET Runtime', message: "System.IO.FileNotFoundException: Could not load file or assembly 'Missing.Library'" }] })[0].component, '.NET assembly');
});
test('.NET Framework 4.8.1 is not claimed satisfied by the 4.8 baseline', (t) => {
  const dir = fixture(t);
  for (const [version, expected] of [['4.8', 'satisfied'], ['4.8.0', 'satisfied'], ['4.8.1', 'unknown'], ['4.7.2', 'satisfied']]) {
    fs.writeFileSync(path.join(dir, 'app.exe.config'), `<supportedRuntime version="v4.0" sku=".NETFramework,Version=v${version}" />`);
    assert.equal(scanDependencies(dir).requirements[0].status, expected, version);
  }
});
test('packaged input does not inherit requirements from sibling apps', (t) => {
  const dir = fixture(t), pkg = path.join(dir, 'test.msix');
  fs.writeFileSync(pkg, '');
  fs.writeFileSync(path.join(dir, 'other.runtimeconfig.json'), JSON.stringify({ runtimeOptions: { framework: { name: 'Microsoft.NETCore.App', version: '10.0.0' } } }));
  const scan = scanDependencies(pkg);
  assert.equal(scan.requirements.length, 1);
  assert.equal(scan.requirements[0].status, 'unknown');
  assert.equal(scan.binaries.length, 0);
});
test('distinct runtimeconfig roll-forward policies are not lost when aggregating evidence', (t) => {
  const dir = fixture(t);
  for (const [file, rollForward] of [['one', 'LatestPatch'], ['two', 'Disable']]) {
    fs.writeFileSync(path.join(dir, `${file}.runtimeconfig.json`), JSON.stringify({ runtimeOptions: {
      framework: { name: 'Microsoft.NETCore.App', version: '10.0.0' }, rollForward,
    } }));
  }
  assert.deepEqual(scanDependencies(dir).requirements.map((r) => r.rollForward).sort(), ['Disable', 'LatestPatch']);
});
