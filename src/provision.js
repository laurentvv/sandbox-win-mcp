// Explicit opt-in only: verified downloads happen on the host, never on the network-isolated guest.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as sbx from './core.js';
import { scanDependencies } from './deps.js';
import { atomicJson, readJson, withStateLock } from './coordination.js';

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
const FRAMEWORKS = {
  'Microsoft.NETCore.App': 'runtime',
  'Microsoft.WindowsDesktop.App': 'windowsdesktop',
  'Microsoft.AspNetCore.App': 'aspnetcore-runtime',
};
const arches = new Set(['x86', 'x64', 'arm64']);
const official = (url) => {
  const u = new URL(url);
  if (u.protocol !== 'https:' || !['aka.ms', 'download.visualstudio.microsoft.com', 'download.microsoft.com',
    'builds.dotnet.microsoft.com', 'dotnetcli.azureedge.net', 'dotnetcli.blob.core.windows.net',
    'ci.dot.net'].includes(u.hostname)) throw new Error(`Not an approved Microsoft download URL: ${url}`);
  return u;
};

async function downloadResponse(url) {
  for (let i = 0; i < 10; i++) {
    official(url);
    const r = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(120_000) });
    if ([301, 302, 303, 307, 308].includes(r.status)) {
      await r.body?.cancel();
      const location = r.headers.get('location');
      if (!location) throw new Error(`Microsoft download redirect has no Location: ${url}`);
      url = new URL(location, url).href;
      continue;
    }
    if (!r.ok) { await r.body?.cancel(); throw new Error(`Microsoft download failed: HTTP ${r.status} (${url})`); }
    return r;
  }
  throw new Error('Too many Microsoft download redirects');
}

export function planProvision(scan, requested) {
  if (typeof requested !== 'string' || !requested.trim()) throw new Error('Provisioning requires auto or a comma-separated component list');
  let items;
  if (requested === 'auto') {
    items = [];
    for (const r of scan.requirements) {
      if (r.status === 'missing') {
        if (!FRAMEWORKS[r.component] && r.component !== 'VC++ redistributable') {
          throw new Error(`Cannot auto-provision ${r.component}. ${r.remediation}`);
        }
        items.push({ component: r.component, version: r.version, architecture: r.architecture, rollForward: r.rollForward, applyPatches: r.applyPatches });
      } else {
        const war = /^Microsoft\.WindowsAppRuntime\.(\d+\.\d+)$/.exec(r.component);
        if (war) items.push({ component: 'Windows App Runtime', version: war[1], architecture: r.architecture || 'unknown' });
        else if (r.component === 'Windows App Runtime' && r.status !== 'app-local') {
          throw new Error('Windows App Runtime version cannot be inferred. Pass --provision windows-app-runtime:<major.minor>:<architecture> explicitly.');
        } else if (r.status === 'unknown') {
          throw new Error(`Cannot auto-provision an unknown requirement: ${r.component}. ${r.remediation}`);
        }
      }
    }
  } else {
    items = requested.split(',').map((token) => {
      const [name, version, architecture, extra] = token.trim().split(':');
      const component = ({ vcredist: 'VC++ redistributable', dotnet: 'Microsoft.NETCore.App',
        desktop: 'Microsoft.WindowsDesktop.App', aspnetcore: 'Microsoft.AspNetCore.App', 'windows-app-runtime': 'Windows App Runtime' })[name];
      if (!component || extra) throw new Error(`Unknown provision component: ${token}`);
      if (name === 'vcredist') {
        if (architecture) throw new Error('Use vcredist:<architecture>');
        return { component, architecture: version || 'x64' };
      }
      if (!/^\d+\.\d+(?:\.\d+)?$/.test(version || '')) throw new Error(`Use ${name}:<version>:<architecture> (for example desktop:10.0:x64)`);
      return { component, version, architecture: architecture || 'x64', rollForward: 'LatestPatch' };
    });
  }
  for (const item of items) {
    if (!arches.has(item.architecture)) throw new Error(`Cannot provision ${item.component} for unknown architecture; supply an explicit component list.`);
    if (FRAMEWORKS[item.component] && !/^\d+\.\d+(?:\.\d+)?$/.test(item.version || '')) throw new Error(`Cannot resolve runtime version ${item.version}`);
  }
  const exact = (r) => r.rollForward === 'Disable' || r.applyPatches === false;
  const unique = [];
  for (const item of items) {
    const previous = unique.find((x) => x.component === item.component && x.version === item.version && x.architecture === item.architecture);
    if (!previous) unique.push({ ...item });
    else if (exact(item)) { previous.rollForward = 'Disable'; previous.applyPatches = false; }
  }
  if (requested === 'auto') {
    for (const item of unique.filter((r) => FRAMEWORKS[r.component])) {
      const channel = item.version.split('.').slice(0, 2).join('.');
      const other = unique.find((r) => FRAMEWORKS[r.component] && r.architecture === item.architecture &&
        r.version.split('.').slice(0, 2).join('.') === channel && r !== item &&
        (r.component === item.component || [r.component, item.component].every((c) => ['Microsoft.NETCore.App', 'Microsoft.WindowsDesktop.App'].includes(c))) &&
        (exact(item) || exact(r)) && (r.version !== item.version || exact(item) !== exact(r)));
      if (other) throw new Error(`Conflicting auto runtime policies for ${item.component} and ${other.component}. An exact runtime cannot be replaced by a newer desktop bundle; use an explicit installer list and verify the app's required versions.`);
    }
  }
  // The desktop runtime bundle also installs the same-channel core runtime.
  return unique.filter((r) => !(r.component === 'Microsoft.NETCore.App' &&
    unique.some((x) => x.component === 'Microsoft.WindowsDesktop.App' && x.version === r.version && x.architecture === r.architecture)));
}

