import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { atomicJson, readJson, withStateLock } from './coordination.js';
import { STALE_BOOT } from './protocol.js';
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;

export function reserveRecording(home, target, recording) {
  return withStateLock(home, () => {
    const stateFile = path.join(home, 'current.json');
    const recoveryFile = path.join(home, 'recording.json');
    const state = readJson(stateFile);
    if (!state || state.id !== target.id || state.epoch !== target.epoch) throw new Error(STALE_BOOT);
    if (state.recording || readJson(recoveryFile)) throw new Error('A recording is already tracked. Stop it to publish its evidence first.');
    atomicJson(recoveryFile, { id: target.id, epoch: target.epoch, recording });
    state.recording = recording;
    atomicJson(stateFile, state);
  });
}

export function clearRecording(home, target, recordingId) {
  withStateLock(home, () => {
    for (const name of ['current.json', 'recording.json']) {
      const file = path.join(home, name), state = readJson(file);
      if (state?.id !== target.id || state?.epoch !== target.epoch || state?.recording?.recordingId !== recordingId) continue;
      if (name === 'recording.json') fs.rmSync(file);
      else { delete state.recording; atomicJson(file, state); }
    }

  });
}

export function releaseEmptyRecording(home, target, recording, confirmedStopped) {
  if (!confirmedStopped) return false;
  const manifest = path.join(recording.directory, 'frames.jsonl');
  let text;
  try {
    if (fs.statSync(manifest).size > MAX_MANIFEST_BYTES) throw new Error(`Recording manifest too large; recovery retained at ${recording.directory}.`);
    text = fs.readFileSync(manifest, 'utf8');
  }
  catch (e) { if (e.code !== 'ENOENT') throw e; text = ''; }
  if (parseFrames(text).frames.length) return false;
  clearRecording(home, target, recording.recordingId);
  return true;
}

export function recordingOptions({ fps = 2, maxDurationSec = 120, maxFrames = Math.min(600, fps * maxDurationSec) } = {}) {
  for (const [key, value, max] of [['fps', fps, 5], ['maxDurationSec', maxDurationSec, 300], ['maxFrames', maxFrames, 600]]) {
    if (!Number.isInteger(value) || value < 1 || value > max) throw new Error(`${key} must be an integer from 1 to ${max}.`);
  }
  return { fps, maxDurationSec, maxFrames };
}

/** Only an incomplete final write may be skipped after a guest crash. Never accept share-supplied paths. */
export function parseFrames(text) {
  const lines = text.replace(/^\uFEFF/, '').split('\n');
  const frames = [], warnings = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    let f;
    try { f = JSON.parse(lines[i]); } catch {
      if (i === lines.length - 1) { warnings.push('Incomplete final manifest line retained after interruption.'); break; }
      throw new Error(`Invalid recording manifest line ${i + 1}.`);
    }
    if (f.file !== `frame-${String(frames.length).padStart(6, '0')}.png` ||
        !Number.isFinite(f.elapsedMs) || f.elapsedMs < 0 || f.elapsedMs > 360_000 ||
        (frames.length && f.elapsedMs < frames.at(-1).elapsedMs) ||
        !Number.isFinite(f.scale) || f.scale <= 0 || f.scale > 1 ||
        ![f.left, f.top, f.width, f.height, f.imageWidth, f.imageHeight].every(Number.isInteger) ||
        f.width < 1 || f.height < 1 || f.width > 32768 || f.height > 32768 ||
        f.imageWidth < 1 || f.imageWidth > 1280 || f.imageHeight < 1 || f.imageHeight > 32768 ||
        typeof f.timestamp !== 'string' || !Number.isFinite(Date.parse(f.timestamp)) || frames.length >= 600) {
      throw new Error(`Invalid recording frame at line ${i + 1}.`);
    }
    frames.push(f);
  }
  return { frames, warnings };
}

