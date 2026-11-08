// "What does this installer really do to a clean machine, and does its uninstaller clean up?"
// Boot a fresh sandbox, snapshot, install, snapshot, (test), uninstall, snapshot, report the two diffs.
import fs from 'node:fs';
import path from 'node:path';
import * as sbx from './core.js';
import { shot, runTestScript } from './run.js';

const OK_CODES = [0, 1641, 3010]; // 1641/3010 = success, reboot needed (Windows Installer convention, widely copied)

/** Split a Windows command line (as stored in UninstallString) into file and arguments. */
export function splitCommand(s) {
  s = String(s || '').trim();
  if (s.startsWith('"')) { const i = s.indexOf('"', 1); return { file: s.slice(1, i < 0 ? undefined : i), args: i < 0 ? '' : s.slice(i + 1).trim() }; }
  const m = /^(.*?\.exe)(?:\s+(.*))?$/i.exec(s);
  if (m) return { file: m[1], args: (m[2] || '').trim() };
  const j = s.indexOf(' ');
  return j < 0 ? { file: s, args: '' } : { file: s.slice(0, j), args: s.slice(j + 1).trim() };
}

/** How to run an installer silently-ish, by extension. `args` are appended (e.g. /S, /VERYSILENT, /quiet). */
export function installCommand(guestPath, args = '', log) {
  const ext = path.extname(guestPath).toLowerCase();
  if (ext === '.msi') return { file: 'msiexec.exe', args: `/i "${guestPath}" /qn /norestart${log ? ` /l*v "${log}"` : ''} ${args}`.trim() };
  if (ext === '.ps1') return { file: 'powershell.exe', args: `-NoProfile -ExecutionPolicy Bypass -File "${guestPath}" ${args}`.trim() };
  if (ext === '.cmd' || ext === '.bat') return { file: 'cmd.exe', args: `/d /s /c ""${guestPath}" ${args}"`.trim() };
  if (ext === '.exe') return { file: guestPath, args };
  throw new Error(`Don't know how to run ${ext || 'this file'}: use an .msi, .exe, .ps1, .cmd or .bat installer.`);
}

/** Pick uninstall commands for programs an install added: MSI by product code, else QuietUninstallString, else UninstallString + extraArgs. */
export function uninstallCommands(programs, extraArgs = '') {
  const visible = programs.filter((p) => String(p.systemComponent) !== '1');
  return (visible.length ? visible : programs).map((p) => {
    const code = p.key.split('\\').pop();
    let cmd;
    if (String(p.windowsInstaller) === '1' && /^\{[0-9A-F-]{36}\}$/i.test(code)) cmd = { file: 'msiexec.exe', args: `/x ${code} /qn /norestart` };
    else if (p.quietUninstallString) cmd = splitCommand(p.quietUninstallString);
    else if (p.uninstallString) { cmd = splitCommand(p.uninstallString); if (extraArgs) cmd.args = `${cmd.args} ${extraArgs}`.trim(); }
    return cmd && { ...cmd, program: p.displayName, key: p.key };
  }).filter(Boolean);
}

const regPath = (k) => k.replace(/^HKLM\\/i, 'Registry::HKEY_LOCAL_MACHINE\\').replace(/^HKCU\\/i, 'Registry::HKEY_CURRENT_USER\\');
const winKey = (w) => `${w.pid}|${w.title}`;

/** Launch, poll until exit or timeout. On timeout, capture what's on screen (usually a dialog waiting for a click), then kill the tree. */
async function runWatched(cmd, { timeoutSec, label, r, windowsBefore }) {
  const t0 = Date.now();
  const l = await sbx.launch({ path: cmd.file, args: cmd.args, waitForWindowSec: 0 });
  let p;
  for (;;) {
    p = await sbx.processInfo(l.pid);
    if (p.hasExited || Date.now() - t0 > timeoutSec * 1000) break;
    await sbx.sleep(1000);
  }
  const res = { command: `${cmd.file} ${cmd.args || ''}`.trim(), exitCode: p.hasExited ? p.exitCode : null, timedOut: !p.hasExited, seconds: (Date.now() - t0) / 1000 };
  if (res.timedOut) {
    sbx.log(`${label} still running after ${timeoutSec}s; capturing the screen`);
    const seen = new Set((windowsBefore || []).map(winKey));
    res.stuckWindows = (await sbx.windows()).filter((w) => !seen.has(winKey(w)));
    r.shots.push(await shot({ name: `${label}-stuck` }));
    const w = res.stuckWindows.find((x) => x.title);
    if (w) res.stuckUi = sbx.formatUiTree(await sbx.uiTree({ pid: w.pid, windowTitle: w.title, depth: 6, maxNodes: 80 }).catch(() => null));
    await sbx.exec({ command: `taskkill.exe /T /F /PID ${l.pid}`, timeoutSec: 30 }).catch(() => {});
  }
  return res;
}

