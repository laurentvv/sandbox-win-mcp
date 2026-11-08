import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { hostManifest, diffManifests, assertStable, stageDeployment, deployDirectory } from '../../src/deploy.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-deploy-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  fs.mkdirSync(source);
  return { root, source };
}

test('manifest includes SHA256, file sizes, nested and empty directories', (t) => {
  const { source } = fixture(t);
  fs.writeFileSync(path.join(source, 'hello.txt'), 'hello');
  fs.mkdirSync(path.join(source, 'empty'));
  const m = hostManifest(source);
  assert.deepEqual(m.directories, ['empty']);
  assert.deepEqual(m.files, [{ path: 'hello.txt', size: 5, sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824' }]);
});

test('manifest diff counts added, changed, removed, unchanged case-insensitively', () => {
  const f = (p, sha256 = 'a', size = 1) => ({ path: p, sha256, size });
  const delta = diffManifests({ files: [f('same'), f('changed'), f('gone')] },
    { files: [f('SAME', 'A'), f('changed', 'b'), f('new')] });
  assert.deepEqual(Object.fromEntries(Object.entries(delta).map(([k, v]) => [k, v.map((f) => f.path)])),
    { added: ['new'], changed: ['changed'], removed: ['gone'], unchanged: ['SAME'] });
});

test('rejects a junction in the source and a junction source root', (t) => {
  const { root, source } = fixture(t);
  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside);
  const link = path.join(source, 'linked');
  fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => hostManifest(source), /[Ss]ymlink|[Rr]eparse/);
  assert.throws(() => hostManifest(link), /[Ss]ymlink|[Rr]eparse/);
});

test('rejects source paths beneath a junction ancestor', (t) => {
  const { root, source } = fixture(t);
  fs.mkdirSync(path.join(source, 'child'));
  const link = path.join(root, 'linked');
  fs.symlinkSync(source, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => hostManifest(path.join(link, 'child')), /[Ss]ymlink|[Rr]eparse/);
});

test('stages only changed files and detects same-size writes before apply', (t) => {
  const { root, source } = fixture(t);
  fs.writeFileSync(path.join(source, 'one'), 'old');
  fs.writeFileSync(path.join(source, 'two'), 'same');
  const before = hostManifest(source);
  fs.writeFileSync(path.join(source, 'one'), 'new');
  const after = hostManifest(source);
  const delta = diffManifests(before, after);
  const stage = path.join(root, 'stage');
  stageDeployment(source, stage, after, delta.changed);
  assert.deepEqual(fs.readdirSync(stage), ['one']);
  assert.throws(() => stageDeployment(source, path.join(root, 'dirty'), before, before.files), /build output changed during deploy; rerun/);
});

test('dirty detection includes additions, deletions, and empty directory changes', (t) => {
  const { source } = fixture(t);
  const original = hostManifest(source);
  fs.mkdirSync(path.join(source, 'new'));
  assert.throws(() => assertStable(original, hostManifest(source)), /build output changed/);
  fs.writeFileSync(path.join(source, 'file'), 'x');
  const withFile = hostManifest(source);
  fs.unlinkSync(path.join(source, 'file'));
  assert.throws(() => assertStable(withFile, hostManifest(source)), /build output changed/);
});

test('rescan catches a previously unchanged source file modified after staging', (t) => {
  const { root, source } = fixture(t);
  fs.writeFileSync(path.join(source, 'one'), 'original');
  fs.writeFileSync(path.join(source, 'two'), 'before');
  const manifest = hostManifest(source), copy = fs.copyFileSync;
  t.mock.method(fs, 'copyFileSync', (from, to) => {
    copy(from, to);
    fs.writeFileSync(path.join(source, 'two'), 'after!');
  });
  assert.throws(() => stageDeployment(source, path.join(root, 'stage'), manifest, [manifest.files[0]]),
    /build output changed during deploy; rerun/);
});

test('source changes during guest manifest query never reach apply', async (t) => {
  const { root, source } = fixture(t);
  fs.writeFileSync(path.join(source, 'file'), 'first');
  let applied = false, allowed = false;
  await assert.rejects(deployDirectory({ hostPath: source }, {
    checkAllowed: () => { allowed = true; },
    getSandbox: async () => ({ runDir: root }),
    call: async (op) => {
      if (op === 'deploy_manifest') {
        fs.writeFileSync(path.join(source, 'file'), 'other');
        return { files: [], directories: [] };
      }
      applied = true;
    },
  }), /build output changed during deploy; rerun/);
  assert.equal(allowed, true);
  assert.equal(applied, false);
  assert.deepEqual(fs.readdirSync(path.join(root, 'in')), []);
});

test('deploy reports verified delta and rejects restart without a launch', async (t) => {
  const { root, source } = fixture(t);
  fs.writeFileSync(path.join(source, 'file'), 'data');
  const driver = { checkAllowed() {}, getSandbox: async () => ({ runDir: root }),
    call: async (op) => op === 'deploy_manifest' ? { files: [], directories: [] } : { verified: true, stopped: [] } };
  const result = await deployDirectory({ hostPath: source }, driver);
  assert.equal(result.added, 1);
  assert.equal(result.bytesTransferred, 4);
  assert.equal(result.verified, true);
  await assert.rejects(deployDirectory({ hostPath: source, restart: true }, driver), /requires --launch/);
});

test('deleted source files fail as dirty, not as a partial apply', (t) => {
  const { root, source } = fixture(t);
  fs.writeFileSync(path.join(source, 'gone'), 'data');
  const manifest = hostManifest(source);
  fs.unlinkSync(path.join(source, 'gone'));
  assert.throws(() => stageDeployment(source, path.join(root, 'stage'), manifest, manifest.files),
    /build output changed during deploy; rerun/);
});

test('deploy pins the captured boot generation across manifest, staging and apply', async (t) => {
  const { root, source } = fixture(t);
  fs.writeFileSync(path.join(source, 'file'), 'data');
  const target = { id: 'same-provider-id', epoch: 'original-boot', runDir: root };
  let captures = 0;
  const calls = [];
  await deployDirectory({ hostPath: source }, {
    checkAllowed() {},
    getSandbox: async () => { captures++; return target; },
    call: async (op, params, timeout, pinned) => {
      assert.equal(pinned, target);
      assert.equal(pinned.epoch, 'original-boot');
      calls.push(op);
      return op === 'deploy_manifest' ? { files: [], directories: [] } : { verified: true, stopped: [] };
    },
  });
  assert.equal(captures, 1);
  assert.deepEqual(calls, ['deploy_manifest', 'deploy_apply']);
});

test('allowed-root denial happens before scanning or contacting the sandbox', async () => {
  await assert.rejects(deployDirectory({ hostPath: 'not-allowed' }, {
    checkAllowed: () => { throw new Error('outside SANDBOX_MCP_ALLOWED_ROOTS'); },
    getSandbox: () => assert.fail('must not contact sandbox'),
  }), /outside SANDBOX_MCP_ALLOWED_ROOTS/);
});

test('public deploy honors SANDBOX_MCP_ALLOWED_ROOTS without touching a running Sandbox', (t) => {
  const { root, source } = fixture(t);
  const script = `import assert from 'node:assert/strict';
import { deploy } from ${JSON.stringify(new URL('../../src/core.js', import.meta.url).href)};
await assert.rejects(deploy({hostPath:${JSON.stringify(source)}}), /outside SANDBOX_MCP_ALLOWED_ROOTS/);`;
  execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, SANDBOX_MCP_ALLOWED_ROOTS: path.join(root, 'allowed') },
  });
});