const theme = `
:root {
  color-scheme: light;
  --cp-bg: #f7f4ef;
  --cp-bg-elevated: #fcfbf8;
  --cp-surface: #ffffff;
  --cp-surface-soft: #f5f5f5;
  --cp-border: #dedede;
  --cp-border-strong: #919191;
  --cp-text: #242424;
  --cp-text-muted: #5c5c5c;
  --cp-text-soft: #6f6f6f;
  --cp-accent: #b11f4b;
  --cp-accent-hover: #9a1a41;
  --cp-accent-soft: rgba(177, 31, 75, 0.08);
  --cp-accent-fg: #ffffff;
  --cp-success: #16a34a;
  --cp-danger: #dc2626;
  --cp-warning: #f59e0b;
  --cp-link: #0078d4;
  --cp-shadow: 0 18px 48px rgba(0, 0, 0, 0.12);
  --cp-overlay: rgba(255, 255, 255, 0.8);
  --cp-panel: rgba(255, 255, 255, 0.86);
  --cp-panel-strong: rgba(255, 255, 255, 0.96);
  --cp-sheen: rgba(255, 255, 255, 0.55);
  --cp-highlight: rgba(177, 31, 75, 0.12);
}
html[data-theme="dark"] {
  color-scheme: dark;
  --cp-bg: #3d3b3a;
  --cp-bg-elevated: #343231;
  --cp-surface: #292929;
  --cp-surface-soft: #2e2e2e;
  --cp-border: #474747;
  --cp-border-strong: #5f5f5f;
  --cp-text: #dedede;
  --cp-text-muted: #919191;
  --cp-text-soft: #b0b0b0;
  --cp-accent: #fd8ea1;
  --cp-accent-hover: #fb7b91;
  --cp-accent-soft: rgba(253, 142, 161, 0.14);
  --cp-accent-fg: #1a1a1a;
  --cp-success: #4ade80;
  --cp-danger: #f87171;
  --cp-warning: #fbbf24;
  --cp-link: #4da6ff;
  --cp-shadow: 0 18px 48px rgba(0, 0, 0, 0.32);
  --cp-overlay: rgba(41, 41, 41, 0.88);
  --cp-panel: rgba(41, 41, 41, 0.72);
  --cp-panel-strong: rgba(41, 41, 41, 0.96);
  --cp-sheen: rgba(255, 255, 255, 0.04);
  --cp-highlight: rgba(253, 142, 161, 0.12);
}`;

