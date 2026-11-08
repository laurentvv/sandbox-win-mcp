// Core Windows Sandbox driver shared by the MCP server (server.js) and the sbx CLI (cli.js).
// Host side drives the wsb CLI; a small guest agent (agent/agent.ps1) runs in the sandbox's interactive session.
// State for the one running sandbox lives in %LOCALAPPDATA%\sandbox-win-mcp\current.json so the CLI and MCP share it.
import { execFile, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicJson, readJson, withStateLock, retryFile, createDesktop } from './coordination.js';
import { deployDirectory } from './deploy.js';
import { PROTOCOL_VERSION, STALE_BOOT, agentHash, createFramer } from './protocol.js';
import { mapCapturePoint, captureFile } from './capture.js';
import { recordingOptions, publishRecording, reserveRecording, clearRecording, releaseEmptyRecording } from './recording.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
// Distinct home from upstream sandbox-mcp so the two tools never share current.json/runs.
export const HOME = process.env.SANDBOX_MCP_HOME || path.join(process.env.LOCALAPPDATA || process.cwd(), 'sandbox-win-mcp');
export const GUEST = { agent: 'C:\\sbx\\agent', in: 'C:\\sbx\\in', out: 'C:\\sbx\\out' };
const STATE_FILE = path.join(HOME, 'current.json');
const RECORDING_FILE = path.join(HOME, 'recording.json');
const AGENT_PORT = 5985;
const IDLE_MINUTES = Number(process.env.SANDBOX_MCP_IDLE_MINUTES ?? 30);
const ALLOWED_ROOTS = (process.env.SANDBOX_MCP_ALLOWED_ROOTS || '').split(';').map((s) => s.trim()).filter(Boolean);

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const log = (...a) => console.error('[sbx]', ...a);

/** Versioned envelope for one-shot flow reports: stable JSON schema next to the markdown (mission M3). */
export function reportEnvelope(kind, result) {
  return { schema: `sandbox-win-mcp/${kind}-report@1`, schemaVersion: 1, kind, generatedAt: new Date().toISOString(), result };
}

/** Idle auto-stop minutes for a sandbox boot: explicit per call, sane bounds. */
export function validateIdleMinutes(v) {
  if (v === undefined || v === null || v === '') return IDLE_MINUTES;
  if (typeof v === 'boolean') throw new Error(`idleMinutes must be an integer between 1 and 1440 (got ${JSON.stringify(v)})`);
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 1440) throw new Error(`idleMinutes must be an integer between 1 and 1440 (got ${JSON.stringify(v)})`);
  return n;
}

// ---------- wsb CLI ----------

function wsb(args, timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {
    execFile('wsb.exe', [...args, '--raw'], { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      const text = `${stdout}${stderr}`.trim();
      try { return resolve(JSON.parse(stdout)); } catch {}
      const missing = err?.code === 'ENOENT';
      if (!missing && !err && !text) return resolve({});
      const e = new Error(missing ? 'wsb.exe not found. Install/update Windows Sandbox (Windows 11 24H2+) and launch it once from Start.'
        : `wsb ${args[0]}: ${text || err.message}`);
      // list and start are the first calls anything makes, so a failure there is worth explaining.
      if (missing || ['list', 'start'].includes(args[0])) explainNotReady(e, missing ? 'wsb.exe not found' : e.message).then(reject); else reject(e);
    });
  });
}

// ---------- is this PC ready for Windows Sandbox? ----------

export const ENABLE_SANDBOX = 'Enable-WindowsOptionalFeature -Online -FeatureName Containers-DisposableClientVM -All';

// Non-admin probe. Win32_OptionalFeature InstallState: 1 enabled, 2 disabled, 3 absent.
// One statement per fact: inside a single @{...} literal, one lookup that throws makes PowerShell print nothing at all.
const PROBE = `$ErrorActionPreference = 'SilentlyContinue'
$f = [ordered]@{}
$os = Get-CimInstance Win32_OperatingSystem
$f.caption = "$($os.Caption)" -replace '^Microsoft ', ''
$f.build = [int]$os.BuildNumber
$f.edition = (Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion').EditionID
$f.feature = (Get-CimInstance Win32_OptionalFeature -Filter "Name='Containers-DisposableClientVM'").InstallState
$f.hypervisor = [bool](Get-CimInstance Win32_ComputerSystem).HypervisorPresent
$f.vt = (Get-CimInstance Win32_Processor | Select-Object -First 1).VirtualizationFirmwareEnabled
$f.wsb = (Get-Command wsb.exe).Source
$alias = Join-Path $env:LOCALAPPDATA 'Microsoft\\WindowsApps\\wsb.exe'
if (Test-Path $alias) { $f.alias = $alias }
$f.version = "$((Get-AppxPackage MicrosoftWindows.WindowsSandbox).Version)"
$f.rebootCbs = [bool](Test-Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Component Based Servicing\\RebootPending')
$f.rebootPackages = [bool](Test-Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Component Based Servicing\\PackagesPending')
$f.rebootWu = [bool](Test-Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\WindowsUpdate\\Auto Update\\RebootRequired')
$f.rebootRename = [bool](Get-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Session Manager' -Name PendingFileRenameOperations)
$f | ConvertTo-Json -Compress`;

/** Check whether this PC can run Windows Sandbox (and sbx). Takes a few seconds. Never throws: a probe that fails is reported as a failed check. */
export async function checkSandbox() {
  const facts = await new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PROBE], { timeout: 60_000, windowsHide: true }, (err, stdout, stderr) => {
      try {
        const f = JSON.parse(stdout);
        resolve(f.build ? f : { probeError: 'Windows reported no version information' });
      } catch {
        resolve({ probeError: err?.code === 'ENOENT' ? 'powershell.exe not found' : err?.killed ? 'PowerShell timed out'
          : String(stderr).trim().split(/\r?\n/)[0] || 'PowerShell printed nothing' });
      }
    });
  });
  facts.node = process.versions.node;
  const checks = sandboxChecks(facts);
  return { ok: checks.every((c) => c.ok), checks, facts };
}