function msiErrors(file) {
  if (!fs.existsSync(file)) return [];
  const buf = fs.readFileSync(file);
  const text = buf[0] === 0xff && buf[1] === 0xfe ? buf.toString('utf16le') : buf.toString('utf8');
  return text.split(/\r?\n/).filter((l) => /\bError \d{4}\b|Return value 3\b/.test(l)).slice(0, 20);
}

export function countChanges(d) {
  return !d ? 0 : d.files.addedCount + d.files.removedCount + d.files.changedCount + d.registry.addedCount + d.registry.removedCount +
    d.values.length + d.services.length + d.programsAdded.length + d.programsRemoved.length;
}

/**
 * installer: host path to .msi/.exe/.ps1/.cmd/.bat. Options: args, uninstall ('auto' | 'none' | a command line),
 * uninstallArgs (appended to UninstallString in auto mode, e.g. /S), test (host .ps1 run after install), timeoutSec,
 * failOnLeftovers, exclude[] (extra snapshot excludes), keep, plus startSandbox options.
 */
export async function installTest(o) {
  const src = path.resolve(o.installer);
  if (!fs.existsSync(src) || !fs.statSync(src).isFile()) throw new Error(`Installer not found: ${src}`);
  if (o.test && !fs.existsSync(o.test)) throw new Error(`Test script not found: ${o.test}`);
  const name = path.basename(src);
  installCommand(name); // validate the extension before booting
  const mode = o.uninstall ?? 'auto';
  const r = { installer: name, hostPath: src, args: o.args || '', startedAt: new Date().toISOString(), shots: [], uninstalls: [] };
  const t0 = Date.now();
  let booted = false;
  try {
    const boot = await sbx.startSandbox(o);
    booted = true;
    r.sandbox = { id: boot.id, epoch: boot.epoch, network: boot.network, bootSeconds: boot.bootSeconds };
    r.runDir = boot.runDir; r.outDir = boot.outDir;
    const guest = `C:\\sbx-test\\installer\\${name}`;
    await sbx.copyIn(src, guest);

    sbx.log('snapshot before install');
    r.snapshots = { before: await sbx.snapshot('before', o.exclude) };
    const procsBefore = await sbx.processes();
    const windowsBefore = await sbx.windows();

    const ext = path.extname(name).toLowerCase();
    const msiLog = ext === '.msi' ? `${sbx.GUEST.out}\\msi-install.log` : null;
    sbx.log(`installing ${name}${o.args ? ` ${o.args}` : ''}`);
    r.install = await runWatched(installCommand(guest, o.args, msiLog), { timeoutSec: o.timeoutSec ?? 600, label: 'install', r, windowsBefore });
    if (msiLog) { r.install.log = path.join(r.outDir, 'msi-install.log'); r.install.logErrors = msiErrors(r.install.log); }
    await sbx.sleep(2000);

    r.leftRunning = (await sbx.processes()).filter((p) => !procsBefore.some((b) => b.pid === p.pid) && p.path && !/^c:\\windows\\/i.test(p.path));
    r.shots.push(await shot({ name: 'after-install' }));
    sbx.log('snapshot after install');
    r.snapshots.installed = await sbx.snapshot('installed', o.exclude);
    r.installDiff = await sbx.diffSnapshots('before', 'installed', o.max ?? 200);

    if (o.test) {
      sbx.log(`running test ${path.basename(o.test)}`);
      const p = r.installDiff.programsAdded[0];
      r.test = await runTestScript(o.test, { SBX_INSTALL_DIR: p?.installLocation || '', SBX_PROGRAM: p?.displayName || '' }, undefined, o.testTimeoutSec);
    }

    if (mode !== 'none' && !r.install.timedOut) {
      const cmds = mode === 'auto' ? uninstallCommands(r.installDiff.programsAdded, o.uninstallArgs) : [{ ...splitCommand(mode), program: '(custom)' }];
      if (!cmds.length) r.uninstallSkipped = 'The installer did not register anything in Add/Remove Programs, so there is nothing to uninstall automatically.';
      if (cmds.length && r.leftRunning.length) {
        sbx.log(`stopping ${r.leftRunning.length} process(es) the install left running`);
        await sbx.exec({ command: `Stop-Process -Force -Id ${r.leftRunning.map((p) => p.pid).join(',')} -ErrorAction SilentlyContinue`, timeoutSec: 30 });
      }
      for (const c of cmds) {
        if (c.key && (await sbx.exec({ command: `Test-Path -LiteralPath '${regPath(c.key).replace(/'/g, "''")}'`, timeoutSec: 30 })).stdout.trim() !== 'True') continue;
        sbx.log(`uninstalling ${c.program}: ${c.file} ${c.args}`);
        const u = await runWatched(c, { timeoutSec: o.timeoutSec ?? 600, label: 'uninstall', r, windowsBefore });
        u.program = c.program;
        // Self-copying uninstallers (NSIS, Inno) return at once and keep working from %TEMP%: wait for the ARP entry to go.
        if (c.key && !u.timedOut) {
          for (let i = 0; i < 60; i++) {
            if ((await sbx.exec({ command: `Test-Path -LiteralPath '${regPath(c.key).replace(/'/g, "''")}'`, timeoutSec: 30 })).stdout.trim() !== 'True') break;
            await sbx.sleep(1000);
          }
          await sbx.sleep(2000);
        }
        r.uninstalls.push(u);
      }
      if (r.uninstalls.length) {
        sbx.log('snapshot after uninstall');
        r.snapshots.uninstalled = await sbx.snapshot('uninstalled', o.exclude);
        r.leftovers = await sbx.diffSnapshots('before', 'uninstalled', o.max ?? 200);
        r.shots.push(await shot({ name: 'after-uninstall' }));
      }
    }
  } catch (e) {
    r.error = e.message;
  } finally {
    if (booted && !o.keep) {
      sbx.log('destroying the sandbox');
      const st = await sbx.stopSandbox({ target: r.sandbox }).catch((e) => ({ error: e.message }));
      if (st.error) r.stopError = st.error;
    }
    r.kept = booted && !!o.keep;
  }
  r.seconds = (Date.now() - t0) / 1000;

  r.leftoverCount = r.leftovers ? countChanges(r.leftovers) : null;
  r.failures = [];
  if (r.error) r.failures.push(r.error);
  if (r.install?.timedOut) r.failures.push(`installer still running after ${o.timeoutSec ?? 600}s (waiting for input?)`);
  else if (r.install && !OK_CODES.includes(r.install.exitCode)) r.failures.push(`installer exited with code ${r.install.exitCode}`);
  if (r.test && r.test.exitCode !== 0) r.failures.push(`test script ${r.test.timedOut ? 'timed out' : `exited with code ${r.test.exitCode}`}`);
  for (const u of r.uninstalls) {
    if (u.timedOut) r.failures.push(`uninstaller for ${u.program} still running after ${o.timeoutSec ?? 600}s`);
    else if (!OK_CODES.includes(u.exitCode)) r.failures.push(`uninstaller for ${u.program} exited with code ${u.exitCode}`);
  }
  if (r.leftovers?.programsAdded.length) r.failures.push(`still listed in Add/Remove Programs after uninstall: ${r.leftovers.programsAdded.map((p) => p.displayName).join(', ')}`);
  if (o.failOnLeftovers && r.leftoverCount) r.failures.push(`${r.leftoverCount} leftover change(s) after uninstall`);
  r.pass = r.failures.length === 0;

  if (r.outDir) {
    fs.mkdirSync(r.outDir, { recursive: true });
    r.reportPath = path.join(r.outDir, 'report.md');
    fs.writeFileSync(r.reportPath, renderInstallReport(r));
    fs.writeFileSync(path.join(r.outDir, 'report.json'), JSON.stringify({ ...r, shots: r.shots.map(({ previewBase64, ...s }) => s) }, null, 2));
  }
  return r;
}