export function renderFlipbook(frames, images, warnings) {
  const data = JSON.stringify({ frames, images, warnings }).replace(/</g, '\\u003c');
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Sandbox recording</title>
<script>
  (() => {
    const param = new URLSearchParams(window.location.search).get("scoutTheme");
    const theme =
      param || (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    document.documentElement.setAttribute("data-theme", theme);
  })();
</script>
<style>${theme}
body{background:var(--cp-bg);color:var(--cp-text);font-family:"Segoe UI",Aptos,Calibri,-apple-system,BlinkMacSystemFont,sans-serif;max-width:1280px;margin:24px auto;padding:16px}
img{display:block;max-width:100%;height:auto;border:1px solid var(--cp-border);border-radius:0.625rem;background:var(--cp-surface)}
button{background:var(--cp-accent);color:var(--cp-accent-fg);border:0;border-radius:0.625rem;padding:8px 16px}
input{width:60%;accent-color:var(--cp-accent)}pre{white-space:pre-wrap;color:var(--cp-text-muted);font-family:Consolas,"Courier New",Courier,monospace}
</style><h1>Sandbox recording</h1><p id="warning"></p>
<button id="play" type="button">Play</button> <input id="frame" aria-label="Frame" type="range" min="0" max="${Math.max(0, frames.length - 1)}" value="0">
<p id="caption" aria-live="polite"></p><img id="image" alt="Captured Sandbox desktop"><pre id="details"></pre>
<script>
const data=${data}, slider=document.getElementById('frame'), button=document.getElementById('play');
let timer=null;
function pause(){clearTimeout(timer);timer=null;button.textContent='Play'}
function show(){const i=Number(slider.value),f=data.frames[i];if(!f)return;
document.getElementById('image').src=data.images[i];
document.getElementById('caption').textContent=(i+1)+' / '+data.frames.length+' - '+f.timestamp+' ('+(f.elapsedMs/1000).toFixed(2)+'s)';
document.getElementById('details').textContent=JSON.stringify(f,null,2)}
function tick(){show();const i=Number(slider.value);if(i>=data.frames.length-1){pause();return}
timer=setTimeout(()=>{slider.value=i+1;tick()},Math.max(10,data.frames[i+1].elapsedMs-data.frames[i].elapsedMs))}
button.onclick=()=>{if(timer!==null){pause();return}if(Number(slider.value)>=data.frames.length-1)slider.value=0;button.textContent='Pause';tick()};
slider.oninput=()=>{pause();show()};
document.getElementById('warning').textContent=data.warnings.join(' ');show();
</script></html>`;
}

/** Guest output is untrusted; keep all raw evidence and report publication problems explicitly. */
export async function publishRecording(directory, fps = 2) {
  const manifest = path.join(directory, 'frames.jsonl');
  if (!fs.existsSync(manifest)) throw new Error(`No recording frames; partial evidence retained at ${directory}.`);
  if (fs.statSync(manifest).size > MAX_MANIFEST_BYTES) throw new Error(`Recording manifest too large; retained at ${directory}.`);
  const { frames, warnings } = parseFrames(fs.readFileSync(manifest, 'utf8'));
  if (!frames.length) throw new Error(`No complete recording frames; evidence retained at ${directory}.`);
  const statusPath = path.join(directory, 'status.json');
  if (fs.existsSync(statusPath)) {
    try {
      if (fs.statSync(statusPath).size > 65536) throw new Error('status is too large');
      const status = JSON.parse(fs.readFileSync(statusPath, 'utf8').replace(/^\uFEFF/, ''));
      if (!Number.isInteger(status.frames) || status.frames !== frames.length ||
          !Number.isFinite(status.durationMs) || status.durationMs < 0 ||
          (status.error !== null && typeof status.error !== 'string')) throw new Error('status fields do not match captured frames');
      if (status.error) warnings.push(`Guest recorder stopped early; partial evidence: ${status.error}`);
    } catch (e) {
      warnings.push(`Recorder status is invalid or incomplete; publishing partial evidence (${e.message}). Raw status retained.`);
    }
  } else warnings.push('Recorder did not finish normally; this is partial evidence.');
  const partial = warnings.length > 0;
  let bytes = 0;
  const images = frames.map((f) => {
    const p = path.join(directory, f.file), stat = fs.lstatSync(p);
    if (!stat.isFile() || stat.isSymbolicLink() || (bytes += stat.size) > 256 * 1024 * 1024) {
      throw new Error(`Recording images exceed publication limits; raw evidence retained at ${directory}.`);
    }
    const png = fs.readFileSync(p);
    if (!png.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) throw new Error(`Invalid PNG: ${f.file}`);
    return `data:image/png;base64,${png.toString('base64')}`;
  });
  const htmlPath = path.join(directory, 'recording.html');
  const writeHtml = () => {
    const temporary = path.join(directory, `recording-${randomBytes(8).toString('hex')}.html.tmp`);
    fs.writeFileSync(temporary, renderFlipbook(frames, images, warnings));
    fs.renameSync(temporary, htmlPath);
  };
  writeHtml();
  const mp4Path = path.join(directory, 'recording.mp4');
  const mp4Attempt = path.join(directory, `recording-${randomBytes(8).toString('hex')}.mp4`);
  const encoded = await new Promise((resolve) => execFile('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-framerate', String(fps),
    '-i', path.join(directory, 'frame-%06d.png'), '-frames:v', String(frames.length),
    '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', mp4Attempt,
  ], { timeout: 120_000, windowsHide: true }, (error, stdout, stderr) => resolve({ error, stderr })));
  if (encoded.error) warnings.push(encoded.error.code === 'ENOENT'
    ? 'ffmpeg is not on PATH; share the self-contained HTML flipbook.'
    : `MP4 encoding failed; share the HTML flipbook. ${String(encoded.stderr || encoded.error.message).slice(0, 1000)}`);
  else fs.renameSync(mp4Attempt, mp4Path);
  writeHtml();
  return { directory, manifestPath: manifest, htmlPath, ...(encoded.error ? {} : { mp4Path }),
    frames: frames.length, durationMs: frames.at(-1).elapsedMs, partial, warnings };
}