/** What's missing and how to fix it, from the facts checkSandbox() gathers. */
export function sandboxChecks(f) {
  const checks = [];
  const add = (ok, detail, fix) => checks.push(ok ? { ok, detail } : { ok, detail, fix });
  if (f.probeError) {
    add(false, `Couldn't read this PC's Windows settings (${f.probeError})`, 'Run "sbx doctor" again from a regular PowerShell window.');
    return checks;
  }
  if (/^(Core|Server)/i.test(f.edition || '')) {
    add(false, `${f.caption} doesn't include Windows Sandbox (Home and Server editions don't)`,
      'Use Windows 11 Pro, Enterprise or Education (to upgrade from Home: Settings > System > Activation).');
    return checks;
  }
  add(f.build >= 26100, `${f.caption}, build ${f.build}`,
    'Update to Windows 11 24H2 (build 26100) or later. Older builds have Windows Sandbox but not the wsb command-line tool sbx drives.');
  const on = f.feature === 1;
  add(on, `Windows Sandbox feature is ${on ? 'on' : 'off'}`, `In an admin PowerShell run: ${ENABLE_SANDBOX}  (then restart)`);
  if (f.hypervisor) add(true, 'Virtualization is on');
  else if (f.vt === false) add(false, "Virtualization is turned off in this PC's firmware", 'Turn on Intel VT-x or AMD-V (SVM) in the UEFI/BIOS settings, then restart.');
  else if (on) add(false, "Windows Sandbox is enabled but isn't running yet", 'Restart Windows.');
  // Lesson 2: "Enabled + RestartNeeded=True" must be its own state, not folded into "not running yet".
  const pendingSources = [];
  if (f.rebootCbs) pendingSources.push('component servicing');
  if (f.rebootPackages) pendingSources.push('pending packages');
  if (f.rebootWu) pendingSources.push('Windows Update');
  if (f.rebootRename) pendingSources.push('pending file rename');
  add(pendingSources.length === 0,
    pendingSources.length ? `A restart is pending (${pendingSources.join(', ')}) - earlier changes are not fully applied yet` : 'No restart is pending',
    'Restart Windows, then run "sbx doctor" again.');
  if (f.wsb) {
    // Lesson 1: wsb lives as an App Execution Alias; say which way it resolved.
    const via = (f.alias && f.wsb.toLowerCase() === f.alias.toLowerCase()) ? ' (App Execution Alias)' : ' (on PATH)';
    add(true, `wsb command-line tool: ${f.wsb}${via}${f.version ? ` (Windows Sandbox ${f.version})` : ''}`);
  }
  else if (f.alias) add(false, `wsb.exe is installed but not on PATH (${f.alias})`, `Add ${path.dirname(f.alias)} to PATH.`);
  else add(false, "The wsb command-line tool isn't installed",
    'Open Windows Sandbox from the Start menu once, then close it: it updates itself from the Microsoft Store, which adds wsb.');
  add(Number(String(f.node).split('.')[0]) >= 20, `Node.js ${f.node}`, 'Install Node.js 20 or later: winget install OpenJS.NodeJS.LTS');
  return checks;
}

export const formatChecks = (checks) => checks.map((c) => `${c.ok ? '✅' : '❌'} ${c.detail}${c.ok ? '' : `\n   Fix: ${c.fix}`}`).join('\n');

async function explainNotReady(e, reason) {
  const r = await checkSandbox().catch(() => null);
  if (!r || r.ok || r.facts.probeError) return e; // if we couldn't read the PC's state, the original error is the better message
  return new Error(`Windows Sandbox isn't ready on this PC (${reason}):\n${formatChecks(r.checks.filter((c) => !c.ok))}\nRun "sbx doctor" to check again.`);
}

// ---------- janitor: orphaned sandbox detection and teardown (lesson 3) ----------

/** Run a PowerShell probe and parse JSON out of it; never throws. */
function ps(script, timeoutMs = 30_000) {
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: timeoutMs, windowsHide: true },
      (err, stdout) => { try { resolve(JSON.parse(stdout)); } catch { resolve(null); } });
  });
}

const JANITOR_PROBE = `$ErrorActionPreference = 'SilentlyContinue'
@{ vm = @(Get-Process vmmemWindowsSandbox).Count
   remoteSession = @(Get-Process WindowsSandboxRemoteSession).Count
   server = @(Get-Process WindowsSandboxServer).Count
   client = @(Get-Process WindowsSandboxClient).Count } | ConvertTo-Json -Compress`;

/**
 * Classify the Windows Sandbox machine state from host process facts + `wsb list` ids.
 * Orphan = the VM worker (vmmemWindowsSandbox) is alive with no attached remote-session
 * client - it holds the singleton slot and ignores the platform CLI until torn down.
 */
export function classifyJanitor(facts, listedIds = []) {
  const listed = Array.isArray(listedIds) ? listedIds : [];
  if (!facts || !facts.vm) return { state: 'clean', orphan: false };
  if (facts.remoteSession > 0) return { state: 'in-use', orphan: false, note: 'a remote session client is attached' };
  return listed.length
    ? { state: 'headless-listed', orphan: true, note: 'listed by wsb but no client process is attached' }
    : { state: 'headless-orphan', orphan: true, note: 'vmmemWindowsSandbox is alive outside the platform' };
}

/** Detect orphaned sandboxes; with fix, tear them down (graceful first, elevation hint last). */
export async function janitor({ fix = false } = {}) {
  const facts = await ps(JANITOR_PROBE);
  const listed = await listSandboxes().catch(() => []);
  const classif = classifyJanitor(facts, listed);
  const result = { facts, listed, ...classif, fixed: false };
  if (!fix || !classif.orphan) {
    result.hint = classif.orphan
      ? 'Orphaned sandbox detected. Re-run with fix:true (sbx janitor --fix) to tear it down.'
      : classif.state === 'in-use' ? 'A sandbox is in use; stop it normally (sandbox_stop).' : 'Nothing to clean.';
    return result;
  }
  const actions = [];
  for (const id of listed) {
    try { await wsb(['stop', '--id', id]); actions.push(`wsb stop ${id.slice(0, 8)}: ok`); }
    catch (e) { actions.push(`wsb stop ${id.slice(0, 8)}: ${e.message}`); }
  }
  if ((facts?.remoteSession ?? 0) + (facts?.server ?? 0) + (facts?.client ?? 0) > 0) {
    await ps('Stop-Process -Name WindowsSandboxRemoteSession,WindowsSandboxServer,WindowsSandboxClient -Force');
    actions.push('client processes stopped');
  }
  await sleep(4000);
  let after = await ps(JANITOR_PROBE);
  if (after?.vm) {
    // Fallback: the user's observed remedy for a stuck singleton slot (needs admin).
    const svc = await ps('try { Restart-Service CmService -Force; "ok" | ConvertTo-Json -Compress } catch { $_.Exception.Message | ConvertTo-Json -Compress }');
    if (svc === 'ok') { actions.push('CmService restarted'); await sleep(5000); after = await ps(JANITOR_PROBE); }
    else actions.push(`CmService restart refused: ${String(svc).slice(0, 120)}`);
  }
  result.actions = actions;
  result.after = after;
  result.fixed = !after?.vm;
  if (!result.fixed) {
    result.elevatedCommand = "Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile','-Command'," +
      '"Restart-Service CmService -Force; Stop-Process -Name vmmemWindowsSandbox -Force"';
    result.hint = 'Could not clear the orphan from this (non-elevated) session. Run elevatedCommand in an admin window.';
  }
  return result;
}

export async function listSandboxes() {
  return ((await wsb(['list'])).WindowsSandboxEnvironments || []).map((e) => e.Id);
}

async function getIp(id) {
  try { return (await wsb(['ip', '--id', id])).Networks?.find((n) => n.IpV4Address)?.IpV4Address; } catch { return null; }
}