const step = (x) => x.timedOut ? `still running after ${x.seconds.toFixed(0)}s, killed` : `exit ${x.exitCode} in ${x.seconds.toFixed(1)}s`;

export function installSummary(r) {
  const lines = [`${r.pass ? 'PASS' : 'FAIL'}  ${r.installer} on a fresh Windows Sandbox (${r.seconds.toFixed(1)}s)`];
  const row = (k, v) => lines.push(`  ${k.padEnd(10)} ${v}`);
  if (!r.pass) row('why', r.failures.join('; '));
  if (r.install) row('install', step(r.install));
  const d = r.installDiff;
  if (d) {
    row('added', `${d.programsAdded.map((p) => p.displayName).join(', ') || 'no Add/Remove Programs entry'}; ${d.files.addedCount} files, ` +
      `${d.registry.addedCount} registry keys, ${d.services.length} services, ${d.values.length} autorun/env values`);
  }
  if (r.leftRunning?.length) row('running', r.leftRunning.map((p) => p.name).join(', '));
  if (r.test) row('test', `${r.test.script} ${r.test.exitCode === 0 ? 'passed' : `failed (exit ${r.test.exitCode})`}`);
  for (const u of r.uninstalls) row('uninstall', `${u.program}: ${step(u)}`);
  if (r.uninstallSkipped) row('uninstall', 'skipped: nothing registered in Add/Remove Programs');
  if (r.leftovers) row('leftovers', r.leftoverCount ? `${r.leftoverCount} change(s) left behind` : 'none, clean uninstall');
  if (r.reportPath) row('report', r.reportPath);
  return lines.join('\n');
}

