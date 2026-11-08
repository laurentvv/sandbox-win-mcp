import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const dirty = () => new Error('build output changed during deploy; rerun');
const key = (p) => p.toLowerCase();
function hash(file) {
  const digest = createHash('sha256'), buffer = Buffer.allocUnsafe(1024 * 1024);
  const fd = fs.openSync(file, 'r');
  try {
    let bytes;
    while ((bytes = fs.readSync(fd, buffer, 0, buffer.length, null))) digest.update(buffer.subarray(0, bytes));
    return digest.digest('hex');
  } finally { fs.closeSync(fd); }
}

// Node identifies junctions as symbolic links, but other Windows reparse tags need the native attributes.
function rejectReparsePoints(root) {
  if (process.platform !== 'win32') return;
  const script = `$ErrorActionPreference='Stop'
$root=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(root).toString('base64')}'))
function Check($p) {
  $i=Get-Item -LiteralPath $p -Force
  if ($i.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Reparse point not allowed: $p" }
}
$p=$root
while ($p) { Check $p; $p=Split-Path -Parent $p }
$stack=New-Object 'Collections.Generic.Stack[string]'
$stack.Push($root)
while ($stack.Count) {
  foreach ($i in Get-ChildItem -LiteralPath $stack.Pop() -Force) {
    Check $i.FullName
    if ($i.PSIsContainer) { $stack.Push($i.FullName) }
  }
}`;
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    throw new Error(`Cannot scan deployment source (symlinks/junctions/reparse points are not allowed): ${e.stderr?.toString() || e.message}`);
  }
}

export function hostManifest(root) {
  root = path.resolve(root);
  for (let p = root; ; p = path.dirname(p)) {
    if (fs.lstatSync(p).isSymbolicLink()) throw new Error(`Symlink/junction/reparse point not allowed: ${p}`);
    if (path.dirname(p) === p) break;
  }
  if (!fs.lstatSync(root).isDirectory()) throw new Error('deploy requires a host directory');
  rejectReparsePoints(root);
  const files = [], directories = [];
  function walk(dir, relative = '') {
    for (const name of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, name), rel = relative ? `${relative}\\${name}` : name;
      const before = fs.lstatSync(full);
      if (before.isSymbolicLink()) throw new Error(`Symlink/junction/reparse point not allowed: ${full}`);
      if (before.isDirectory()) { directories.push(rel); walk(full, rel); }
      else if (before.isFile()) {
        const sha256 = hash(full), after = fs.lstatSync(full);
        if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) throw dirty();
        files.push({ path: rel, size: after.size, sha256 });
      } else throw new Error(`Unsupported deployment file: ${full}`);
    }
  }
  walk(root);
  return { files, directories };
}

export function diffManifests(before, after) {
  const old = new Map((before.files || []).map((f) => [key(f.path), f]));
  const added = [], changed = [], unchanged = [];
  for (const f of after.files) {
    const previous = old.get(key(f.path));
    if (!previous) added.push(f);
    else if (previous.size !== f.size || previous.sha256.toLowerCase() !== f.sha256.toLowerCase()) changed.push(f);
    else unchanged.push(f);
    old.delete(key(f.path));
  }
  return { added, changed, removed: [...old.values()], unchanged };
}

export function assertStable(before, after) {
  const delta = diffManifests(before, after);
  const dirs = (m) => (m.directories || []).map(key).sort().join('\n');
  if (delta.added.length || delta.changed.length || delta.removed.length || dirs(before) !== dirs(after)) throw dirty();
}

export function stageDeployment(source, stage, manifest, changed) {
  fs.mkdirSync(stage, { recursive: true });
  try {
    for (const f of changed) {
      const from = path.join(source, f.path), to = path.join(stage, f.path);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
      if (fs.statSync(to).size !== f.size || hash(to) !== f.sha256) throw dirty();
    }
    assertStable(manifest, hostManifest(source));
  }
  catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') throw dirty();
    throw e;
  }
}

export async function deployDirectory({ hostPath, sandboxPath, launch, args, restart = false }, driver) {
  const started = Date.now(), source = path.resolve(hostPath);
  driver.checkAllowed(source);
  if (restart && !launch) throw new Error('deploy --restart requires --launch <exe> to relaunch the app');
  const destination = sandboxPath || `C:\\apps\\${path.basename(source)}`;
  const manifest = hostManifest(source);
  const s = await driver.getSandbox();
  const before = await driver.call('deploy_manifest', { destination }, 600_000, s);
  const delta = diffManifests(before, manifest);
  const stageName = `deploy-${randomUUID()}`, stage = path.join(s.runDir, 'in', stageName);
  try {
    stageDeployment(source, stage, manifest, [...delta.added, ...delta.changed]);
    const result = await driver.call('deploy_apply', {
      destination, from: `C:\\sbx\\in\\${stageName}`, manifest, before,
      changed: [...delta.added, ...delta.changed], removed: delta.removed,
      restart, launch, args,
    }, 600_000, s);
    if (result?.verified !== true) throw new Error('Guest did not confirm deployment hash verification');
    return { path: destination, added: delta.added.length, changed: delta.changed.length, removed: delta.removed.length,
      unchanged: delta.unchanged.length, bytesTransferred: [...delta.added, ...delta.changed].reduce((n, f) => n + f.size, 0),
      ms: Date.now() - started, ...result };
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
}
