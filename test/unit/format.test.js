import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatUiNode, formatUiTree, formatDiff } from '../../src/core.js';
import { processState, summary, renderReport, runFailures } from '../../src/run.js';

test('formatUiNode is one compact line per control', () => {
  assert.equal(formatUiNode({ type: 'Button', name: 'Greet', automationId: 'GreetButton', actions: ['invoke'], depth: 1 }), '  Button "Greet" #GreetButton {invoke}');
  assert.equal(formatUiNode({ type: 'Edit', name: 'Name', value: '', depth: 0 }), 'Edit "Name" = ""');
  assert.equal(formatUiNode({ type: 'Text', name: 'Hi', value: 'Hi' }), 'Text "Hi"');
  assert.equal(formatUiNode({ type: 'CheckBox', name: 'Agree', toggled: true, enabled: false }), 'CheckBox "Agree" [x] (disabled)');
});

test('formatUiTree joins nodes and flags truncation', () => {
  assert.equal(formatUiTree(null), '');
  const t = formatUiTree({ nodes: { type: 'Window', name: 'Solo', depth: 0 }, truncated: true }); // PS 5.1 unrolls single-element arrays
  assert.match(t, /^Window "Solo"\n… \(truncated/);
});

const diff = (patch = {}) => ({
  files: { added: [], removed: [], changed: [], addedCount: 0, removedCount: 0, changedCount: 0, addedBytes: 0, addedGroups: 0, removedGroups: 0 },
  registry: { added: [], removed: [], addedCount: 0, removedCount: 0, addedGroups: 0, removedGroups: 0 },
  values: [], services: [], programsAdded: [], programsRemoved: [], ...patch,
});

test('formatDiff says so when nothing changed', () => {
  assert.equal(formatDiff(diff(), { title: 'idle' }), '### idle\n\nNo changes.\n');
});

test('formatDiff renders programs, services, values, files and registry', () => {
  const md = formatDiff(diff({
    programsAdded: [{ displayName: '7-Zip', displayVersion: '25.01', publisher: 'Igor Pavlov' }],
    services: [{ change: 'added', name: 'LeakyUpdater', after: 'Leaky App Updater|service|2|"C:\\x\\updater.exe"' }],
    values: [{ change: 'added', name: 'HKCU\\...\\Run\\Leaky', after: 'leaky.exe' }, { change: 'changed', name: 'Path', before: 'a', after: 'a;b' }],
    files: { added: [{ path: 'C:\\Program Files\\7-Zip', container: true, items: 107, bytes: 5872025 }, { path: 'C:\\x.txt', bytes: 10 }], removed: [], changed: [],
      addedCount: 109, removedCount: 0, changedCount: 0, addedBytes: 5872035, addedGroups: 3, removedGroups: 0 },
    registry: { added: [{ path: 'HKLM\\SOFTWARE\\7-Zip', items: 2 }], removed: [], addedCount: 3, removedCount: 0, addedGroups: 1, removedGroups: 0 },
  }));
  assert.match(md, /➕ 7-Zip 25\.01 \(Igor Pavlov\)/);
  assert.match(md, /added service `LeakyUpdater` "Leaky App Updater", automatic: `"C:\\x\\updater\.exe"`/);
  assert.match(md, /changed `Path`: `a` → `a;b`/);
  assert.match(md, /\*\*Files\*\*: 109 added \(5\.6 MB\)/);
  assert.match(md, /➕ `C:\\Program Files\\7-Zip\\` \(new, 107 item\(s\), 5\.6 MB\)/);
  assert.match(md, /… and 1 more/);
  assert.match(md, /➕ `HKLM\\SOFTWARE\\7-Zip` \(\+2 subkeys\)/);
});

test('processState and summary describe a run', () => {
  assert.equal(processState({}), 'not started');
  assert.equal(processState({ process: { hasExited: true, exitCode: 3 } }), 'exited with code 3');
  assert.equal(processState({ process: { windowTitle: 'Hello' } }), 'still running, window "Hello"');
  assert.match(processState({ process: {}, crashes: [{}] }), /^crashed/);
  const s = summary({ pass: true, app: 'Hello.exe', seconds: 37.4, failures: [], sandbox: { network: 'on', bootSeconds: 14.9 },
    process: { windowTitle: 'Hello' }, errors: true, crashes: [], shots: [1, 2, 3], reportPath: 'C:\\r.md' });
  assert.match(s, /^PASS {2}Hello\.exe on a fresh Windows Sandbox \(37\.4s\)/);
  assert.match(s, /crashes +none/);
  assert.match(s, /shots +3 screenshot\(s\)/);
});

test('teardown failure cannot produce a passing run and is visible in both reports', () => {
  assert.deepEqual(runFailures({ process: { hasExited: false }, crashes: [] }), []);
  const r = {
    app: 'Hello.exe', hostDir: 'C:\\app', mode: 'gui', seconds: 1, shots: [], collected: [],
    process: { hasExited: false }, crashes: [], stopError: 'guest is still running', outDir: 'C:\\out',
  };
  r.failures = runFailures(r);
  r.pass = r.failures.length === 0;
  assert.equal(r.pass, false);
  assert.deepEqual(r.failures, ['sandbox teardown failed: guest is still running']);
  assert.match(summary(r), /^FAIL[\s\S]*sandbox teardown failed: guest is still running/);
  assert.match(renderReport(r), /\*\*❌ FAIL\*\*: sandbox teardown failed: guest is still running/);
});
