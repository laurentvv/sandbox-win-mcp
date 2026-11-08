// Real Sandbox proof. Caller must serialize access to the machine's single Sandbox.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import * as sbx from '../src/core.js';
import { parseFrames } from '../src/recording.js';
import { runApp } from '../src/run.js';

const cli = (...args) => JSON.parse(execFileSync(process.execPath, ['src\\cli.js', ...args, '--json'], { encoding: 'utf8' }));
const hasFfmpeg = !spawnSync('ffmpeg', ['-version'], { windowsHide: true }).error;
assert.ok(process.env.SANDBOX_MCP_HOME, 'Set an isolated SANDBOX_MCP_HOME before running live evidence tests.');

for (const network of ['on', 'off']) {
  let owned;
  try {
    const boot = await sbx.startSandbox({ network, window: 'minimized' });
    owned = boot;
    assert.equal(boot.desktop.ready, true);
    console.log(JSON.stringify({ network, desktopReadySeconds: boot.desktopReadySeconds, steps: boot.steps }));
    assert.equal((await sbx.status()).desktop.inputDesktop, 'Default');
    const app = await sbx.launch({ path: 'C:\\Windows\\System32\\charmap.exe' });
    const window = await sbx.screenshot({ pid: app.pid, maxWidth: 400 });
    const savedCapture = (await sbx.current()).lastShot;
    console.log(JSON.stringify({ savedCapture, process: await sbx.processInfo(app.pid) }));
    assert.ok(savedCapture.windowHandle, 'window capture must retain its native window identity');
    const desktop = await sbx.screenshot();
    assert.notEqual(window.captureId, desktop.captureId);
    await sbx.click({ x: 100, y: 10, coordinates: 'screenshot', captureId: window.captureId });
    await assert.rejects(() => sbx.click({ x: -1, y: 10, coordinates: 'screenshot', captureId: window.captureId }), /outside capture/);
    const moved = await sbx.exec({ command: `Add-Type -Name Move -Namespace Proof -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetWindowPos(System.IntPtr h,System.IntPtr after,int x,int y,int cx,int cy,uint flags);'; [Proof.Move]::SetWindowPos([IntPtr][long]${savedCapture.windowHandle},[IntPtr]::Zero,${window.left + 60},${window.top + 60},0,0,5)` });
    assert.equal(moved.exitCode, 0, moved.stderr);
    console.log(JSON.stringify({ capture: window.captureId, captured: [window.left, window.top], moved: moved.stdout, windows: await sbx.windows() }));
    await assert.rejects(() => sbx.click({ x: 100, y: 100, coordinates: 'screenshot', captureId: window.captureId }), /moved, resized/);
    console.log(`${network}: explicit older capture maps independently; out-of-bounds and stale window rejected; artifacts ${boot.outDir}`);
    let recording;
    if (network === 'on') {
      const client = new Client({ name: 'evidence-proof', version: '1.0.0' });
      await client.connect(new StdioClientTransport({ command: process.execPath, args: ['src\\server.js'], env: { ...process.env }, stderr: 'inherit' }));
      try {
        const tools = await client.listTools();
        assert.ok(tools.tools.find((t) => t.name === 'sandbox_record_start'));
        const call = async (name, args = {}) => {
          const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 180_000 });
          assert.ok(!r.isError, JSON.stringify(r));
          return JSON.parse(r.content.find((c) => c.type === 'text').text);
        };
        await call('sandbox_record_start', { fps: 2, maxDurationSec: 8, maxFrames: 6 });
        await sbx.exec({ command: 'Start-Sleep -Seconds 4' });
        recording = await call('sandbox_record_stop');
      } finally { await client.close(); }
    } else {
      cli('record', 'start', '--fps', '2', '--duration', '8', '--max-frames', '6');
      await sbx.exec({ command: 'Start-Sleep -Seconds 4' });
      recording = cli('record', 'stop');
    }
    assert.equal(recording.frames, 6);
    assert.equal(recording.stopped, true);
    assert.equal(recording.partial, false, JSON.stringify(recording.warnings));
    assert.ok(fs.statSync(recording.htmlPath).size > 10000);
    assert.equal(parseFrames(fs.readFileSync(recording.manifestPath, 'utf8')).frames.length, 6);
    if (hasFfmpeg) {
      assert.ok(fs.statSync(recording.mp4Path).size > 1000, JSON.stringify(recording));
      const decode = spawnSync('ffmpeg', ['-v', 'error', '-i', recording.mp4Path, '-f', 'null', '-'], { encoding: 'utf8', windowsHide: true });
      assert.equal(decode.status, 0, decode.stderr);
    }
    console.log(JSON.stringify({ network, recording }));
    if (network === 'off') {
      const interrupted = await sbx.recordStart({ fps: 2, maxDurationSec: 10 });
      const killed = await sbx.exec({ command: `Start-Sleep -Seconds 1; Stop-Process -Id ${interrupted.pid} -Force` });
      assert.equal(killed.exitCode, 0, killed.stderr);
      const partial = await sbx.recordStop();
      assert.equal(partial.partial, true);
      assert.ok(partial.frames >= 1);
      assert.ok(fs.existsSync(partial.htmlPath));
      assert.ok(fs.existsSync(partial.manifestPath));
      console.log(JSON.stringify({ interruptedRecorderEvidence: partial }));
    }
  } finally {
    if (owned) {
      const stopped = await sbx.stopSandbox({ target: owned });
      assert.ok(!stopped.recordingError, stopped.recordingError);
      assert.deepEqual(await sbx.listSandboxes(), []);
    }
  }
}
const run = await runApp({ app: 'C:\\Windows\\System32\\charmap.exe', network: 'off', window: 'minimized', waitSec: 1, record: true });
assert.equal(run.pass, true, JSON.stringify(run.failures));
assert.ok(run.recording.frames > 0);
assert.match(fs.readFileSync(run.reportPath, 'utf8'), /Self-contained HTML flipbook/);
console.log(JSON.stringify({ oneShotRecordedRun: { reportPath: run.reportPath, recording: run.recording } }));
