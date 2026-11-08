// Real Windows Sandbox proof. Acquire the host-wide Sandbox lock before running this test.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as sbx from '../src/core.js';

const source = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-deploy-proof-'));
const evidence = [];
const check = (r, counts) => {
  for (const [k, v] of Object.entries(counts)) assert.equal(r[k], v, k);
  assert.equal(r.verified, true);
  return r;
};
try {
  for (const network of ['on', 'off']) {
    fs.cpSync(path.join(sbx.ROOT, 'samples', 'HelloSandbox', 'bin', 'HelloSandbox.exe'), path.join(source, 'HelloSandbox.exe'));
    fs.writeFileSync(path.join(source, '0-change.txt'), 'first');
    fs.writeFileSync(path.join(source, 'delete.txt'), 'remove');
    fs.writeFileSync(path.join(source, 'payload.bin'), Buffer.alloc(8 * 1024 * 1024, 42));
    fs.mkdirSync(path.join(source, 'empty'), { recursive: true });
    let started = false;
    try {
      await sbx.startSandbox({ network, window: 'minimized' });
      started = true;
      const options = { hostPath: source, sandboxPath: 'C:\\apps\\DeployProof', launch: 'HelloSandbox.exe', restart: true };
      const first = check(await sbx.deploy(options), { added: 4, changed: 0, removed: 0, unchanged: 0 });
      assert.equal(first.launch.hasExited, false);
      fs.writeFileSync(path.join(source, '0-change.txt'), 'other');
      const second = check(await sbx.deploy(options), { added: 0, changed: 1, removed: 0, unchanged: 3, bytesTransferred: 5 });
      assert.ok(second.stopped.includes(first.launch.pid));
      assert.equal((await sbx.processInfo(first.launch.pid)).hasExited, true);
      assert.equal(second.launch.hasExited, false);
      fs.unlinkSync(path.join(source, 'delete.txt'));
      const deletion = check(await sbx.deploy(options), { added: 0, changed: 0, removed: 1, unchanged: 3, bytesTransferred: 0 });
      const noop = check(await sbx.deploy({ hostPath: source, sandboxPath: options.sandboxPath }),
        { added: 0, changed: 0, removed: 0, unchanged: 3, bytesTransferred: 0 });
      // Force a locked-image apply failure. The previous manifest must survive rollback intact.
      fs.appendFileSync(path.join(source, 'HelloSandbox.exe'), Buffer.from([0]));
      fs.writeFileSync(path.join(source, '0-change.txt'), 'rollback');
      await assert.rejects(sbx.deploy({ hostPath: source, sandboxPath: options.sandboxPath }), /previous files restored/);
      const rolledBack = await sbx.exec({ command: "[IO.File]::ReadAllText('C:\\apps\\DeployProof\\0-change.txt')" });
      assert.equal(rolledBack.stdout.trim(), 'other');
      fs.writeFileSync(path.join(source, '0-change.txt'), 'other');
      const restart = check(await sbx.deploy(options), { added: 0, changed: 1, removed: 0, unchanged: 2 });
      assert.ok(restart.stopped.includes(deletion.launch.pid));
      const verify = await sbx.exec({ command: `$sha=[Security.Cryptography.SHA256]::Create(); [BitConverter]::ToString($sha.ComputeHash([IO.File]::ReadAllBytes('C:\\apps\\DeployProof\\0-change.txt'))).Replace('-','').ToLowerInvariant(); Test-Path -LiteralPath 'C:\\apps\\DeployProof\\delete.txt'` });
      assert.equal(verify.exitCode, 0);
      assert.match(verify.stdout, new RegExp(createHash('sha256').update('other').digest('hex')));
      assert.match(verify.stdout, /False/);
      // Exercise directory/file replacement and nested/empty directory synchronization.
      fs.mkdirSync(path.join(source, 'nested'));
      fs.writeFileSync(path.join(source, 'nested', 'file'), 'nested');
      fs.rmSync(path.join(source, 'empty'), { recursive: true });
      fs.writeFileSync(path.join(source, 'empty'), 'now a file');
      const topology = check(await sbx.deploy({ hostPath: source, sandboxPath: options.sandboxPath }),
        { added: 2, changed: 0, removed: 0, unchanged: 3 });
      fs.unlinkSync(path.join(source, 'empty'));
      fs.mkdirSync(path.join(source, 'empty'));
      fs.unlinkSync(path.join(source, 'nested', 'file'));
      fs.rmdirSync(path.join(source, 'nested'));
      const restored = check(await sbx.deploy({ hostPath: source, sandboxPath: options.sandboxPath }),
        { added: 0, changed: 0, removed: 2, unchanged: 3, bytesTransferred: 0 });
      const screenshot = await sbx.screenshot({ pid: restart.launch.pid, name: `deploy-${network}` });
      const proof = { network, first, second, deletion, noop, restart, topology, restored,
        guestVerification: verify.stdout.trim(), screenshot: screenshot.path };
      evidence.push(proof);
      console.log(JSON.stringify(proof));
    } finally {
      if (started) await sbx.stopSandbox();
    }
  }
} finally {
  fs.rmSync(source, { recursive: true, force: true });
}
console.log(`PASS: verified incremental deploy, deletion, no-op, running-image rollback and restart over ${evidence.length} transports`);
