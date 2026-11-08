import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync, spawn } from 'node:child_process';
import { recordingOptions, parseFrames, renderFlipbook, publishRecording, clearRecording, reserveRecording, releaseEmptyRecording } from '../../src/recording.js';
import { renderReport, runFailures } from '../../src/run.js';

const frame = { file: 'frame-000000.png', timestamp: '2026-11-07T01:00:00Z', elapsedMs: 120,
  left: -100, top: 0, width: 100, height: 100, imageWidth: 100, imageHeight: 100, scale: 1,
  foregroundWindow: { title: '</script><img src=x onerror=alert(1)>' } };
test('recording defaults and hard limits', () => {
  assert.deepEqual(recordingOptions(), { fps: 2, maxDurationSec: 120, maxFrames: 240 });
  assert.equal(recordingOptions({ fps: 5, maxDurationSec: 300 }).maxFrames, 600);
  for (const options of [{ fps: 0 }, { fps: 6 }, { fps: 1.5 }, { maxDurationSec: 301 }, { maxFrames: 601 }]) {
    assert.throws(() => recordingOptions(options), /must be an integer/);
  }
});
test('manifest preserves complete lines after interruption and rejects paths or invalid metadata', () => {
  const parsed = parseFrames(`${JSON.stringify(frame)}\n{"file":`);
  assert.equal(parsed.frames.length, 1);
  assert.equal(parsed.warnings.length, 1);
  for (const patch of [{ file: '..\\outside.png' }, { file: 'frame-000001.png' }, { elapsedMs: -1 }, { scale: 0 }, { imageWidth: 1281 }]) {
    assert.throws(() => parseFrames(JSON.stringify({ ...frame, ...patch })), /Invalid recording frame/);
  }
  assert.throws(() => parseFrames('broken\n' + JSON.stringify(frame)), /manifest line 1/);
});
test('self-contained flipbook safely displays guest-controlled titles and responds to controls', () => {
  const html = renderFlipbook([frame], ['data:image/png;base64,abc'], []);
  assert.ok(!html.includes('</script><img'));
  const nodes = Object.fromEntries(['frame', 'play', 'image', 'caption', 'details', 'warning'].map((id) => [id, { value: '0' }]));
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)[1];
  vm.runInNewContext(script, { document: { getElementById: (id) => nodes[id] }, setTimeout, clearTimeout });
  assert.equal(nodes.image.src, 'data:image/png;base64,abc');
  assert.match(nodes.details.textContent, /onerror=alert/);
  nodes.play.onclick();
  assert.equal(nodes.play.textContent, 'Play');
  nodes.frame.oninput();
});
test('flipbook playback follows manifest timestamps and can pause or seek', () => {
  const second = { ...frame, file: 'frame-000001.png', elapsedMs: 820 };
  const html = renderFlipbook([frame, second], ['first', 'second'], []);
  const nodes = Object.fromEntries(['frame', 'play', 'image', 'caption', 'details', 'warning'].map((id) => [id, { value: '0' }]));
  let pending, delay, cleared = 0;
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)[1];
  vm.runInNewContext(script, { document: { getElementById: (id) => nodes[id] },
    setTimeout: (callback, ms) => { pending = callback; delay = ms; return 42; }, clearTimeout: () => { cleared++; } });
  nodes.play.onclick();
  assert.equal(nodes.play.textContent, 'Pause');
  assert.equal(delay, 700);
  nodes.play.onclick();
  assert.equal(nodes.play.textContent, 'Play');
  assert.equal(cleared, 1);
  nodes.play.onclick();
  pending();
  assert.equal(nodes.image.src, 'second');
  assert.equal(nodes.play.textContent, 'Play');
  nodes.frame.value = '0';
  nodes.frame.oninput();
  assert.equal(nodes.image.src, 'first');
});
test('publishing without ffmpeg produces a portable HTML and keeps partial evidence', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-recording-'));
  const previous = process.env.PATH;
  try {
    fs.writeFileSync(path.join(dir, 'frames.jsonl'), JSON.stringify(frame) + '\n{"partial":');
    fs.writeFileSync(path.join(dir, frame.file), Buffer.from('89504e470d0a1a0a', 'hex'));
    process.env.PATH = '';
    const r = await publishRecording(dir);
    assert.equal(r.frames, 1);
    assert.ok(fs.existsSync(r.htmlPath));
    assert.ok(fs.existsSync(r.manifestPath));
    assert.ok(r.warnings.some((w) => w.includes('ffmpeg is not on PATH')));
    assert.ok(r.warnings.some((w) => w.includes('partial evidence')));
    assert.equal(r.partial, true);
    assert.equal(r.mp4Path, undefined);
  } finally {
    process.env.PATH = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test('truncated or invalid final status still publishes partial evidence without changing the raw status', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-recording-status-'));
  const previous = process.env.PATH;
  try {
    fs.writeFileSync(path.join(dir, 'frames.jsonl'), JSON.stringify(frame) + '\n');
    fs.writeFileSync(path.join(dir, frame.file), Buffer.from('89504e470d0a1a0a', 'hex'));
    process.env.PATH = '';
    for (const raw of ['{"frames":1,"durationMs":', 'null', '{"frames":50,"durationMs":100,"error":null}']) {
      fs.writeFileSync(path.join(dir, 'status.json'), raw);
      const r = await publishRecording(dir);
      assert.equal(r.partial, true);
      assert.ok(r.warnings.some((w) => w.includes('status is invalid or incomplete')));
      assert.ok(fs.readFileSync(r.htmlPath, 'utf8').includes('partial evidence'));
      assert.equal(fs.readFileSync(path.join(dir, 'status.json'), 'utf8'), raw);
      assert.ok(fs.existsSync(path.join(dir, frame.file)));
    }
    fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify({ frames: 1, durationMs: 200, error: null }));
    assert.equal((await publishRecording(dir)).partial, false, 'missing encoder does not make complete frames partial');
  } finally {
    process.env.PATH = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test('record stop recovers preserved evidence after current() clears a crashed guest', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-recording-recovery-'));
  try {
    const fakeWsb = path.join(dir, 'wsb.exe').replace(/'/g, "''");
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `Add-Type -OutputAssembly '${fakeWsb}' -OutputType ConsoleApplication -TypeDefinition 'public class FakeWsb { public static void Main() { System.Console.WriteLine("{\\"WindowsSandboxEnvironments\\":[]}"); } }'`],
    { windowsHide: true });
    const recordingDir = path.join(dir, 'frames');
    fs.mkdirSync(recordingDir);
    fs.writeFileSync(path.join(recordingDir, 'frames.jsonl'), JSON.stringify(frame) + '\n');
    fs.writeFileSync(path.join(recordingDir, frame.file), Buffer.from('89504e470d0a1a0a', 'hex'));
    const state = { id: 'crashed-guest', recording: { recordingId: 'test', directory: recordingDir, fps: 2 } };
    fs.writeFileSync(path.join(dir, 'current.json'), JSON.stringify(state));
    fs.writeFileSync(path.join(dir, 'recording.json'), JSON.stringify(state));
    const coreUrl = new URL('../../src/core.js', import.meta.url).href;
    fs.unlinkSync(path.join(recordingDir, frame.file));
    execFileSync(process.execPath, ['--input-type=module', '-e',
      `import assert from 'node:assert/strict'; import fs from 'node:fs'; import * as sbx from ${JSON.stringify(coreUrl)};
      await assert.rejects(sbx.recordStop(), /ENOENT/);
      assert.ok(fs.existsSync(${JSON.stringify(path.join(dir, 'recording.json'))}));`],
    { env: { ...process.env, SANDBOX_MCP_HOME: dir, PATH: dir }, encoding: 'utf8', windowsHide: true });
    fs.writeFileSync(path.join(recordingDir, frame.file), Buffer.from('89504e470d0a1a0a', 'hex'));
    const output = execFileSync(process.execPath, ['--input-type=module', '-e',
      `import * as sbx from ${JSON.stringify(coreUrl)}; if(await sbx.current() !== null) throw new Error('guest should be gone'); console.log(JSON.stringify(await sbx.recordStop()));`],
    { env: { ...process.env, SANDBOX_MCP_HOME: dir, PATH: dir }, encoding: 'utf8', windowsHide: true });
    const result = JSON.parse(output);
    assert.equal(result.stopped, true);
    assert.equal(result.partial, true);
    assert.equal(result.frames, 1);
    assert.ok(fs.existsSync(result.htmlPath));
    assert.ok(fs.existsSync(path.join(recordingDir, frame.file)));
    assert.ok(!fs.existsSync(path.join(dir, 'current.json')));
    assert.ok(!fs.existsSync(path.join(dir, 'recording.json')));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('recording reservations are atomic and cleanup preserves counters and replacement epochs', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-recording-owners-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const target = { id: 'guest', epoch: 'boot', protocolSeq: 40, mailboxSeq: 50 };
  fs.writeFileSync(path.join(dir, 'current.json'), JSON.stringify(target));
  const module = new URL('../../src/recording.js', import.meta.url).href;
  const outcomes = await Promise.all(['one', 'two'].map((recordingId) => new Promise((resolve, reject) => {
    const code = `import {reserveRecording} from ${JSON.stringify(module)};
      try { reserveRecording(${JSON.stringify(dir)}, ${JSON.stringify(target)}, {recordingId:${JSON.stringify(recordingId)}});
      console.log('reserved'); } catch(e) { if(!e.message.includes('already tracked')) throw e; console.log('busy'); }`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', code]);
    let stdout = '', stderr = '';
    child.stdout.on('data', (data) => stdout += data);
    child.stderr.on('data', (data) => stderr += data);
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr)));
  })));
  assert.deepEqual(outcomes.sort(), ['busy', 'reserved']);
  const stateFile = path.join(dir, 'current.json');
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const recovery = JSON.parse(fs.readFileSync(path.join(dir, 'recording.json'), 'utf8'));
  assert.equal(state.recording.recordingId, recovery.recording.recordingId);
  assert.equal(state.protocolSeq, 40);
  assert.equal(state.mailboxSeq, 50);
  const replacement = { ...state, epoch: 'new-boot' };
  fs.writeFileSync(stateFile, JSON.stringify(replacement));
  clearRecording(dir, target, state.recording.recordingId);
  assert.deepEqual(JSON.parse(fs.readFileSync(stateFile, 'utf8')), replacement);
});

