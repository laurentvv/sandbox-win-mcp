// One-shot "does my app work on a clean Windows machine?": boot a fresh sandbox, copy the app in, run it,
// observe (process state, screenshots, crash events, optional test script), collect files, tear down, write a report.
import fs from 'node:fs';
import path from 'node:path';
import * as sbx from './core.js';
import { scanDependencies, formatDependencies, classifyDependencyFailure, GUEST_DEPENDENCY_INVENTORY } from './deps.js';
import { prepareProvision, installProvision, recordProvisioning } from './provision.js';
import { packageInputs, installPackage } from './packaged.js';

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

/** Copy a host .ps1 into the sandbox and run it with SbxUi loaded and the given $env: variables. Exit 0 = pass. */
export async function runTestScript(test, vars = {}, cwd, timeoutSec = 300) {
  const t = await sbx.copyIn(test, `C:\\sbx-test\\${path.basename(test)}`);
  const env = Object.entries({ ...vars, SBX_OUT: sbx.GUEST.out }).map(([k, v]) => `$env:${k}=${q(v ?? '')}; `).join('') +
    `Import-Module '${sbx.GUEST.agent}\\SbxUi.psm1'; `;
  const r = await sbx.exec({
    command: `${env}$global:LASTEXITCODE = 0; try { & ${q(t.path)}; exit $LASTEXITCODE } catch { [Console]::Error.WriteLine(($_ | Out-String)); exit 1 }`,
    cwd, timeoutSec,
  });
  return { ...r, script: path.basename(test) };
}

export async function shot(args) {
  const s = await sbx.screenshot(args);
  return { name: args.name, path: s.path, width: s.width, height: s.height, previewBase64: s.previewBase64 };
}

/**
 * app: host .exe (copy its whole folder), folder (+ exe), or MSIX/Appx package/bundle.
 * Options: exe, cert, deps, appId, args, waitSec, console, record, timeoutSec, test, testTimeoutSec, collect[], keep, plus startSandbox options.
 */