// Hardened by default: no clipboard, printer, microphone or camera redirection.
function configXml({ memoryMB, networking = true, vGpu = true }) {
  return '<Configuration>' +
    (networking ? '' : '<Networking>Disable</Networking>') +
    (vGpu ? '' : '<vGPU>Disable</vGPU>') +
    '<ClipboardRedirection>Disable</ClipboardRedirection><PrinterRedirection>Disable</PrinterRedirection>' +
    '<AudioInput>Disable</AudioInput><VideoInput>Disable</VideoInput><ProtectedClient>Enable</ProtectedClient>' +
    (memoryMB ? `<MemoryInMB>${Math.round(memoryMB)}</MemoryInMB>` : '') +
    '</Configuration>';
}

// ---------- state ----------

let verifiedId = null;
const readState = () => readJson(STATE_FILE);
const readRecording = () => readJson(RECORDING_FILE);
function writeState(s) {
  withStateLock(HOME, () => {
    if (s) atomicJson(STATE_FILE, s); else retryFile(() => fs.rmSync(STATE_FILE, { force: true }));
  });
}
function updateState(target, fn) {
  return withStateLock(HOME, () => {
    const s = readState();
    if (!s || s.id !== target.id || s.epoch !== target.epoch) throw new Error(STALE_BOOT);
    const result = fn(s);
    atomicJson(STATE_FILE, s);
    return result;
  });
}
function clearState(target) {
  withStateLock(HOME, () => {
    const state = readState();
    if (state?.id === target.id && state?.epoch === target.epoch) retryFile(() => fs.rmSync(STATE_FILE, { force: true }));
  });
}
let desktop = createDesktop(HOME, {
  owner: process.env.SANDBOX_MCP_WORKFLOW,
  persistent: !!process.env.SANDBOX_MCP_WORKFLOW,
});
let shotOwner = process.env.SANDBOX_MCP_WORKFLOW || 'cli';
export function setDesktopOwner(owner) {
  desktop = createDesktop(HOME, { owner, persistent: true });
  shotOwner = owner;
}
export function releaseDesktop() { return desktop.release(); }

/** The sandbox started by sandbox-mcp/sbx, or null. Verified against `wsb list` once per id per process. */
export async function current() {
  const s = readState();
  if (!s) { verifiedId = null; return null; }
  const generation = `${s.id}:${s.epoch}`;
  if (generation !== verifiedId) {
    if (!(await listSandboxes()).includes(s.id)) { clearState(s); verifiedId = null; return null; }
    verifiedId = generation;
  }
  return s;
}

async function requireSandbox() {
  const s = await current();
  if (!s) throw new Error('No sandbox is running. Start one first (sandbox_start, or `sbx start`).');
  return s;
}

function audit(s, entry) {
  try { fs.appendFileSync(path.join(s.runDir, 'audit.jsonl'), JSON.stringify({ time: new Date().toISOString(), ...entry }) + '\n'); } catch {}
}
const brief = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)
  .map(([k, v]) => [k, typeof v === 'string' && v.length > 300 ? `${v.slice(0, 300)}…` : v]));

// ---------- guest agent channel ----------

function agentCall(target, op, params = {}, timeoutMs = 60_000) {
  if (!target.epoch || target.identity?.protocolVersion !== PROTOCOL_VERSION) {
    throw new Error('Sandbox protocol mismatch. Stop the old sandbox and start a new one with this version.');
  }
  const framer = createFramer(fs.readFileSync(path.join(target.runDir, 'agent', 'token.txt'), 'utf8').trim(), target.epoch);
  if (target.transport === 'files') return fileCall(target, op, params, timeoutMs, framer);
  const counter = updateState(target, (s) => ++s.protocolSeq);
  const request = framer.seal({ op, ...params }, 'request', counter);
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: target.ip, port: target.port });
    let buf = '';
    sock.setEncoding('utf8');
    sock.setTimeout(timeoutMs, () => sock.destroy(Object.assign(new Error(`agent '${op}' timed out after ${timeoutMs}ms`), { code: 'ETIMEDOUT' })));
    sock.on('connect', () => sock.write(JSON.stringify(request) + '\n'));
    sock.on('data', (d) => (buf += d));
    sock.on('error', reject);
    sock.on('end', () => {
      let r;
      try { r = framer.open(JSON.parse(buf.trim()), 'response', counter); } catch (e) { e.fatal = true; return reject(e); }
      r.ok ? resolve(r.result) : reject(Object.assign(new Error(r.error), { guestRejected: true }));
    });
  });
}

// Offline transport (Networking disabled): request files in the read-only "in" share, responses in the "out" share.
// Both sides poll exact file names; direct-path reads through a share are near-instant, directory listings are not.
async function fileCall(target, op, params, timeoutMs, framer) {
  const { reqFile, respFile, counter } = updateState(target, (s) => {
    const n = String((s.mailboxSeq || 0) + 1).padStart(6, '0');
    const counter = ++s.protocolSeq;
    // Reserve durably before publishing. A killed writer leaves a gap, never a reused request number.
    s.mailboxSeq = Number(n);
    atomicJson(STATE_FILE, s);
    const reqFile = path.join(target.runDir, 'in', 'mailbox', `req-${n}.json`);
    const respFile = path.join(target.runDir, 'out', 'mailbox', `resp-${n}.json`);
    atomicJson(reqFile, framer.seal({ op, ...params }, 'request', counter));
    // Publish under the same lock so a later writer cannot move seq.txt backwards.
    retryFile(() => fs.writeFileSync(path.join(path.dirname(reqFile), 'seq.txt'), String(Number(n))));
    return { reqFile, respFile, counter };
  });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(respFile)) {
      let r;
      try { r = JSON.parse(retryFile(() => fs.readFileSync(respFile, 'utf8')).replace(/^\uFEFF/, '')); } catch (e) { e.fatal = true; throw e; }
      try { r = framer.open(r, 'response', counter); } catch (e) { e.fatal = true; throw e; }
      fs.rmSync(respFile, { force: true }); fs.rmSync(reqFile, { force: true });
      return r.ok ? r.result : Promise.reject(Object.assign(new Error(r.error), { guestRejected: true }));
    }
    await sleep(50);
  }
  throw Object.assign(new Error(`agent '${op}' timed out after ${timeoutMs}ms`), { code: 'ETIMEDOUT' });
}

async function call(op, params = {}, timeoutMs = 60_000, target) {
  const s = target || await requireSandbox();
  const t = Date.now();
  try {
    const mutates = ['launch', 'click', 'drag', 'scroll', 'keys', 'uiaction', 'smartclick'].includes(op) ||
      (op === 'deploy_apply' && (params.launch || params.restart)) ||
      (op === 'screenshot' && (params.windowTitle || params.pid));
    const invoke = () => agentCall(s, op, params, timeoutMs);
    const r = await (mutates ? desktop.run(invoke) : invoke());
    audit(s, { op, params: brief(params), ms: Date.now() - t, ok: true });
    return r;
  } catch (e) {
    audit(s, { op, params: brief(params), ms: Date.now() - t, ok: false, error: e.message });
    if (e.code && !(await listSandboxes()).includes(s.id)) {
      clearState(s); verifiedId = null;
      throw new Error('The sandbox is no longer running (closed, crashed, or stopped by its idle timeout). Start a new one.');
    }
    throw e;
  }
}