test('a guest-rejected zero-frame start releases only a confirmed inactive reservation', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-recording-rejected-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fakeWsb = path.join(dir, 'wsb.exe').replace(/'/g, "''");
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `Add-Type -OutputAssembly '${fakeWsb}' -OutputType ConsoleApplication -TypeDefinition 'public class FakeWsb { public static void Main() { System.Console.WriteLine("{\\"WindowsSandboxEnvironments\\":[{\\"Id\\":\\"guest\\"}]}"); } }'`],
  { windowsHide: true });
  const core = new URL('../../src/core.js', import.meta.url).href;
  const protocol = new URL('../../src/protocol.js', import.meta.url).href;
  const code = `import fs from 'node:fs'; import path from 'node:path'; import net from 'node:net'; import assert from 'node:assert/strict';
    import {createFramer} from ${JSON.stringify(protocol)}; import * as sbx from ${JSON.stringify(core)};
    const key='aa'.repeat(32), framer=createFramer(key,'boot');
    const server=net.createServer(socket=>{ let data=''; socket.on('data',chunk=>{
      data+=chunk; if(!data.includes('\\n')) return;
      const frame=JSON.parse(data), request=framer.open(frame,'request');
      const error=request.op==='recordstart'?'desktop not interactive':'No matching recording in this agent.';
      socket.end(JSON.stringify(framer.seal({ok:false,error},'response',frame.counter))+'\\n');
    }); });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const target={id:'guest',epoch:'boot',protocolSeq:0,runDir:sbx.HOME,identity:{protocolVersion:2},
      ip:'127.0.0.1',port:server.address().port};
    fs.mkdirSync(path.join(sbx.HOME,'agent')); fs.writeFileSync(path.join(sbx.HOME,'agent','token.txt'),key);
    fs.writeFileSync(path.join(sbx.HOME,'current.json'),JSON.stringify(target));
    try { for(let i=0;i<2;i++) {
      await assert.rejects(sbx.recordStart({},target),/desktop not interactive.*confirmed inactive reservation released/);
      assert.ok(!fs.existsSync(path.join(sbx.HOME,'recording.json')));
      assert.ok(!JSON.parse(fs.readFileSync(path.join(sbx.HOME,'current.json'),'utf8')).recording);
    } assert.equal(JSON.parse(fs.readFileSync(path.join(sbx.HOME,'current.json'),'utf8')).protocolSeq,4);
    } finally { await new Promise(resolve=>server.close(resolve)); }`;
  execFileSync(process.execPath, ['--input-type=module', '-e', code], {
    env: { ...process.env, SANDBOX_MCP_HOME: dir, PATH: dir }, encoding: 'utf8', windowsHide: true, timeout: 15_000,
  });
  const target = { id: 'guest', epoch: 'boot' };
  const recording = { recordingId: 'uncertain', directory: path.join(dir, 'frames') };
  reserveRecording(dir, target, recording);
  assert.equal(releaseEmptyRecording(dir, target, recording, false), false);
  assert.ok(fs.existsSync(path.join(dir, 'recording.json')), 'uncertain starts must retain recovery');
  fs.mkdirSync(recording.directory);
  fs.writeFileSync(path.join(recording.directory, 'frames.jsonl'), JSON.stringify(frame) + '\n');
  assert.equal(releaseEmptyRecording(dir, target, recording, true), false, 'a real frame with a missing PNG must remain recoverable');
  const manifest = path.join(recording.directory, 'frames.jsonl');
  const fd = fs.openSync(manifest, 'r+');
  try { fs.ftruncateSync(fd, 8 * 1024 * 1024 + 1); }
  finally { fs.closeSync(fd); }
  assert.throws(() => releaseEmptyRecording(dir, target, recording, true), /manifest too large; recovery retained/);
  assert.ok(fs.existsSync(path.join(dir, 'recording.json')));
  assert.equal(fs.statSync(manifest).size, 8 * 1024 * 1024 + 1);
});
test('run report links recording artifacts', () => {
  const dir = path.join(os.tmpdir(), 'sbx-report');
  const r = { app: 'app.exe', hostDir: dir, outDir: dir, runDir: dir, pass: true, mode: 'gui',
    seconds: 1, startedAt: frame.timestamp, shots: [], collected: [], recording: {
      htmlPath: path.join(dir, 'recording.html'), mp4Path: path.join(dir, 'recording.mp4'),
      manifestPath: path.join(dir, 'frames.jsonl'), frames: 2, warnings: [],
    } };
  const report = renderReport(r);
  assert.match(report, /\[Self-contained HTML flipbook\]\(recording.html\)/);
  assert.match(report, /\[MP4 video\]\(recording.mp4\)/);
  assert.deepEqual(runFailures({ recordingError: 'publication denied', recording: { stopped: false, partial: true } }), [
    'recording: publication denied', 'recorder did not stop; partial evidence retained', 'recording is partial (see recording warnings)',
  ]);
});