export async function runApp(o) {
  const src = path.resolve(o.app);
  if (!fs.existsSync(src)) throw new Error(`Not found: ${src}`);
  const packaged = fs.statSync(src).isFile() ? packageInputs({ ...o, app: src }) : null;
  let dir = src, exe = o.exe;
  if (fs.statSync(src).isFile()) { dir = path.dirname(src); exe = path.basename(src); }
  else if (!exe) {
    const exes = fs.readdirSync(dir).filter((f) => /\.exe$/i.test(f));
    if (exes.length !== 1) throw new Error(`Say which exe to run: found ${exes.length ? exes.join(', ') : 'no .exe files'} in ${dir}`);
    exe = exes[0];
  }
  if (o.test && !fs.existsSync(o.test)) throw new Error(`Test script not found: ${o.test}`);

  // Windows' own programs (charmap, mspaint, ...) are already in the guest: run them in place instead of copying System32.
  const winDir = path.resolve(process.env.SystemRoot || 'C:\\Windows');
  const builtIn = dir.toLowerCase() === winDir.toLowerCase() || dir.toLowerCase().startsWith(winDir.toLowerCase() + '\\');
  let appDir = builtIn ? `C:\\Windows${dir.slice(winDir.length)}` : `C:\\apps\\${exe.replace(/\.exe$/i, '')}`;
  let exePath = `${appDir}\\${exe}`;
  const r = { app: exe, hostDir: dir, args: o.args || '', mode: o.console ? 'console' : 'gui', startedAt: new Date().toISOString(), shots: [], collected: [] };
  if (!builtIn) r.dependencies = scanDependencies(src);
  r.cleanMachine = !o.provision;
  r.provisionRequested = o.provision;
  r.provisioned = [];
  const t0 = Date.now();
  let booted = false, ownedRecording;
  try {
    const prepared = o.provision ? await prepareProvision(r.dependencies || { requirements: [], binaries: [] }, o.provision) : [];
    const boot = await sbx.startSandbox(o);
    booted = true;
    r.sandbox = { id: boot.id, epoch: boot.epoch, network: boot.network, bootSeconds: boot.bootSeconds, desktopReadySeconds: boot.desktopReadySeconds };
    r.runDir = boot.runDir; r.outDir = boot.outDir;
    const target = await sbx.current();
    if (!target || target.id !== boot.id || target.epoch !== boot.epoch) throw new Error('Sandbox changed after boot; refusing to provision a replacement.');
    const inventory = await sbx.exec({ command: GUEST_DEPENDENCY_INVENTORY }, target);
    if (inventory.exitCode !== 0 || inventory.timedOut) throw new Error(`Guest dependency inventory failed: ${inventory.stderr || inventory.stdout}`);
    r.guestBaseline = JSON.parse(inventory.stdout);
    if (o.provision) recordProvisioning(r.runDir, o.provision, r.provisioned);
    await installProvision(prepared, (record) => {
      r.provisioned.push(record);
      recordProvisioning(r.runDir, o.provision, r.provisioned);
    }, target);
    if (o.record) ownedRecording = await sbx.recordStart({}, target);
    if (packaged) {
      sbx.log(`installing ${exe}`);
      r.package = await installPackage(src, packaged, o.appId, target);
      appDir = r.package.installLocation;
      exePath = path.win32.isAbsolute(r.package.executable) ? r.package.executable : path.win32.join(appDir, r.package.executable);
    } else if (builtIn) sbx.log(`${exe} is part of Windows: running the sandbox's own copy`);
    else {
      sbx.log(`copying ${dir} to ${appDir}`);
      await sbx.copyIn(dir, appDir, target);
    }
    sbx.log(`running ${exe}${o.args ? ` ${o.args}` : ''}`);
    r.launchAttempted = true;

    if (o.console) {
      r.console = await sbx.exec({ command: `& ${q(exePath)} ${o.args || ''}; exit $LASTEXITCODE`, cwd: appDir, timeoutSec: o.timeoutSec ?? 300 });
      r.process = { hasExited: !r.console.timedOut, exitCode: r.console.exitCode, timedOut: r.console.timedOut };
    } else {
      r.launch = await sbx.launch({ ...(packaged ? { aumid: r.package.aumid } : { path: exePath }), args: o.args, waitForWindowSec: 30 });
      await sbx.sleep((o.waitSec ?? 5) * 1000);
      r.process = await sbx.processInfo(r.launch.pid);
      if (r.process.hasWindow) r.shots.push(await shot({ pid: r.launch.pid, name: 'app' }));
      if (r.process.hasWindow && r.dependencies?.requirements.some((d) => /^Microsoft\.(NETCore|WindowsDesktop|AspNetCore)\.App$/.test(d.component))) {
        r.runtimeDiagnostic = sbx.formatUiTree(await sbx.uiTree({ pid: r.launch.pid, depth: 6, maxNodes: 100 }));
      }
    }

    if (o.test) {
      sbx.log(`running test ${path.basename(o.test)}`);
      r.test = await runTestScript(o.test, { SBX_APP_PID: r.launch?.pid ?? '', SBX_APP_DIR: appDir, SBX_APP_EXE: exePath, SBX_APP_AUMID: r.package?.aumid ?? '' }, appDir, o.testTimeoutSec);
      if (r.launch) {
        r.process = await sbx.processInfo(r.launch.pid);
        if (r.process.hasWindow) r.shots.push(await shot({ pid: r.launch.pid, name: 'app-after-test' }));
      }
    }

    r.shots.push(await shot({ name: 'desktop' }));
    r.windows = await sbx.windows();
    r.errors = await sbx.appErrors(r.launch?.launchedAt);
    for (const c of o.collect || []) r.collected.push(await sbx.copyOut(c).then((x) => ({ sandboxPath: c, ...x }), (e) => ({ sandboxPath: c, error: e.message })));
  } catch (e) {
    r.error = e.message;
  } finally {
    if (ownedRecording) {
      try { r.recording = await sbx.recordStop({ recordingId: ownedRecording.recordingId, target: r.sandbox }); }
      catch (e) { r.recordingError = e.message; }
    }
    if (booted && !o.keep) {
      sbx.log('destroying the sandbox');
      const st = await sbx.stopSandbox({ target: r.sandbox }).catch((e) => ({ error: e.message }));
      if (st.error) r.stopError = st.error;
      if (st.recordingError) r.recordingError = st.recordingError;
    }
    r.kept = booted && !!o.keep;
  }
  r.seconds = (Date.now() - t0) / 1000;

  const stem = path.win32.basename(r.package?.executable || exe).replace(/\.exe$/i, '').toLowerCase();
  r.crashes = (r.errors || []).filter((e) => (e.message || '').toLowerCase().includes(stem));
  r.failures = runFailures(r);
  r.dependencyFindings = classifyDependencyFailure(r);
  for (const finding of r.dependencyFindings) r.failures.push(finding.message);
  if (r.recording?.warnings.length) sbx.log(`recording: ${r.recording.warnings.join('; ')}`);
  r.pass = r.failures.length === 0;

  if (r.outDir) {
    fs.mkdirSync(r.outDir, { recursive: true });
    r.reportPath = path.join(r.outDir, 'report.md');
    fs.writeFileSync(r.reportPath, renderReport(r));
    fs.writeFileSync(path.join(r.outDir, 'report.json'),
      JSON.stringify({ ...r, shots: r.shots.map(({ previewBase64, ...s }) => s) }, null, 2));
  }
  return r;
}

