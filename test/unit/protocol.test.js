import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createFramer, PROTOCOL_VERSION, agentHash } from '../../src/protocol.js';
import { ROOT } from '../../src/core.js';
import path from 'node:path';

const key = '51'.repeat(32);
const epoch = '26ff991c-df76-487c-8537-c21d7278930e';
const frame = () => createFramer(key, epoch);

test('authenticated framing round trips and binds response counter/direction', () => {
  const sender = frame(), receiver = frame();
  const sealed = sender.seal({ op: 'exec', command: '"Hello \u263a"' }, 'request', 1);
  assert.equal(JSON.stringify(sealed).includes(key), false);
  assert.equal(JSON.stringify(sealed).includes('Hello'), false);
  assert.deepEqual(receiver.open(sealed, 'request'), { op: 'exec', command: '"Hello \u263a"' });
  const response = receiver.seal({ ok: true }, 'response', 1);
  assert.deepEqual(sender.open(response, 'response', 1), { ok: true });
  assert.throws(() => frame().open(response, 'response', 2), /counter mismatch/);
  assert.throws(() => frame().open(sealed, 'response', 1), /Invalid authenticated/);
});

test('tamper, wrong key, boot mismatch, protocol mismatch, timestamps and replay are rejected', () => {
  const sealed = frame().seal({ op: 'ping' }, 'request', 1);
  for (const field of ['ciphertext', 'iv', 'mac']) {
    const changed = { ...sealed, [field]: 'A' + sealed[field].slice(1) };
    if (changed[field] === sealed[field]) changed[field] = 'B' + sealed[field].slice(1);
    assert.throws(() => frame().open(changed, 'request'), /authentication failed/);
  }
  assert.throws(() => frame().open({ ...sealed, counter: 2 }, 'request'), /authentication failed/);
  assert.throws(() => createFramer('52'.repeat(32), epoch).open(sealed, 'request'), /authentication failed/);
  assert.throws(() => createFramer(key, 'new-boot').open(sealed, 'request'), /restarted\/replaced/);
  assert.throws(() => frame().open({ ...sealed, version: PROTOCOL_VERSION + 1 }, 'request'), /protocol mismatch/);
  const receiver = frame();
  receiver.open(sealed, 'request');
  assert.throws(() => receiver.open(sealed, 'request'), /replay/);
  const old = createFramer(key, epoch, { now: () => Date.now() - 600_000 }).seal({}, 'request', 2);
  assert.throws(() => frame().open(old, 'request'), /timestamp expired/);
});

test('out-of-order counters within replay window work once and old counters stay rejected', () => {
  const sender = frame(), receiver = frame();
  receiver.open(sender.seal({}, 'request', 4098), 'request');
  receiver.open(sender.seal({}, 'request', 4097), 'request');
  assert.throws(() => receiver.open(sender.seal({}, 'request', 1), 'request'), /replay/);
  assert.throws(() => receiver.open(sender.seal({}, 'request', 4097), 'request'), /replay/);
});

test('PS5.1 C# opens Node frames, rejects replay/tamper/epoch, and Node opens its response', () => {
  const sender = frame();
  const sealed = sender.seal({ op: 'exec', command: '"cross-language \u263a"' }, 'request', 41);
  const tampered = { ...sealed, counter: 42 };
  const wrongBoot = { ...sealed, epoch: 'other-boot' };
  const script = `
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'
    Add-Type -Path '${path.join(ROOT, 'agent', 'protocol.cs')}' -ReferencedAssemblies System.Web.Extensions
    $p = New-Object SbxProtocol '${key}', '${epoch}'
    $text = $p.Open('${JSON.stringify(sealed)}', 'request', 0)
    if (($text | ConvertFrom-Json).command -ne '"cross-language \u263a"') { throw 'plaintext mismatch' }
    try { $null = $p.Open('${JSON.stringify(sealed)}', 'request', 0); throw 'accepted replay' } catch {
      if ($_.Exception.Message -notlike '*replay*') { throw }
    }
    try { $null = $p.Open('${JSON.stringify(tampered)}', 'request', 0); throw 'accepted tamper' } catch {
      if ($_.Exception.Message -notlike '*authentication failed*') { throw }
    }
    try { $null = $p.Open('${JSON.stringify(wrongBoot)}', 'request', 0); throw 'accepted stale boot' } catch {
      if ($_.Exception.Message -notlike '*restarted/replaced*') { throw }
    }
    $p.Seal('{"ok":true,"result":"PS5.1"}', 'response', 41)
  `;
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    encoding: 'utf8', timeout: 120_000,
  });

  assert.deepEqual(sender.open(JSON.parse(out.trim()), 'response', 41), { ok: true, result: 'PS5.1' });
});

test('guest manifest uses the same ordinal file ordering and SHA256 as the host', () => {
  const dir = path.join(ROOT, 'agent');
  const source = fs.readFileSync(path.join(dir, 'agent.ps1'), 'utf8');
  const manifestCode = source.slice(source.indexOf('$agentFiles ='), source.indexOf('if ($identity.protocolVersion')).replaceAll('$PSScriptRoot', '$agentDir');
  assert.ok(manifestCode.includes('[StringComparer]::Ordinal'));
  const script = `$ErrorActionPreference='Stop'; $agentDir='${dir}'; ${manifestCode}; $agentHash`;
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 120_000 });
  assert.equal(out.trim(), agentHash(dir));
});