const fence = (s) => '```text\n' + (s || '').trimEnd().slice(-20_000) + '\n```';

export function renderInstallReport(r) {
  const rel = (p) => path.relative(r.outDir, p).split(path.sep).join('/');
  const lines = [
    `# sbx install-test: ${r.installer}`, '',
    r.pass ? '**✅ PASS**' : `**❌ FAIL**: ${r.failures.join('; ')}`, '',
    '| | |', '|---|---|',
    `| Installer | \`${r.hostPath}\`${r.args ? ` \`${r.args}\`` : ''} |`,
    `| Sandbox | fresh Windows Sandbox, network ${r.sandbox?.network ?? '?'}, booted in ${r.sandbox?.bootSeconds?.toFixed(1) ?? '?'}s |`,
    `| Install | ${r.install ? `\`${r.install.command}\`: ${step(r.install)}` : 'not run'} |`,
  ];
  for (const u of r.uninstalls) lines.push(`| Uninstall | ${u.program}: \`${u.command}\`: ${step(u)} |`);
  if (r.uninstallSkipped) lines.push(`| Uninstall | skipped. ${r.uninstallSkipped} |`);
  if (r.leftovers) lines.push(`| Leftovers | ${r.leftoverCount ? `**${r.leftoverCount}** change(s) remain after uninstall` : 'none, clean uninstall'} |`);
  lines.push(`| Total time | ${r.seconds.toFixed(1)}s |`, '');
  for (const x of [r.install, ...r.uninstalls].filter((x) => x?.timedOut)) {
    lines.push('## Stuck waiting for input?', '', `\`${x.command}\` was still running. New windows on screen:`, '');
    for (const w of x.stuckWindows || []) lines.push(`- ${w.process} (pid ${w.pid}): "${w.title}"`);
    if (x.stuckUi) lines.push('', 'Controls in the first one:', '', fence(x.stuckUi));
    lines.push('');
  }
  if (r.install?.logErrors?.length) lines.push('## Windows Installer errors', '', fence(r.install.logErrors.join('\n')), '', `Full log: [msi-install.log](${rel(r.install.log)})`, '');
  if (r.installDiff) lines.push('## What the install changed', '', sbx.formatDiff(r.installDiff, { title: 'before → after install' }), '');
  if (r.leftRunning?.length) {
    lines.push('## Processes still running after install', '', '| pid | name | path |', '|---|---|---|');
    for (const p of r.leftRunning) lines.push(`| ${p.pid} | ${p.name} | \`${p.path}\` |`);
    lines.push('');
  }
  if (r.test) {
    lines.push(`## Test script \`${r.test.script}\`: ${r.test.timedOut ? 'timed out' : `exit ${r.test.exitCode}`}`, '', fence(r.test.stdout));
    if (r.test.stderr) lines.push('', 'stderr:', '', fence(r.test.stderr));
    lines.push('');
  }
  if (r.leftovers) lines.push('## Left behind after uninstall', '', sbx.formatDiff(r.leftovers, { title: 'before install → after uninstall' }), '');
  if (r.shots.length) {
    lines.push('## Screenshots', '');
    for (const s of r.shots) lines.push(`**${s.name}**`, '', `![${s.name}](${rel(s.path)})`, '');
  }
  if (r.error) lines.push('## Error', '', fence(r.error), '');
  lines.push('---', `Audit log: \`${path.join(r.runDir || '', 'audit.jsonl')}\`${r.kept ? ' · sandbox left running (--keep)' : ''}`);
  return lines.join('\n') + '\n';
}