export function runFailures(r) {
  const failures = [];
  if (r.error) failures.push(r.error);
  if (r.stopError) failures.push(`sandbox teardown failed: ${r.stopError}`);
  if (r.recordingError) failures.push(`recording: ${r.recordingError}`);
  if (r.recording?.stopped === false) failures.push('recorder did not stop; partial evidence retained');
  if (r.recording?.partial) failures.push('recording is partial (see recording warnings)');
  if (r.process?.timedOut) failures.push('timed out');
  else if (r.process?.hasExited && r.process.exitCode !== 0) failures.push(`exited with code ${r.process.exitCode ?? 'unknown'}`);
  if (r.test && r.test.exitCode !== 0) failures.push(`test script ${r.test.timedOut ? 'timed out' : `exited with code ${r.test.exitCode}`}`);
  if (r.crashes?.length) failures.push(`${r.crashes.length} crash/error event(s) for ${r.app}`);
  return failures;
}

const fence = (s) => '```text\n' + (s || '').trimEnd().slice(-20_000) + '\n```';

export function processState(r) {
  return r.process
    ? r.process.timedOut ? 'timed out'
      : r.process.hasExited ? `exited with code ${r.process.exitCode ?? 'unknown'}`
      : r.crashes?.length ? 'crashed (Windows Error Reporting is still holding the process)'
      : `still running${r.process.windowTitle ? `, window "${r.process.windowTitle}"` : ''}`
    : 'not started';
}

/** Short plain-text summary for terminals. */
export function summary(r) {
  const lines = [`${r.pass ? 'PASS' : 'FAIL'}  ${r.app} on a fresh Windows Sandbox (${r.seconds.toFixed(1)}s)`];
  const row = (k, v) => lines.push(`  ${k.padEnd(8)} ${v}`);
  if (!r.pass) row('why', r.failures.join('; '));
  if (r.dependencies) row('deps', `${r.dependencies.requirements.filter((d) => d.status === 'missing').length} potentially missing on the clean baseline (static diagnosis)`);
  if (r.provisionRequested) row('baseline', `PROVISIONED (not a clean-machine pass): ${r.provisioned.map((p) => `${p.component} ${p.version || ''} ${p.architecture}`).join(', ') || 'no installs completed'}`);
  if (r.sandbox) row('sandbox', `network ${r.sandbox.network}, booted in ${r.sandbox.bootSeconds.toFixed(1)}s`);
  row('process', processState(r));
  if (r.errors) row('crashes', r.crashes.length ? `${r.crashes.length} event(s): ${[...new Set(r.crashes.map((e) => e.source))].join(', ')}` : 'none');
  if (r.test) row('test', `${r.test.script} ${r.test.exitCode === 0 ? 'passed' : r.test.timedOut ? 'timed out' : `failed (exit ${r.test.exitCode})`}`);
  if (r.shots.length) row('shots', `${r.shots.length} screenshot(s)`);
  if (r.recording) row('recording', r.recording.htmlPath);
  if (r.reportPath) row('report', r.reportPath);
  return lines.join('\n');
}

