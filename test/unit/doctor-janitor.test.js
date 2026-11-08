import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sandboxChecks, classifyJanitor } from '../../src/core.js';

const ready = {
  caption: 'Windows 11 Pro', build: 26100, edition: 'Professional', feature: 1, hypervisor: true, vt: false,
  wsb: 'C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\wsb.exe',
  alias: 'C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\wsb.exe', version: '0.8.107.0', node: '22.11.0',
};
const failing = (f) => sandboxChecks(f).filter((c) => !c.ok);
const passing = (f) => sandboxChecks(f).filter((c) => c.ok);

test('a clean machine reports "no restart is pending"', () => {
  assert.ok(passing(ready).some((c) => c.detail === 'No restart is pending'));
  assert.ok(!failing(ready).some((c) => /restart is pending/.test(c.detail)));
});

test('pending reboot is its own failed check naming its sources (lesson 2)', () => {
  const cbs = failing({ ...ready, rebootCbs: true });
  assert.match(cbs[0].detail, /A restart is pending \(component servicing\)/);
  assert.match(cbs[0].fix, /Restart Windows/);
  const multi = failing({ ...ready, rebootWu: true, rebootRename: true });
  assert.match(multi[0].detail, /Windows Update, pending file rename/);
  const pkg = failing({ ...ready, rebootPackages: true });
  assert.match(pkg[0].detail, /pending packages/);
});

test('wsb resolution detail distinguishes App Execution Alias from PATH (lesson 1)', () => {
  const viaAlias = sandboxChecks(ready).find((c) => /wsb command-line tool/.test(c.detail));
  assert.match(viaAlias.detail, /\(App Execution Alias\)/);
  const viaPath = sandboxChecks({ ...ready, wsb: 'C:\\Tools\\wsb.exe' }).find((c) => /wsb command-line tool/.test(c.detail));
  assert.match(viaPath.detail, /\(on PATH\)/);
  assert.doesNotMatch(viaPath.detail, /App Execution Alias/);
});

test('janitor classification: clean, in-use, and both orphan flavors', () => {
  assert.deepEqual(classifyJanitor(null), { state: 'clean', orphan: false });
  assert.deepEqual(classifyJanitor({ vm: 0, remoteSession: 0, server: 0, client: 0 }, []), { state: 'clean', orphan: false });
  const inUse = classifyJanitor({ vm: 1, remoteSession: 1, server: 1, client: 1 }, ['id-1']);
  assert.equal(inUse.state, 'in-use'); assert.equal(inUse.orphan, false);
  const listed = classifyJanitor({ vm: 1, remoteSession: 0, server: 0, client: 0 }, ['id-1']);
  assert.equal(listed.state, 'headless-listed'); assert.equal(listed.orphan, true);
  const orphan = classifyJanitor({ vm: 1, remoteSession: 0, server: 0, client: 0 }, []);
  assert.equal(orphan.state, 'headless-orphan'); assert.equal(orphan.orphan, true);
  assert.match(orphan.note, /vmmemWindowsSandbox/);
});
