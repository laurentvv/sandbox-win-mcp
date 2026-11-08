import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { atomicJson, readJson, withStateLock, createDesktop } from '../../src/coordination.js';

const modulePath = fileURLToPath(new URL('../../src/coordination.js', import.meta.url));
function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-coordination-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('state updates are atomic across independent processes', async (t) => {
  const home = temp(t);
  const file = path.join(home, 'current.json');
  atomicJson(file, { seq: 0 });
  const code = `
    const { withStateLock, atomicJson, readJson } = await import(${JSON.stringify(new URL('../../src/coordination.js', import.meta.url).href)});
    for (let i = 0; i < 80; i++) withStateLock(${JSON.stringify(home)}, () => {
      const state = readJson(${JSON.stringify(file)});
      state.seq++;
      atomicJson(${JSON.stringify(file)}, state);
    });
  `;
  await Promise.all(Array.from({ length: 6 }, () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code]);
    let stderr = '';
    child.stderr.on('data', (data) => stderr += data);
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(stderr)));
  })));
  assert.equal(readJson(file).seq, 480);
  assert.deepEqual(fs.readdirSync(home), ['current.json']);
});

test('dead owner lock is recovered and failures release the lock', (t) => {
  const home = temp(t);
  // Find a PID known not to exist on this host.
  let pid = 2_000_000_000;
  while (true) {
    try { process.kill(pid, 0); pid--; } catch { break; }
  }
  fs.writeFileSync(path.join(home, 'state.lock'), JSON.stringify({ pid }));
  assert.throws(() => withStateLock(home, () => { throw new Error('test failure'); }), /test failure/);
  assert.equal(withStateLock(home, () => 42), 42);
  assert.ok(fs.existsSync(modulePath));
});

test('desktop leases retain grace, time out clearly, release, and preserve FIFO', async (t) => {
  const home = temp(t);
  const first = createDesktop(home, { owner: 'first', persistent: true, graceMs: 200 });
  const second = createDesktop(home, { owner: 'second', timeoutMs: 50 });
  await first.run(async () => {});
  await assert.rejects(second.run(async () => {}), /desktop busy: held by first/);
  assert.deepEqual(first.release(), { released: true });
  const order = [];
  let finish;
  const active = first.run(() => new Promise((resolve) => { finish = resolve; }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  const b = createDesktop(home, { owner: 'b' }).run(async () => { order.push('b'); });
  const c = createDesktop(home, { owner: 'c' }).run(async () => { order.push('c'); });
  finish();
  await Promise.all([active, b, c]);
  assert.deepEqual(order, ['b', 'c']);
});

test('desktop lease is released after a failed anonymous command', async (t) => {
  const home = temp(t);
  await assert.rejects(createDesktop(home).run(async () => { throw new Error('operation failed'); }), /operation failed/);
  await createDesktop(home, { owner: 'next', timeoutMs: 100 }).run(async () => {});
  assert.equal(readJson(path.join(home, 'desktop.json')).lease, null);
});

test('old partial owner records and abandoned recovery sentinels are reclaimed', (t) => {
  const home = temp(t);
  for (const name of ['state.lock', 'state.lock.recovery']) {
    const file = path.join(home, name);
    fs.writeFileSync(file, '{"pid":');
    fs.utimesSync(file, new Date(0), new Date(0));
  }
  assert.equal(withStateLock(home, () => 42, { timeoutMs: 1000 }), 42);
  assert.deepEqual(fs.readdirSync(home), []);
});

test('fresh incomplete locks are not stolen; malformed state is an explicit error', (t) => {
  const home = temp(t);
  fs.writeFileSync(path.join(home, 'state.lock'), '{"pid":');
  assert.throws(() => withStateLock(home, () => {}, { timeoutMs: 40 }), /state lock/);
  fs.writeFileSync(path.join(home, 'current.json'), '{"seq":');
  assert.throws(() => readJson(path.join(home, 'current.json')), SyntaxError);
});

test('disconnect cleanup cannot stop or clear a same-ID replacement boot', (t) => {
  const home = temp(t);
  const file = path.join(home, 'current.json');
  const replacement = { id: 'same-provider-id', epoch: 'new-boot', runDir: home };
  atomicJson(file, replacement);
  const code = `
    import assert from 'node:assert/strict';
    import { stopDetached } from ${JSON.stringify(new URL('../../src/core.js', import.meta.url).href)};
    assert.equal(stopDetached({id:'same-provider-id',epoch:'old-boot'}), false);
    assert.equal(stopDetached({id:'same-provider-id'}), false);
  `;
  execFileSync(process.execPath, ['--input-type=module', '-e', code], {
    env: { ...process.env, SANDBOX_MCP_HOME: home },
  });
  assert.deepEqual(readJson(file), replacement);
});

test('pinned copy and exec reject a replacement epoch without staging or sending', (t) => {
  const home = temp(t);
  const file = path.join(home, 'current.json');
  const replacement = { id: 'same-provider-id', epoch: 'new-boot', runDir: home, protocolSeq: 20, seq: 10 };
  atomicJson(file, replacement);
  fs.mkdirSync(path.join(home, 'agent'));
  fs.writeFileSync(path.join(home, 'agent', 'token.txt'), 'a'.repeat(64));
  const source = path.join(home, 'source.txt');
  fs.writeFileSync(source, 'test');
  const code = `
    import assert from 'node:assert/strict';
    import { copyIn, exec } from ${JSON.stringify(new URL('../../src/core.js', import.meta.url).href)};
    const target={id:'same-provider-id',epoch:'old-boot',runDir:${JSON.stringify(home)},identity:{protocolVersion:2}};
    await assert.rejects(copyIn(${JSON.stringify(source)}, 'C:\\\\apps\\\\stale.txt', target), /restarted\\/replaced/);
    await assert.rejects(exec({command:"'must-not-execute'"}, target), /restarted\\/replaced/);
  `;
  execFileSync(process.execPath, ['--input-type=module', '-e', code], {
    env: { ...process.env, SANDBOX_MCP_HOME: home },
  });
  assert.deepEqual(readJson(file), replacement);
  assert.equal(fs.existsSync(path.join(home, 'in')), false);
});