export function selectDotnetFile(metadata, item) {
  const key = FRAMEWORKS[item.component], channel = item.version.split('.').slice(0, 2).join('.');
  const minimum = item.version.split('.').map(Number);
  const acceptable = (v) => {
    if (!/^\d+\.\d+\.\d+$/.test(v || '')) return false;
    const parts = v.split('.').map(Number);
    if (parts.slice(0, 2).join('.') !== channel) return false;
    if (item.rollForward === 'Disable' || item.applyPatches === false) return v === item.version;
    return parts[2] >= (minimum[2] || 0);
  };
  const candidates = (metadata.releases || []).map((r) => r[key]).filter((r) => r && acceptable(r.version))
    .sort((a, b) => Number(b.version.split('.')[2]) - Number(a.version.split('.')[2]));
  for (const release of candidates) {
    const file = release.files?.find((f) => f.rid === `win-${item.architecture}` && /\.exe$/i.test(f.name));
    if (file) {
      official(file.url);
      if (!/^[a-f0-9]{128}$/i.test(file.hash || '')) throw new Error('Official .NET metadata has no valid SHA-512 hash');
      return { ...item, version: release.version, url: file.url, sha512: file.hash.toLowerCase(), args: '/install /quiet /norestart' };
    }
  }
  throw new Error(`No compatible official ${item.component} installer for ${item.version} ${item.architecture} (rollForward ${item.rollForward || 'Minor'}).`);
}

async function resolveInstaller(item) {
  if (FRAMEWORKS[item.component]) {
    const channel = item.version.split('.').slice(0, 2).join('.');
    const response = await downloadResponse(`https://dotnetcli.blob.core.windows.net/dotnet/release-metadata/${channel}/releases.json`);
    return selectDotnetFile(await response.json(), item);
  }
  if (item.component === 'VC++ redistributable') return { ...item,
    url: `https://aka.ms/vc14/vc_redist.${item.architecture}.exe`, args: '/install /quiet /norestart' };
  if (item.component === 'Windows App Runtime') {
    if (!/^\d+\.\d+$/.test(item.version)) throw new Error('Windows App Runtime requires a major.minor release channel');
    return { ...item, url: `https://aka.ms/windowsappsdk/${item.version}/latest/windowsappruntimeinstall-${item.architecture}.exe`, args: '--quiet' };
  }
  throw new Error(`Unsupported redistributable: ${item.component}`);
}

async function verify(file, expected) {
  const hash = createHash(expected ? 'sha512' : 'sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  const digest = hash.digest('hex');
  if (expected && digest !== expected.toLowerCase()) throw new Error(`SHA-512 mismatch for ${file}`);
  const script = `$ErrorActionPreference='Stop'; Import-Module ($PSHOME+'\\Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1') -Force; $s=Get-AuthenticodeSignature -LiteralPath ${q(file)}; if ($s.Status -ne 'Valid' -or $s.SignerCertificate.Subject -notmatch '(^|,\\s*)O=Microsoft Corporation(,|$)') { throw ('Not a valid Microsoft-signed installer: '+$s.Status) }; $v=[Diagnostics.FileVersionInfo]::GetVersionInfo(${q(file)}); @{signer=$s.SignerCertificate.Subject;fileVersion=$v.FileVersion;productVersion=$v.ProductVersion} | ConvertTo-Json -Compress`;
  const signature = await new Promise((resolve, reject) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
    { timeout: 120_000, windowsHide: true }, (err, stdout, stderr) => err ? reject(new Error(`Installer signature verification failed: ${stderr || err.message}`)) : resolve(stdout.trim())));
  return { algorithm: expected ? 'sha512' : 'sha256', hash: digest, ...JSON.parse(signature) };
}