export function renderReport(r) {
  const rel = (p) => path.relative(r.outDir, p).split(path.sep).join('/');
  const proc = processState(r);
  const lines = [
    `# sbx run: ${r.app}`,
    '',
    r.pass ? '**✅ PASS**' : `**❌ FAIL**: ${r.failures.join('; ')}`,
    '',
    '| | |', '|---|---|',
    `| App | \`${path.join(r.hostDir, r.app)}\`${r.args ? ` \`${r.args}\`` : ''} (${r.mode}) |`,
    `| Sandbox | fresh Windows Sandbox, network ${r.sandbox?.network ?? '?'}, booted in ${r.sandbox?.bootSeconds?.toFixed(1) ?? '?'}s |`,
    `| Process | ${proc} |`,
    `| Total time | ${r.seconds.toFixed(1)}s |`,
    `| Started | ${r.startedAt} |`,
    `| Baseline | ${r.provisionRequested ? `PROVISIONED (not a clean-machine test), requested: ${r.provisionRequested}` : 'Clean machine; no dependencies installed'} |`,
  ];
  if (r.package) lines.push(`| Package | \`${r.package.packageFullName}\` |`, `| AUMID | \`${r.package.aumid}\` |`, '');
  else lines.push('');
  if (r.recording) {
    lines.push('## Recording', '', `[Self-contained HTML flipbook](${rel(r.recording.htmlPath)})`,
      ...(r.recording.mp4Path ? [`[MP4 video](${rel(r.recording.mp4Path)})`] : []),
      '', `${r.recording.frames} frames; raw frames and [manifest](${rel(r.recording.manifestPath)}) retained.`, '');
    for (const warning of r.recording.warnings) lines.push(`- ${warning}`);
    lines.push('');
  }
  if (r.shots.length) {
    lines.push('## Screenshots', '');
    for (const s of r.shots) lines.push(`**${s.name}** (${s.width}x${s.height})`, '', `![${s.name}](${rel(s.path)})`, '');
  }
  if (r.dependencies) lines.push('## Dependency diagnosis (before launch)', '', fence(formatDependencies(r.dependencies)), '');
  if (r.guestBaseline) lines.push('## Observed guest baseline (before provisioning)', '', fence(JSON.stringify(r.guestBaseline, null, 2)), '');
  if (r.provisionRequested) lines.push('## Explicit provisioning', '', fence(JSON.stringify(r.provisioned, null, 2)), '');
  if (r.console) {
    lines.push('## Console output', '', fence(r.console.stdout));
    if (r.console.stderr) lines.push('', 'stderr:', '', fence(r.console.stderr));
    lines.push('');
  }
  if (r.test) {
    lines.push(`## Test script \`${r.test.script}\`: ${r.test.timedOut ? 'timed out' : `exit ${r.test.exitCode}`}`, '', fence(r.test.stdout));
    if (r.test.stderr) lines.push('', 'stderr:', '', fence(r.test.stderr));
    lines.push('');
  }
  if (r.windows?.length) {
    lines.push('## Windows on screen', '', '| pid | process | title |', '|---|---|---|');
    for (const w of r.windows) lines.push(`| ${w.pid} | ${w.process} | ${String(w.title).replace(/\|/g, '\\|')} |`);
    lines.push('');
  }
  lines.push('## Application errors since launch', '');
  if (!r.errors?.length) lines.push('None.', '');
  else for (const e of r.errors) lines.push(`- ${r.crashes.includes(e) ? '💥 ' : ''}**${e.source}** (${e.id}) ${e.time}`, '', fence(e.message), '');
  if (r.collected.length) {
    lines.push('## Collected files', '');
    for (const c of r.collected) lines.push(c.error ? `- \`${c.sandboxPath}\`: ${c.error}` : `- \`${c.sandboxPath}\` → [${rel(c.hostPath)}](${rel(c.hostPath)}) (${c.files} files)`);
    lines.push('');
  }
  if (r.error) lines.push('## Error', '', fence(r.error), '');
  lines.push('---', `Audit log: \`${path.join(r.runDir || '', 'audit.jsonl')}\`${r.kept ? ' · sandbox left running (--keep)' : ''}`);
  return lines.join('\n') + '\n';
}