test('guest manifest and path helpers handle empty directories and reject escapes and reparse points', (t) => {
  const { root, source } = fixture(t);
  fs.writeFileSync(path.join(source, 'file.txt'), 'hello');
  fs.mkdirSync(path.join(source, 'empty'));
  const helper = fileURLToPath(new URL('../../agent/deploy.ps1', import.meta.url));
  const ps = (body) => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `$ErrorActionPreference='Stop'; . '${helper.replaceAll("'", "''")}'; ${body}`], { encoding: 'utf8' });
  const literal = source.replaceAll("'", "''");
  const m = JSON.parse(ps(`$m=Get-DeployManifest '${literal}'; Assert-DeployManifest $m $m; $m | ConvertTo-Json -Depth 5 -Compress`));
  assert.deepEqual(m.directories, ['empty']);
  assert.equal(m.files[0].path, 'file.txt', 'relative paths remain correct when TEMP uses an 8.3 ancestor spelling');
  assert.equal(m.files[0].sha256, hostManifest(source).files[0].sha256);
  for (const relative of ['..\\escape', 'C:\\escape', 'file.txt:ads', 'a\\..\\b']) {
    assert.match(ps(`try { Join-DeployPath '${literal}' '${relative}'; throw 'accepted invalid path' } catch { $_.Exception.Message }`),
      /Invalid deployment relative path/);
  }
  assert.match(ps("try { Get-DeployRoot 'C:\\sbx\\agent' } catch { $_.Exception.Message }"), /Protected deployment destination/);
  fs.symlinkSync(root, path.join(source, 'link'), 'junction');
  assert.match(ps(`try { Get-DeployManifest '${literal}' } catch { $_.Exception.Message }`), /Reparse point not allowed/);
});