export async function prepareProvision(scan, requested) {
  const prepared = [];
  for (const item of planProvision(scan, requested)) {
    const installer = await resolveInstaller(item);
    const cache = path.join(sbx.HOME, 'cache', 'redistributables');
    fs.mkdirSync(cache, { recursive: true });
    const name = createHash('sha256').update(installer.url + (installer.sha512 || '')).digest('hex') + '.exe';
    const file = path.join(cache, name);
    if (!fs.existsSync(file)) {
      const partial = `${file}.${randomUUID()}.partial`;
      try {
        sbx.log(`downloading ${installer.component} ${installer.version || ''} ${installer.architecture} on the host`);
        const response = await downloadResponse(installer.url);
        await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(partial, { flags: 'wx' }));
        const verification = await verify(partial, installer.sha512);
        fs.renameSync(partial, file);
        prepared.push({ ...installer, file, verification });
      } finally {
        if (fs.existsSync(partial)) fs.unlinkSync(partial);
      }
    } else prepared.push({ ...installer, file, verification: await verify(file, installer.sha512) });
  }
  return prepared;
}

export function recordProvisioning(runDir, requested, provisioned) {
  const file = path.join(runDir, 'provisioning.json');
  withStateLock(runDir, () => {
    const previous = readJson(file);
    const records = new Map((previous?.provisioned || []).map((record) => [JSON.stringify(record), record]));
    for (const record of provisioned) records.set(JSON.stringify(record), record);
    atomicJson(file, { cleanMachine: false, requested, provisioned: [...records.values()], updatedAt: new Date().toISOString() });
  });
}

export async function installProvision(prepared, onInstalled = () => {}, target) {
  const installed = [];
  if (prepared.length && !target) target = await sbx.current();
  if (prepared.length && !target) throw new Error('Start a sandbox before provisioning into it.');
  for (const item of prepared) {
    const copied = await sbx.copyIn(item.file, `C:\\sbx-provision\\${path.basename(item.file)}`, target);
    const command = `$ErrorActionPreference='Stop'; $p=Start-Process -FilePath ${q(copied.path)} -ArgumentList ${q(item.args)} -Wait -PassThru; exit $p.ExitCode`;
    const result = await sbx.exec({ command, timeoutSec: 600 }, target);
    // 3010 is a successful install requiring reboot, not proof the current guest is usable.
    if (result.timedOut || result.exitCode !== 0) throw new Error(`Provisioning ${item.component} failed (exit ${result.exitCode}${result.timedOut ? ', timed out' : ''}). ${result.exitCode === 3010 ? 'Installer requires reboot; this run cannot be called a pass.' : result.stderr || result.stdout || ''}`);
    const record = { component: item.component, version: item.version, architecture: item.architecture,
      source: item.url, verification: item.verification, exitCode: result.exitCode };
    installed.push(record);
    onInstalled(record);
  }
  return installed;
}

/** Provision an already-started sandbox; never starts or adopts one. */
export async function provisionSandbox(app, requested) {
  const state = await sbx.current();
  if (!state) throw new Error('Start a sandbox before provisioning into it.');
  const dependencies = scanDependencies(app);
  const prepared = await prepareProvision(dependencies, requested);
  const current = await sbx.status();
  if (!current.running || current.id !== state.id || current.epoch !== state.epoch) throw new Error('Sandbox changed while preparing dependencies; nothing installed.');
  const provisioned = current.provisioning?.provisioned || [];
  recordProvisioning(current.runDir, requested, provisioned);
  const installed = await installProvision(prepared, (record) => {
    provisioned.push(record);
    recordProvisioning(current.runDir, requested, provisioned);
  }, state);
  return { cleanMachine: false, dependencies, provisioned: installed, provenancePath: path.join(current.runDir, 'provisioning.json') };
}
