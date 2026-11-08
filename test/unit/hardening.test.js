import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkAllowedPath, UNRESTRICTED_ROOTS_WARNING, reportEnvelope } from '../../src/core.js';

test('empty roots allow everything but carry the unrestricted warning (lesson 7)', () => {
  const r = checkAllowedPath('C:\\Windows\\System32\\charmap.exe', []);
  assert.equal(r.allowed, true);
  assert.match(r.warning, /SANDBOX_MCP_ALLOWED_ROOTS is empty/);
  assert.match(UNRESTRICTED_ROOTS_WARNING, /semicolon-separated/);
});

test('configured roots accept paths inside and throw with the root list for paths outside', () => {
  const inside = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-roots-in-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-roots-out-'));
  const file = path.join(inside, 'build.exe');
  fs.writeFileSync(file, 'x');
  try {
    const ok = checkAllowedPath(file, [inside]);
    assert.equal(ok.allowed, true);
    assert.equal(ok.warning, undefined);
    assert.throws(() => checkAllowedPath(path.join(outside, 'evil.exe'), [inside]),
      new RegExp(`outside SANDBOX_MCP_ALLOWED_ROOTS.*${inside.replace(/[\\/\\\\]/g, '\\\\')}`));
    // case and trailing-separator differences do not bypass the check
    assert.equal(checkAllowedPath(file.toUpperCase(), [inside + '\\']).allowed, true);
  } finally {
    fs.rmSync(inside, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('a nonexistent candidate path yields the roots error, not ENOENT', () => {
  assert.throws(() => checkAllowedPath('C:\\definitely\\not\\there.exe', ['D:\\roots']), /outside SANDBOX_MCP_ALLOWED_ROOTS/);
});

test('nonexistent roots still confine: resolution falls back to path.resolve', () => {
  assert.throws(() => checkAllowedPath('C:\\Windows\\notepad.exe', ['D:\\does\\not\\exist']), /outside SANDBOX_MCP_ALLOWED_ROOTS/);
});

test('report envelope: versioned schema header wraps the flow result unchanged', () => {
  for (const kind of ['run', 'install-test', 'detonate']) {
    const e = reportEnvelope(kind, { pass: true, shots: [] });
    assert.equal(e.schema, `sandbox-win-mcp/${kind}-report@1`);
    assert.equal(e.schemaVersion, 1);
    assert.equal(e.kind, kind);
    assert.ok(!Number.isNaN(Date.parse(e.generatedAt)));
    assert.deepEqual(e.result, { pass: true, shots: [] });
  }
});