async function waitFor(fn, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const v = await fn(); if (v) return v; } catch (e) { if (e.fatal) throw e; }
    await sleep(1000);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

function minimizeSandboxWindow() {
  const ps = `Add-Type -Name U -Namespace W -MemberDefinition '[DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr h,int c);';` +
    `Get-Process WindowsSandboxRemoteSession -EA SilentlyContinue | ? MainWindowHandle -ne 0 | % { [W.U]::ShowWindow($_.MainWindowHandle,6) }`;
  execFile('powershell.exe', ['-NoProfile', '-Command', ps], { windowsHide: true }, () => {});
}

// ---------- lifecycle ----------

/**
 * Boot a fresh sandbox and bring up the guest agent.
 * network: 'on' (default), 'firewall' (guest firewall blocks outbound; agent over TCP), 'off' (no network adapter; agent over shared-folder mailbox).
 */
export async function startSandbox({ network = 'on', internet, memoryMB, window = 'normal', vGpu = true, idleMinutes } = {}) {
  if (internet === false && network === 'on') network = 'off';
  const idle = validateIdleMinutes(idleMinutes);
  if (!['on', 'firewall', 'off'].includes(network)) throw new Error(`network must be on, firewall or off (got ${network})`);
  const existing = await listSandboxes();
  if (existing.length) {
    const ours = readState()?.id;
    const facts = await ps(JANITOR_PROBE).catch(() => null);
    const classif = classifyJanitor(facts, existing);
    const e = new Error(`A sandbox is already running (${existing.join(', ')}). Windows allows only one; ` +
      (existing.includes(ours) ? 'stop it first (sandbox_stop / `sbx stop`).' : 'it was not started by sbx; close it or stop it with force.') +
      (classif.orphan ? ` Host process state: ${JSON.stringify(facts)} - this looks ORPHANED (${classif.note}); sandbox_janitor / \`sbx janitor --fix\` can clear it.` : ''));
    e.code = classif.orphan ? 'SBX_ORPHAN' : 'SBX_CONFLICT';
    throw e;
  }
  const t0 = Date.now();
  const stages = []; // structured per-stage boot telemetry (lesson 10)
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const runDir = path.join(HOME, 'runs', stamp);
  for (const d of ['agent', 'in', 'out']) fs.mkdirSync(path.join(runDir, d), { recursive: true });
  if (network === 'off') { fs.mkdirSync(path.join(runDir, 'in', 'mailbox')); fs.writeFileSync(path.join(runDir, 'in', 'mailbox', 'seq.txt'), '0'); }
  const token = randomBytes(32).toString('hex');
  const epoch = randomUUID();
  for (const f of fs.readdirSync(path.join(ROOT, 'agent'))) fs.copyFileSync(path.join(ROOT, 'agent', f), path.join(runDir, 'agent', f));
  fs.writeFileSync(path.join(runDir, 'agent', 'token.txt'), token);
  const identity = { protocolVersion: PROTOCOL_VERSION, agentVersion: VERSION, agentSha256: agentHash(path.join(runDir, 'agent')) };
  atomicJson(path.join(runDir, 'agent', 'identity.json'), { epoch, ...identity });

  const steps = [];
  const step = (name, s) => { const at = ((Date.now() - t0) / 1000).toFixed(2); steps.push(`${Number(at).toFixed(1)}s ${s}`); stages.push({ name, atMs: Math.round((Date.now() - t0)) }); log(s); };
  log(`booting a fresh Windows Sandbox (network ${network})`);
  const config = configXml({ memoryMB, networking: network !== 'off', vGpu });
  const offline = network === 'off';

  // A start issued right after a stop can silently die, so verify it stays up and retry once.
  let id, ip;
  for (let attempt = 1; attempt <= 2 && !ip; attempt++) {
    id = (await wsb(['start', '--config', config])).Id;
    step('wsb-start', `started ${id}`);
    ip = await waitFor(async () => {
      if (!(await listSandboxes()).includes(id)) throw Object.assign(new Error('sandbox exited during boot'), { fatal: true });
      if (!offline) return getIp(id);
      // No network adapter: readiness = the guest accepts exec.
      return (await wsb(['exec', '--id', id, '-r', 'System', '-c', 'cmd /c exit 0'])).ExitCode === 0 && 'none';
    }, 120_000, 'sandbox to boot').catch(async (e) => { if (attempt === 2) throw e; await sleep(5000); return null; });
  }
  step('network-ready', offline ? 'booted (no network)' : `ip ${ip}`);

  const target = {
    id, ip: offline ? null : ip, port: AGENT_PORT, epoch, identity, runDir, network, transport: offline ? 'files' : 'tcp',
    startedAt: new Date().toISOString(), startedByPid: process.pid, seq: 0, mailboxSeq: 0, protocolSeq: 0, lastShot: null,
  };
  try {
    await wsb(['share', '--id', id, '-f', path.join(runDir, 'agent'), '-s', GUEST.agent]);
    await wsb(['share', '--id', id, '-f', path.join(runDir, 'in'), '-s', GUEST.in]);
    await wsb(['share', '--id', id, '-f', path.join(runDir, 'out'), '-s', GUEST.out, '--allow-write']);
    step('shares', 'folders shared');

    // An interactive user session only exists once a remote session is connected.
    spawn('wsb.exe', ['connect', '--id', id], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
    await waitFor(async () => (await wsb(['exec', '--id', id, '-r', 'ExistingLogin', '-c', 'cmd /c exit 0'])).ExitCode === 0,
      90_000, 'user logon session');
    step('user-session', 'user session ready');
    if (window === 'minimized') minimizeSandboxWindow();

    if (network === 'on') {
      await wsb(['exec', '--id', id, '-r', 'System', '-c', `netsh advfirewall firewall add rule name=sbx-agent dir=in action=allow protocol=TCP localport=${AGENT_PORT}`]);
    } else if (network === 'firewall') {
      // Block by default, and also disable every outbound allow rule: the platform ships "Container: allow outbound".
      await wsb(['exec', '--id', id, '-r', 'System', '-c',
        `cmd /c "netsh advfirewall firewall add rule name=sbx-agent dir=in action=allow protocol=TCP localport=${AGENT_PORT} && netsh advfirewall set allprofiles firewallpolicy blockinbound,blockoutbound && netsh advfirewall firewall set rule name=all dir=out new enable=no"`]);
    }
    if (network !== 'on') {
      // Smart App Control ships in evaluation mode and asks the cloud about every new exe/msi; with no internet each
      // lookup hangs ~2 minutes (a 2 MB MSI took 125s instead of 1s). Switch it off in this throwaway guest.
      await wsb(['exec', '--id', id, '-r', 'System', '-c',
        'cmd /c "reg add HKLM\\SYSTEM\\CurrentControlSet\\Control\\CI\\Policy /v VerifiedAndReputablePolicyState /t REG_DWORD /d 0 /f && CiTool.exe --refresh --json"']);
    }
    const agentArgs = `-Port ${AGENT_PORT} -IdleMinutes ${idle}${offline ? ' -Mailbox' : ''}`;
    await wsb(['exec', '--id', id, '-r', 'ExistingLogin', '-c',
      `cmd /c start /min powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ${GUEST.agent}\\agent.ps1 ${agentArgs}`]);
    writeState(target); verifiedId = `${id}:${epoch}`;
    const hello = await waitFor(() => agentCall(target, 'ping', {}, 3000), 60_000, 'guest agent');
    if (hello.epoch !== epoch) throw new Error(STALE_BOOT);
    if (hello.protocolVersion !== identity.protocolVersion) throw new Error(`Sandbox protocol mismatch: expected ${identity.protocolVersion}, got ${hello.protocolVersion}`);
    if (hello.agentVersion !== identity.agentVersion || hello.agentSha256 !== identity.agentSha256) throw new Error('Sandbox agent identity mismatch: staged agent files do not match the running guest.');
    step('agent', `agent up as ${hello.user}`);
    let desktopFacts;
    const desktop = await waitFor(async () => {
      const facts = await agentCall(target, 'desktop', {}, 5000);
      desktopFacts = facts;
      return facts.ready && facts;
    }, 60_000, 'interactive desktop (locked / secure desktop / UAC)').catch((e) => {
      throw new Error(`${e.message}; last desktop facts: ${JSON.stringify(desktopFacts ?? null)}`);
    });
    step('desktop', 'desktop ready (Default input desktop, explorer, capture verified)');
    target.desktop = desktop;
    target.desktopReadySeconds = (Date.now() - t0) / 1000;
    updateState(target, (state) => {
      state.desktop = desktop;
      state.desktopReadySeconds = target.desktopReadySeconds;
    });
    const bootSeconds = (Date.now() - t0) / 1000;
    audit(target, { op: 'start', network, memoryMB, bootSeconds, desktopReadySeconds: target.desktopReadySeconds, desktop, steps, stages, ok: true });
    return { id, ip: target.ip, epoch, identity, network, runDir, outDir: path.join(runDir, 'out'), user: hello.user, desktop, desktopReadySeconds: target.desktopReadySeconds, bootSeconds, steps, stages };
  } catch (e) {
    clearState(target); verifiedId = null;
    await wsb(['stop', '--id', id]).catch(() => {});
    throw new Error(`${e.message}\nSteps:\n${steps.join('\n')}`);
  }
}

export async function stopSandbox({ force = false, target } = {}) {
  const mine = await current();
  if (target && (!mine || mine.id !== target.id || mine.epoch !== target.epoch)) throw new Error(STALE_BOOT);
  const running = await listSandboxes();
  if (!mine && running.length && !force) {
    throw new Error(`A sandbox not started by sbx is running (${running.join(', ')}). Use force to stop it.`);
  }
  const toStop = mine ? running.filter((x) => x === mine.id) : force ? running : [];
  let recording, recordingError;
  if (mine?.recording || (!running.length && readRecording())) {
    try { recording = await recordStop(); } catch (e) { recordingError = e.message; }
  }
  for (const id of toStop) await wsb(['stop', '--id', id]);
  await waitFor(async () => (await listSandboxes()).length === 0, 30_000, 'sandbox to stop');
  if (toStop.length) await sleep(3000); // let the host settle before the next start
  const result = { stopped: toStop, ...(recording ? { recording } : {}), ...(recordingError ? { recordingError } : {}) };
  if (mine) {
    audit(mine, { op: 'stop', ok: true });
    fs.rmSync(path.join(mine.runDir, 'in'), { recursive: true, force: true });
    const outDir = path.join(mine.runDir, 'out');
    result.runDir = mine.runDir;
    result.outDir = outDir;
    result.artifacts = fs.existsSync(outDir)
      ? fs.readdirSync(outDir, { recursive: true }).filter((f) => !f.endsWith('.preview.png') && !f.startsWith('mailbox'))
      : [];
  }
  if (mine) clearState(mine); verifiedId = null;
  return result;
}

/** Fire-and-forget stop that survives this process being killed (used when an MCP client disconnects). */
export function stopDetached(target) {
  return withStateLock(HOME, () => {
    const state = readState();
    if (!target || !target.epoch || state?.id !== target.id || state?.epoch !== target.epoch) return false;
    spawn('wsb.exe', ['stop', '--id', target.id], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    retryFile(() => fs.rmSync(STATE_FILE, { force: true }));
    verifiedId = null;
    return true;
  });
}

export async function status() {
  const s = await current();
  if (!s) return { running: false, otherSandboxes: await listSandboxes() };
  const agent = await agentCall(s, 'ping', {}, 5000).then(() => 'ok', (e) => e.message);
  const provenance = path.join(s.runDir, 'provisioning.json');
  const provisioning = fs.existsSync(provenance) ? JSON.parse(fs.readFileSync(provenance, 'utf8')) : undefined;
  const desktop = await agentCall(s, 'desktop', {}, 5000).catch((e) => ({ ready: false, error: e.message }));
  return { running: true, id: s.id, ip: s.ip, epoch: s.epoch, identity: s.identity, network: s.network, startedAt: s.startedAt, runDir: s.runDir, outDir: path.join(s.runDir, 'out'), agent, provisioning, desktop, desktopReadySeconds: s.desktopReadySeconds, recording: s.recording ?? null };
}

// ---------- operations ----------

/** Lesson 7: empty roots mean UNRESTRICTED copy-in; every such copy carries this warning. */
export const UNRESTRICTED_ROOTS_WARNING = 'SANDBOX_MCP_ALLOWED_ROOTS is empty: any host path can be copied INTO the sandbox. ' +
  'Set it (semicolon-separated host roots, e.g. your build output folders) to confine copy_in/deploy sources.';

/**
 * Pure host-path guard against explicit roots (unit-testable). Returns { allowed: true, warning? }:
 * an empty root list allows everything but flags it; a non-empty list throws for anything outside
 * the roots (real-path aware, so junctions and case differences do not bypass it).
 */
export function checkAllowedPath(p, roots) {
  const list = (roots ?? []).filter(Boolean);
  if (!list.length) return { allowed: true, warning: UNRESTRICTED_ROOTS_WARNING };
  let real;
  try { real = fs.realpathSync.native(p).toLowerCase(); } catch { real = path.resolve(p).toLowerCase(); }
  const ok = list.some((r) => {
    const root = (fs.existsSync(r) ? fs.realpathSync.native(r) : path.resolve(r)).toLowerCase().replace(/[\\/]+$/, '');
    return real === root || real.startsWith(root + path.sep);
  });
  if (!ok) throw new Error(`${p} is outside SANDBOX_MCP_ALLOWED_ROOTS (${list.join('; ')})`);
  return { allowed: true };
}

function checkAllowed(p) {
  return checkAllowedPath(p, ALLOWED_ROOTS);
}

export async function copyIn(hostPath, sandboxPath, target) {
  const s = target || await requireSandbox();
  const src = path.resolve(hostPath);
  if (!fs.existsSync(src)) throw new Error(`Host path not found: ${src}`);
  const guard = checkAllowed(src); // throws outside configured roots; warns when unrestricted
  const base = path.basename(src);
  const seq = updateState(s, (st) => ++st.seq);
  const stage = `${seq}-${base}`; // fresh folder each time avoids the guest's stale directory cache
  fs.cpSync(src, path.join(s.runDir, 'in', stage), { recursive: true });
  const r = await call('copy', { from: `${GUEST.in}\\${stage}`, to: sandboxPath || `C:\\apps\\${base}` }, 600_000, s);
  return guard.warning ? { ...r, warning: guard.warning } : r;
}

export async function copyOut(sandboxPath, name) {
  const s = await requireSandbox();
  const n = (name || sandboxPath.split(/[\\/]/).filter(Boolean).pop() || 'item').replace(/[:*?"<>|]/g, '_');
  if (/[\\/]|\.\./.test(n)) throw new Error(`copy_out name must be a plain file name (got ${JSON.stringify(n)})`);
  const r = await call('copy', { from: sandboxPath, to: `${GUEST.out}\\files\\${n}` }, 600_000, s);
  // Lesson 7: the guest writes the out share; everything landing here is untrusted data.
  const hostPath = path.join(s.runDir, 'out', 'files', n);
  if (!hostPath.toLowerCase().startsWith(path.join(s.runDir, 'out').toLowerCase() + path.sep)) {
    throw new Error('copy_out destination escaped the run out directory');
  }
  return { hostPath, files: r.files, bytes: r.bytes, untrusted: true,
    note: 'Guest-written data is untrusted: treat this file as attacker-controlled.' };
}

export async function deploy(options) {
  const guard = checkAllowedPath(options?.hostPath, ALLOWED_ROOTS); // throws or warns, before any staging
  const r = await deployDirectory(options, { getSandbox: requireSandbox, checkAllowed, call });
  return guard.warning ? { ...r, warning: guard.warning } : r;
}

export async function exec({ command, shell, cwd, timeoutSec = 120 }, target) {
  return call('exec', { command, shell, cwd, timeoutSec }, (timeoutSec + 30) * 1000, target);
}

export async function launch({ path: p, aumid, args, cwd, waitForWindowSec = 15 }) {
  const { activationTarget } = await import('./packaged.js');
  return call('launch', { ...activationTarget({ path: p, aumid }), args, cwd, waitForWindowSec }, (waitForWindowSec + 30) * 1000);
}

export async function processInfo(pid) { return call('process', { pid }); }

export async function windows() { return [].concat((await call('windows')) ?? []); }

export async function recordStart(options = {}, target) {
  const limits = recordingOptions(options);
  const s = target || await requireSandbox();
  const recordingId = randomBytes(16).toString('hex');
  const directory = path.join(s.runDir, 'out', 'recordings', recordingId);
  reserveRecording(HOME, s, { recordingId, directory, ...limits });
  try {
    const result = await call('recordstart', { recordingId, ...limits }, 30_000, s);
    return { ...result, recordingId, directory };
  } catch (e) {
    if (e.guestRejected) {
      try { await recordStop({ recordingId, target: s }); }
      catch (recovery) { e.message += `; recording recovery: ${recovery.message}`; }
    }
    throw e;
  }
}

export async function recordStop({ recordingId, target } = {}) {
  const state = readState();
  const s = state?.recording ? state : readRecording();
  if (!s?.recording) throw new Error('No tracked recording to stop.');
  if ((recordingId && s.recording.recordingId !== recordingId) ||
      (target && (target.id !== s.id || target.epoch !== s.epoch))) throw new Error('Recording ownership changed; refusing to stop another recording.');
  const recording = s.recording;
  const warnings = [];
  let stopped = true;
  if (state?.id === s.id && state?.epoch === s.epoch && (await listSandboxes()).includes(s.id)) {
    try { await call('recordstop', { recordingId: recording.recordingId }, 20_000, state); }
    catch (e) {
      stopped = !!(e.guestRejected && e.message === 'No matching recording in this agent.');
      warnings.push(`Could not stop guest recorder: ${e.message}`);
    }
  } else warnings.push('Sandbox is no longer running; publishing preserved partial evidence.');
  if (releaseEmptyRecording(HOME, s, recording, stopped)) {
    throw new Error('Recording captured no complete frames; confirmed inactive reservation released. Raw evidence retained.');
  }
  const result = await publishRecording(recording.directory, recording.fps);
  if (stopped) clearRecording(HOME, s, recording.recordingId);
  return { recordingId: recording.recordingId, stopped, ...result, warnings: [...warnings, ...result.warnings] };
}

export async function screenshot({ windowTitle, pid, name, maxWidth } = {}) {
  const s = await requireSandbox();
  const r = await call('screenshot', { windowTitle, pid, name, maxWidth }, 60_000, s);
  const dir = path.join(s.runDir, 'out', 'screenshots');
  const previewPath = captureFile(dir, r.preview);
  const imagePath = captureFile(dir, r.file);
  await waitFor(() => fs.existsSync(previewPath), 10_000, 'screenshot file');
  const preview = fs.readFileSync(captureFile(dir, r.preview));
  fs.rmSync(captureFile(dir, r.preview), { force: true });
  updateState(s, (st) => {
    st.lastShot = r;
    (st.lastShots ||= {})[shotOwner] = st.lastShot;
    (st.captures ||= {})[r.captureId] = r;
  });
  return { captureId: r.captureId, scale: r.scale, path: imagePath, width: r.width, height: r.height, left: r.left, top: r.top,
    previewBase64: preview.toString('base64'), previewWidth: r.previewWidth, previewHeight: r.previewHeight };
}

/** coordinates: 'screenshot' = pixels in the last screenshot preview image; 'screen' = raw sandbox screen pixels. */
export async function click({ x, y, button, double, coordinates = 'screen', captureId }) {
  if (!['screen', 'screenshot'].includes(coordinates)) throw new Error('coordinates must be screen or screenshot.');
  if (![x, y].every(Number.isFinite)) throw new Error('x and y must be finite numbers.');
  let sx = x, sy = y;
  const s = await requireSandbox();
  if (coordinates === 'screenshot') {
    const shot = captureId ? s.captures?.[captureId] : s.lastShots?.[shotOwner];
    ({ x: sx, y: sy } = mapCapturePoint(shot, x, y));
    captureId = shot.captureId;
  }
  return call('click', { x: sx, y: sy, button, double, captureId }, 60_000, s);
}

/** Mouse-down at (x1,y1), animated move to (x2,y2), mouse-up. Coordinates as for click(). */
export async function drag({ x1, y1, x2, y2, durationMs, coordinates = 'screen', captureId }) {
  if (!['screen', 'screenshot'].includes(coordinates)) throw new Error('coordinates must be screen or screenshot.');
  if (![x1, y1, x2, y2].every(Number.isFinite)) throw new Error('x1, y1, x2 and y2 must be finite numbers.');
  const dur = durationMs === undefined ? 400 : Number(durationMs);
  if (!Number.isFinite(dur) || dur < 0 || dur > 10_000) throw new Error('durationMs must be between 0 and 10000.');
  let sx1 = x1, sy1 = y1, sx2 = x2, sy2 = y2;
  const s = await requireSandbox();
  if (coordinates === 'screenshot') {
    const shot = captureId ? s.captures?.[captureId] : s.lastShots?.[shotOwner];
    ({ x: sx1, y: sy1 } = mapCapturePoint(shot, x1, y1));
    ({ x: sx2, y: sy2 } = mapCapturePoint(shot, x2, y2));
    captureId = shot.captureId;
  }
  return call('drag', { x1: sx1, y1: sy1, x2: sx2, y2: sy2, durationMs: dur, captureId }, 60_000, s);
}

/** Mouse wheel at a point: positive notches scroll up (or left when horizontal). */
export async function scroll({ x, y, notches = 3, horizontal, coordinates = 'screen', captureId }) {
  if (!['screen', 'screenshot'].includes(coordinates)) throw new Error('coordinates must be screen or screenshot.');
  if (![x, y].every(Number.isFinite)) throw new Error('x and y must be finite numbers.');
  if (!Number.isInteger(notches) || notches === 0 || Math.abs(notches) > 30) {
    throw new Error('notches must be a non-zero integer between -30 and 30 (positive = up).');
  }
  let sx = x, sy = y;
  const s = await requireSandbox();
  if (coordinates === 'screenshot') {
    const shot = captureId ? s.captures?.[captureId] : s.lastShots?.[shotOwner];
    ({ x: sx, y: sy } = mapCapturePoint(shot, x, y));
    captureId = shot.captureId;
  }
  return call('scroll', { x: sx, y: sy, notches, horizontal: !!horizontal, captureId }, 60_000, s);
}

/** Terminate guest processes by id or name (exactly one). Returns what was stopped. */
export async function processKill({ pid, name } = {}) {
  if ((pid === undefined || pid === null) && !name) throw new Error('kill needs pid or name.');
  if (pid !== undefined && pid !== null && name) throw new Error('pass pid OR name, not both.');
  if (pid !== undefined && pid !== null && (!Number.isInteger(pid) || pid <= 0)) throw new Error('pid must be a positive integer.');
  if (name && (!/^[a-zA-Z0-9_. -]{1,60}$/.test(name))) throw new Error(`invalid process name ${JSON.stringify(name)}`);
  return call('kill', { pid, name });
}

/**
 * Launch guest Edge with remote debugging and make the DevTools endpoint reachable from the
 * HOST (CDP binds 127.0.0.1 in the guest; a netsh portproxy relays it on the sandbox IP).
 * Returns the HTTP base URL — /json/version, /json/list and the websocket debugger URLs then
 * drive the guest browser at DOM level (mission M3). Requires network=on|firewall.
 */
export async function edgeDebug({ port = 9222, startUrl } = {}) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('port must be an integer between 1024 and 65535.');
  const s = await requireSandbox();
  if (s.network === 'off') throw new Error('Edge debugging needs host<->guest networking; boot the sandbox with network on or firewall.');
  const find = await exec({ command:
    `@("\${env:ProgramFiles(x86)}\\Microsoft\\Edge\\Application\\msedge.exe", "$env:ProgramFiles\\Microsoft\\Edge\\Application\\msedge.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1` });
  const edgePath = (find.stdout ?? '').trim().split(/\r?\n/).filter(Boolean).pop();
  if (!edgePath) throw new Error('msedge.exe not found in the guest.');
  // Own user-data-dir => own browser process (no delegation to an existing instance).
  const args = `--remote-debugging-port=${port} --user-data-dir=C:\\sbx\\edge-debug --no-first-run --no-default-browser-check ${startUrl ?? 'about:blank'}`;
  const launchInfo = await launch({ path: edgePath, args, waitForWindowSec: 30 });
  // Relay 0.0.0.0:port -> 127.0.0.1:port and open the guest firewall for it (like the agent port).
  await exec({ command:
    `cmd /c "netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=${port} connectaddress=127.0.0.1 connectport=${port} & netsh advfirewall firewall add rule name=sbx-edge-debug dir=in action=allow protocol=TCP localport=${port}"`,
    timeoutSec: 60 });
  const base = `http://${s.ip}:${port}`;
  const deadline = Date.now() + 20_000;
  let version = null, lastErr = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/json/version`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) { version = await res.json(); break; }
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (e) { lastErr = e; }
    await sleep(500);
  }
  if (!version) throw new Error(`Edge DevTools endpoint did not answer at ${base}/json/version (${lastErr?.message}).`);
  audit(s, { op: 'edgedebug', port, pid: launchInfo.pid, ok: true });
  return { pid: launchInfo.pid, port, url: base, version: version.Browser, protocol: version['Protocol-Version'], userAgent: version['User-Agent'], webSocketDebuggerUrl: version.webSocketDebuggerUrl };
}

/**
 * Resolve how `keys` must be interpreted. Explicit modes only: 'text' types the string verbatim,
 * 'keys' is SendKeys syntax ({ENTER}, ^s, %{F4}). The legacy `literal` boolean still maps for one
 * release and earns a deprecation note; passing neither is an error, never a silent default.
 */
export function resolveTypeMode({ mode, literal } = {}) {
  if (mode !== undefined) {
    if (mode !== 'text' && mode !== 'keys') throw new Error(`mode must be 'text' or 'keys' (got ${JSON.stringify(mode)})`);
    if (literal !== undefined && (mode === 'text') !== Boolean(literal)) {
      throw new Error(`mode '${mode}' contradicts literal=${literal}; pass only mode.`);
    }
    return { literal: mode === 'text', deprecation: null };
  }
  if (literal !== undefined) return { literal: Boolean(literal), deprecation: 'literal is deprecated; pass mode: "text" or "keys"' };
  throw new Error("Pass mode: 'text' to type text as-is, or 'keys' for SendKeys syntax like {ENTER} or ^s.");
}

export async function type({ keys, mode, literal, windowTitle, pid }) {
  const resolved = resolveTypeMode({ mode, literal });
  const r = await call('keys', { keys, literal: resolved.literal, windowTitle, pid });
  return resolved.deprecation ? { ...r, deprecation: resolved.deprecation } : r;
}

/**
 * UIA-first smart click: the guest tries Invoke/Toggle/Select/ExpandCollapse patterns, then the
 * legacy IAccessible default action, then UIA focus + Enter, then a focus-verified SendInput
 * click — and reports every attempt plus the winning strategy and an effect check.
 */
export async function smartClick({ windowTitle, pid, name, automationId, controlType, index, verify, timeoutSec } = {}) {
  return call('smartclick', { windowTitle, pid, name, automationId, controlType, index, verify, timeoutSec },
    ((timeoutSec ?? 15) + 30) * 1000);
}

// UI Automation: inspect and drive controls by name instead of pixels.
export async function uiTree({ windowTitle, pid, depth, maxNodes } = {}) {
  return call('uitree', { windowTitle, pid, depth, maxNodes }, 120_000);
}

export async function uiAction({ windowTitle, pid, name, automationId, controlType, index, action = 'click', value }) {
  return call('uiaction', { windowTitle, pid, name, automationId, controlType, index, action, value }, 60_000);
}

export async function waitForUi({ windowTitle, pid, name, automationId, controlType, timeoutSec = 30 }) {
  return call('uiwait', { windowTitle, pid, name, automationId, controlType, timeoutSec }, (timeoutSec + 30) * 1000);
}

/** One line per element: `Button "Greet" #GreetButton {invoke}` — compact enough for an LLM to read. */
export function formatUiNode(n, indent = true) {
  const parts = [n.type || '?'];
  if (n.name) parts.push(JSON.stringify(n.name));
  if (n.automationId) parts.push('#' + n.automationId);
  if (n.value !== undefined && n.value !== n.name && (n.value !== '' || /^(Edit|ComboBox|Document)$/.test(n.type))) parts.push('= ' + JSON.stringify(n.value));
  if (n.toggled !== undefined) parts.push(n.toggled ? '[x]' : '[ ]');
  if (n.selected) parts.push('(selected)');
  if (n.enabled === false) parts.push('(disabled)');
  if (n.actions?.length) parts.push('{' + n.actions.join(',') + '}');
  return (indent ? '  '.repeat(n.depth || 0) : '') + parts.join(' ');
}

export function formatUiTree(t) {
  const nodes = [].concat(t?.nodes ?? []);
  return nodes.map((n) => formatUiNode(n)).join('\n') + (t?.truncated ? '\n… (truncated: raise maxNodes or lower depth, or target a window)' : '');
}

// ---------- change tracking ----------

/** Record files, registry keys, services, autoruns, environment and installed programs under a name. */
export async function snapshot(name, exclude = []) {
  return call('snapshot', { name, exclude }, 600_000);
}

/** What changed between two snapshots (new folders/keys collapsed to their topmost new parent). */
export async function diffSnapshots(from, to, max = 200) {
  const d = await call('diff', { from, to, max }, 300_000);
  for (const sec of [d.files, d.registry]) for (const k of ['added', 'removed', 'changed']) sec[k] = [].concat(sec[k] ?? []);
  d.files.executables = [].concat(d.files.executables ?? []);
  for (const k of ['values', 'services', 'programsAdded', 'programsRemoved']) d[k] = [].concat(d[k] ?? []);
  return d;
}

const kb = (n) => n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n || 0} B`;

/** Markdown for a snapshot diff. */
export function formatDiff(d, { title = 'Changes' } = {}) {
  const out = [];
  const list = (items, fmt) => items.forEach((i) => out.push(`- ${fmt(i)}`));
  const entry = (i) => i.container ? `\`${i.path}\\\` (new, ${i.items} item(s)${i.bytes ? `, ${kb(i.bytes)}` : ''})` : `\`${i.path}\`${i.bytes ? ` (${kb(i.bytes)})` : ''}`;
  const more = (shown, total) => { if (total > shown) out.push(`- … and ${total - shown} more`); };
  const total = d.files.addedCount + d.files.removedCount + d.files.changedCount + d.registry.addedCount + d.registry.removedCount +
    d.values.length + d.services.length + d.programsAdded.length + d.programsRemoved.length;
  out.push(`### ${title}`, '');
  if (!total) { out.push('No changes.', ''); return out.join('\n'); }
  if (d.programsAdded.length || d.programsRemoved.length) {
    out.push('**Installed programs**', '');
    list(d.programsAdded, (p) => `➕ ${p.displayName}${p.displayVersion ? ` ${p.displayVersion}` : ''}${p.publisher ? ` (${p.publisher})` : ''}`);
    list(d.programsRemoved, (p) => `➖ ${p.displayName}${p.displayVersion ? ` ${p.displayVersion}` : ''}`);
    out.push('');
  }
  if (d.services.length) {
    out.push('**Services and drivers**', '');
    list(d.services, (s) => {
      const [disp, kind, start, image] = (s.after ?? s.before).split('|');
      const startName = { 0: 'boot', 1: 'system', 2: 'automatic', 3: 'manual', 4: 'disabled' }[start] ?? start;
      return `${s.change} ${kind} \`${s.name}\`${disp ? ` "${disp}"` : ''}, ${startName}${image ? `: \`${image}\`` : ''}`;
    });
    out.push('');
  }
  if (d.values.length) {
    out.push('**Autoruns, environment and other watched values**', '');
    list(d.values, (v) => v.change === 'changed' ? `changed \`${v.name}\`: \`${v.before}\` → \`${v.after}\`` : `${v.change} \`${v.name}\` = \`${v.after ?? v.before}\``);
    out.push('');
  }
  const f = d.files;
  if (f.addedCount || f.removedCount || f.changedCount) {
    out.push(`**Files**: ${f.addedCount} added (${kb(f.addedBytes)}), ${f.removedCount} removed, ${f.changedCount} changed`, '');
    list(f.added, (i) => `➕ ${entry(i)}`); more(f.added.length, f.addedGroups);
    list(f.removed, (i) => `➖ ${entry(i)}`); more(f.removed.length, f.removedGroups);
    list(f.changed, (p) => `✏️ \`${p}\``); more(f.changed.length, f.changedCount);
    out.push('');
  }
  const r = d.registry;
  if (r.addedCount || r.removedCount) {
    out.push(`**Registry keys**: ${r.addedCount} added, ${r.removedCount} removed`, '');
    list(r.added, (i) => `➕ \`${i.path}\`${i.items ? ` (+${i.items} subkeys)` : ''}`); more(r.added.length, r.addedGroups);
    list(r.removed, (i) => `➖ \`${i.path}\`${i.items ? ` (+${i.items} subkeys)` : ''}`); more(r.removed.length, r.removedGroups);
    out.push('');
  }
  return out.join('\n');
}

/** Application-log errors/crashes since a guest timestamp (ISO). */
export async function appErrors(sinceIso) {
  const since = sinceIso ? `[datetime]::Parse('${sinceIso}').AddSeconds(-2)` : '(Get-Date).AddHours(-1)';
  const r = await exec({
    command: `$e = Get-WinEvent -FilterHashtable @{LogName='Application'; Level=1,2; StartTime=${since}} -ErrorAction SilentlyContinue | ` +
      `ForEach-Object { [pscustomobject]@{ time = $_.TimeCreated.ToString('o'); source = $_.ProviderName; id = $_.Id; message = $_.Message } }; ` +
      `if ($e) { ConvertTo-Json @($e) -Depth 3 -Compress } else { '[]' }`,
    timeoutSec: 60,
  });
  try { return [].concat(JSON.parse(r.stdout.trim() || '[]')); } catch { return []; }
}

/** Running processes: pid, name, path (path is empty when Windows will not tell us). */
export async function processes() {
  const r = await exec({
    command: '$p = Get-Process | ForEach-Object { [pscustomobject]@{ pid = $_.Id; name = $_.ProcessName; path = [string]$_.Path } }; ConvertTo-Json @($p) -Compress',
    timeoutSec: 60,
  });
  try { return [].concat(JSON.parse(r.stdout.trim() || '[]')); } catch { return []; }
}
