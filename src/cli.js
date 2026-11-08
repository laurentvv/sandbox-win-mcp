#!/usr/bin/env node
// sbx: command-line front end for Windows Sandbox automation. Shares state with the MCP server, so you can
// `sbx start` here, drive it from an agent, and `sbx stop` afterwards (or the other way around).
import { spawn } from 'node:child_process';
import * as sbx from './core.js';
import { runApp, summary } from './run.js';
import { installTest, installSummary } from './install.js';
import { detonate, detonateSummary } from './detonate.js';
import { scanDependencies, formatDependencies } from './deps.js';
import { provisionSandbox } from './provision.js';

const HELP = `sbx ${sbx.VERSION} - fresh, throwaway Windows machines for testing your apps (Windows Sandbox)

Usage: sbx <command> [options]

One shot
  run <app.exe|folder|app.msix> [options] Boot a fresh sandbox, copy the app in, run it, screenshot it, check
                                     for crashes, write a report, destroy the sandbox. Exit 0 = pass.
      --exe <name>                   Which exe, when <folder> has several
      --cert <file.cer>              Trust a dev-signing certificate inside this guest only
      --deps <folder>                MSIX/Appx dependency packages (default: adjacent deps folder)
      --app-id <id>                  Application Id for packages with multiple applications
      --args "<args>"                Arguments for the app
      --console                      Console app: run to completion and capture output
      --provision <auto|list>         OPT IN: install verified runtimes; report is NOT a clean-machine pass
      --record                       Record desktop evidence (HTML flipbook, MP4 if host ffmpeg is available)
      --wait <sec>                   Let a GUI app settle before observing (default 5)
      --test <script.ps1>            Run a test script inside afterwards ($env:SBX_APP_PID, SBX_APP_DIR, SBX_OUT)
      --collect <sandbox path>       Copy a file/folder back out afterwards (repeatable)
      --keep                         Leave the sandbox running afterwards
      --open                         Open the report when done

  install-test <setup.msi|.exe|.ps1|.cmd> [options]
                                     Snapshot a fresh sandbox, install, snapshot, uninstall, snapshot. Reports
                                     what the installer added (files, registry, services, autoruns, tasks)
                                     and what its uninstaller left behind. Exit 0 = pass.
      --args "<args>"                Installer arguments, e.g. /S or /VERYSILENT (.msi already gets /qn)
      --uninstall auto|none|"<cmd>"  auto (default): use what the installer registered in Add/Remove Programs
      --uninstall-args "<args>"      Added to the registered UninstallString in auto mode, e.g. /S
      --test <script.ps1>            Run after install ($env:SBX_INSTALL_DIR, SBX_PROGRAM, SBX_OUT)
      --timeout <sec>                Per installer/uninstaller (default 600); a hung one gets screenshotted
      --fail-on-leftovers            Fail if the uninstall leaves anything behind
      --exclude <path>               Ignore a noisy file or registry path (repeatable)
      --keep, --open                 As for run

  detonate <file> [options]          Run a file you don't trust and watch what it does: every process it starts
                                     (with command lines), names it looks up, connections it tries, files,
                                     registry, autoruns, services and scheduled tasks it changes, screenshots.
                                     Network is off unless you say otherwise. Exit 0 = observed (not "safe").
      --args "<args>"                Arguments for the file
      --network off|firewall|on      off (default): no adapter. firewall: see the addresses it tries (blocked).
      --duration <sec>               Watch for at most this long (default 60)
      --full                         Watch the whole time, even after everything it started has exited
      --every <sec>                  Screenshot interval (default 15)
      --exclude <path>, --keep, --open

Step by step
  start [--network on|firewall|off] [--offline] [--memory <MB>] [--no-gpu] [--minimized]
  status
  desktop-release                    Release this workflow's desktop turn (SANDBOX_MCP_WORKFLOW)
  record start [--fps <1-5>] [--duration <1-300>] [--max-frames <1-600>]
  record stop                        Publish self-contained HTML and optional MP4; raw frames are retained
  push <host path> [sandbox path]    Copy a file/folder in (default C:\\apps\\<name>)
  deploy <hostDir> [guestDir] [--launch <exe>] [--args "<args>"] [--restart]
                                     Verified incremental copy into a warm sandbox; restart stops apps under guestDir
  pull <sandbox path> [name]         Copy a file/folder out to the run's out\\files folder
  exec [--cmd] [--cwd <dir>] [--timeout <sec>] <command...>
                                     Run a command; prints its output and exits with its exit code
  launch <exe|PackageFamilyName!AppId> [--args "<args>"] [--cwd <dir>] [--wait <sec>]
                                     Start a GUI app without waiting for it
  proc <pid>                         Is it still running? exit code? window title?
  windows                            List windows on the sandbox desktop
  shot [--window <title>] [--pid <pid>] [--name <label>]
                                     Screenshot the desktop or one window; prints the PNG path
  click <x> <y> [--right] [--double] [--coordinates screenshot --capture-id <id>]
                                     Click at screen pixels (default), or pixels in a specific preview
  type <text> [--keys] [--window <title>] [--pid <pid>]
                                     Type text (--keys: SendKeys syntax like {ENTER} or ^s)
  ui [tree] [--pid <pid>|--window <title>] [--depth <n>] [--max <n>]
                                     Show the UI Automation tree: every control, its name, #id and actions
  ui <action> [--name <text>] [--id <automationId>] [--type <Button|Edit|...>] [--index <n>] [--value <text>]
                                     Act on a control: click, doubleclick, rightclick, set (--value), toggle,
                                     select, expand, collapse, focus, read
  ui wait [--name ...] [--id ...] [--type ...] [--timeout <sec>]
                                     Wait for a control to appear (exit 1 on timeout)
  errors [--since <iso time>]        Application event log errors (crashes, unhandled exceptions)
  snapshot <name> [--exclude <path>]...
                                     Record files, registry, services, autoruns and programs (~15s)
  diff <from> <to> [--max <n>]       What changed between two snapshots
  stop [--force]                     Destroy the sandbox (--force: also one not started by sbx)

Other
  deps <app path>                     Diagnose dependencies without booting or installing anything
  provision <app path> --provision <auto|list>
                                     Install dependencies into an already-started sandbox (host downloads)
  doctor                             Check this PC can run Windows Sandbox, and say how to fix it if not
  mcp                                Run the MCP server on stdio
  help | version
  --json                             Machine-readable output for any command

Network modes: on = normal internet; firewall = guest firewall blocks outbound (admin code could undo it);
off = no network adapter at all, the strongest isolation (--offline is the same).
Data: ${sbx.HOME}`;

// Options that take a value; everything else starting with -- is a boolean flag.
const VALUE_OPTS = new Set(['network', 'memory', 'exe', 'args', 'wait', 'test', 'collect', 'cwd', 'timeout', 'window', 'pid', 'name', 'since',
  'id', 'type', 'index', 'value', 'depth', 'max', 'uninstall', 'uninstall-args', 'exclude', 'duration', 'every', 'launch', 'provision', 'cert', 'deps', 'app-id',
  'coordinates', 'capture-id', 'fps', 'max-frames']);
const REPEAT_OPTS = new Set(['collect', 'exclude']);

function parse(argv) {
  const pos = [], opt = { collect: [], exclude: [] };
  let i = 0;
  const restCommand = argv[0] === 'exec'; // exec: options only before the command; the rest is the command line
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { pos.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--') && a.length > 2) {
      const [k, inline] = a.slice(2).split(/=(.*)/s);
      if (VALUE_OPTS.has(k)) {
        const v = inline ?? argv[++i];
        if (v === undefined) throw new Error(`--${k} needs a value`);
        if (REPEAT_OPTS.has(k)) opt[k].push(v); else opt[k] = v;
      } else opt[k] = true;
      continue;
    }
    pos.push(a);
    if (restCommand && pos.length === 2) { pos.push(...argv.slice(i + 1)); break; }
  }
  return { cmd: pos[0], pos: pos.slice(1), opt };
}

const num = (v, what) => {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${what} must be a number (got ${v})`);
  return n;
};

function out(opt, value, human) {
  if (opt.json) console.log(JSON.stringify(value, null, 2));
  else console.log(typeof human === 'function' ? human(value) : human ?? (typeof value === 'string' ? value : JSON.stringify(value, null, 2)));
}

function startOpts(opt) {
  return {
    network: opt.offline ? 'off' : opt.network ?? 'on',
    memoryMB: num(opt.memory, '--memory'),
    vGpu: !opt['no-gpu'],
    window: opt.minimized ? 'minimized' : 'normal',
  };
}

const table = (rows, cols) => {
  if (!rows.length) return '(none)';
  const w = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? '').length)));
  const line = (vals) => vals.map((v, i) => String(v ?? '').padEnd(w[i])).join('  ').trimEnd();
  return [line(cols), line(w.map((n) => '-'.repeat(n))), ...rows.map((r) => line(cols.map((c) => r[c])))].join('\n');
};

async function main(argv) {
  const { cmd, pos, opt } = parse(argv);
  const need = (n, usage) => { if (pos.length < n) throw new Error(`usage: sbx ${usage}`); };

  switch (cmd) {
    case undefined: case 'help': case '-h': case '--help':
      console.log(HELP); return 0;
    case 'version': case '-v': case '--version':
      console.log(sbx.VERSION); return 0;

    case 'mcp':
      await import('./server.js');
      return null; // keep running

    case 'doctor': {
      const r = await sbx.checkSandbox();
      out(opt, r, () => `${sbx.formatChecks(r.checks)}\n\n${r.ok
        ? 'Ready. Try: sbx run C:\\Windows\\System32\\charmap.exe --open'
        : 'Fix the ❌ items above (in order), then run "sbx doctor" again.'}`);
      return r.ok ? 0 : 1;
    }

    case 'deps':
      need(1, 'deps <app path>');
      out(opt, scanDependencies(pos[0]), formatDependencies);
      return 0;

    case 'provision':
      need(1, 'provision <app path> --provision <auto|list>');
      out(opt, await provisionSandbox(pos[0], opt.provision));
      return 0;

    case 'start':
      out(opt, await sbx.startSandbox(startOpts(opt)), (r) =>
        `Sandbox ${r.id} ready in ${r.bootSeconds.toFixed(1)}s (network ${r.network}). Artifacts: ${r.outDir}`);
      return 0;

    case 'status':
      out(opt, await sbx.status(), (s) => s.running
        ? `Running: ${s.id} (network ${s.network}, since ${s.startedAt}, agent ${s.agent}, desktop ${s.desktop.ready ? 'interactive' : 'NOT interactive'})\n` +
          `Epoch: ${s.epoch}; protocol ${s.identity.protocolVersion}; agent ${s.identity.agentVersion}; SHA256 ${s.identity.agentSha256}` +
          `${s.provisioning ? '\nPROVISIONING OPT-IN: not a clean machine; see provisioning.json in the run folder.' : ''}\nArtifacts: ${s.outDir}`
        : `No sbx sandbox running.${s.otherSandboxes.length ? ` Other sandbox(es): ${s.otherSandboxes.join(', ')}` : ''}`);
      return 0;

    case 'desktop-release':
      out(opt, sbx.releaseDesktop());
      return 0;

    case 'record': {
      if (pos[0] === 'start') out(opt, await sbx.recordStart({ fps: num(opt.fps, '--fps'),
        maxDurationSec: num(opt.duration, '--duration'), maxFrames: num(opt['max-frames'], '--max-frames') }));
      else if (pos[0] === 'stop') {
        const r = await sbx.recordStop();
        out(opt, r);
        return r.stopped ? 0 : 1;
      }
      else throw new Error('usage: sbx record start|stop');
      return 0;
    }

    case 'stop': {
      const r = await sbx.stopSandbox({ force: !!opt.force });
      out(opt, r, () => (r.stopped.length ? `Stopped ${r.stopped.join(', ')}.${r.outDir ? ` Artifacts: ${r.outDir}` : ''}` : 'Nothing to stop.') +
        (r.recording ? `\nRecording: ${r.recording.htmlPath}` : '') +
        (r.recordingError ? `\nRecording publication failed: ${r.recordingError}` : ''));
      return r.recordingError ? 1 : 0;
    }

    case 'deploy': {
      need(1, 'deploy <hostDir> [guestDir] [--launch <exe>] [--args "<args>"] [--restart]');
      out(opt, await sbx.deploy({ hostPath: pos[0], sandboxPath: pos[1], launch: opt.launch, args: opt.args, restart: !!opt.restart }),
        (r) => `${r.added} added, ${r.changed} changed, ${r.removed} removed, ${r.unchanged} unchanged; ${r.bytesTransferred} bytes transferred in ${r.ms}ms; verified=${r.verified} -> ${r.path}`);
      return 0;
    }

    case 'push': {
      need(1, 'push <host path> [sandbox path]');
      out(opt, await sbx.copyIn(pos[0], pos[1]), (r) => `Copied ${r.files} file(s), ${r.bytes} bytes -> ${r.path}`);
      return 0;
    }

    case 'pull': {
      need(1, 'pull <sandbox path> [name]');
      out(opt, await sbx.copyOut(pos[0], pos[1]), (r) => `Copied ${r.files} file(s), ${r.bytes} bytes -> ${r.hostPath}`);
      return 0;
    }

    case 'exec': {
      need(1, 'exec [--cmd] [--cwd <dir>] [--timeout <sec>] <command...>');
      const r = await sbx.exec({ command: pos.join(' '), shell: opt.cmd ? 'cmd' : 'powershell', cwd: opt.cwd, timeoutSec: num(opt.timeout, '--timeout') });
      if (opt.json) console.log(JSON.stringify(r, null, 2));
      else {
        if (r.stdout) process.stdout.write(r.stdout.endsWith('\n') ? r.stdout : `${r.stdout}\n`);
        if (r.stderr) process.stderr.write(r.stderr.endsWith('\n') ? r.stderr : `${r.stderr}\n`);
        if (r.timedOut) console.error(`sbx: timed out after ${r.durationMs}ms; process tree killed`);
      }
      return r.timedOut ? 124 : r.exitCode ?? 1;
    }

    case 'launch': {
      need(1, 'launch <exe> [--args "<args>"] [--cwd <dir>] [--wait <sec>]');
      out(opt, await sbx.launch({ path: pos[0], args: opt.args, cwd: opt.cwd, waitForWindowSec: num(opt.wait, '--wait') }), (r) =>
        `Started pid ${r.pid}${r.windowTitle ? `, window "${r.windowTitle}"` : r.hasExited ? `, already exited (code ${r.exitCode})` : ', no window yet'}`);
      return 0;
    }

    case 'proc': {
      need(1, 'proc <pid>');
      out(opt, await sbx.processInfo(num(pos[0], 'pid')), (r) =>
        r.hasExited ? `pid ${r.pid} exited with code ${r.exitCode}` : `pid ${r.pid} running${r.windowTitle ? `, window "${r.windowTitle}"` : ''}`);
      return 0;
    }

    case 'windows':
      out(opt, await sbx.windows(), (w) => table(w, ['pid', 'process', 'title']));
      return 0;

    case 'shot': {
      const r = await sbx.screenshot({ windowTitle: opt.window, pid: num(opt.pid, '--pid'), name: opt.name });
      const { previewBase64, ...rest } = r;
      out(opt, rest, `${r.path} (${r.width}x${r.height}); preview ${r.previewWidth}x${r.previewHeight}; captureId ${r.captureId}`);
      return 0;
    }

    case 'click': {
      need(2, 'click <x> <y> [--right] [--double]');
      out(opt, await sbx.click({ x: num(pos[0], 'x'), y: num(pos[1], 'y'), button: opt.right ? 'right' : 'left', double: !!opt.double,
        coordinates: opt.coordinates, captureId: opt['capture-id'] }), 'ok');
      return 0;
    }

    case 'type': {
      need(1, 'type <text> [--keys] [--window <title>] [--pid <pid>]');
      out(opt, await sbx.type({ keys: pos.join(' '), literal: !opt.keys, windowTitle: opt.window, pid: num(opt.pid, '--pid') }), 'ok');
      return 0;
    }

    case 'ui': {
      const sub = (pos[0] || 'tree').toLowerCase();
      const target = { pid: num(opt.pid, '--pid'), windowTitle: opt.window };
      const sel = { ...target, name: opt.name ?? (sub !== 'tree' ? pos.slice(1).join(' ') || undefined : undefined), automationId: opt.id, controlType: opt.type };
      if (sub === 'tree') {
        const t = await sbx.uiTree({ ...target, depth: num(opt.depth, '--depth'), maxNodes: num(opt.max, '--max') });
        out(opt, t, sbx.formatUiTree(t) || '(no UI elements found)');
      } else if (sub === 'wait') {
        const r = await sbx.waitForUi({ ...sel, timeoutSec: num(opt.timeout, '--timeout') });
        out(opt, r, `found after ${r.waitedMs}ms: ${sbx.formatUiNode(r, false)}`);
      } else {
        const action = sub === 'set' ? 'setvalue' : sub;
        const r = await sbx.uiAction({ ...sel, index: num(opt.index, '--index'), action, value: opt.value });
        out(opt, r, r.pending ? `${r.did}: pending - ${r.note}` : `${r.did}: ${sbx.formatUiNode(r, false)}${r.matches > 1 ? ` (1 of ${r.matches} matches)` : ''}`);
      }
      return 0;
    }

    case 'errors': {
      const e = await sbx.appErrors(opt.since);
      out(opt, e, () => e.length ? e.map((x) => `${x.time}  ${x.source} (${x.id})\n${x.message}\n`).join('\n') : 'No application errors.');
      return 0;
    }

    case 'snapshot': {
      need(1, 'snapshot <name> [--exclude <path>]...');
      out(opt, await sbx.snapshot(pos[0], opt.exclude), (r) =>
        `Snapshot '${pos[0]}': ${r.files} files, ${r.dirs} folders, ${r.registryKeys} registry keys, ${r.services} services (${(r.ms / 1000).toFixed(1)}s)`);
      return 0;
    }

    case 'diff': {
      need(2, 'diff <from> <to> [--max <n>]');
      out(opt, await sbx.diffSnapshots(pos[0], pos[1], num(opt.max, '--max')), (d) => sbx.formatDiff(d, { title: `${pos[0]} → ${pos[1]}` }));
      return 0;
    }

    case 'install-test': {
      need(1, 'install-test <setup.msi|.exe|.ps1|.cmd> [--args "..."] [--uninstall auto|none|"<cmd>"] [--test <script.ps1>] [--keep]');
      const r = await installTest({
        installer: pos[0], args: opt.args, uninstall: opt.uninstall, uninstallArgs: opt['uninstall-args'], test: opt.test,
        timeoutSec: num(opt.timeout, '--timeout'), failOnLeftovers: !!opt['fail-on-leftovers'], exclude: opt.exclude,
        max: num(opt.max, '--max'), keep: !!opt.keep, ...startOpts(opt),
      });
      if (opt.json) console.log(JSON.stringify({ ...r, shots: r.shots.map(({ previewBase64, ...s }) => s) }, null, 2));
      else {
        console.log(installSummary(r));
        if (r.test && r.test.exitCode !== 0) console.log(`--- test ${r.test.script} ---\n${[r.test.stdout, r.test.stderr].filter(Boolean).join('\n').trimEnd()}`);
        if (r.kept) console.log('Sandbox left running; `sbx stop` when done.');
      }
      if (opt.open && r.reportPath) spawn('cmd.exe', ['/c', 'start', '', r.reportPath], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      return r.pass ? 0 : 1;
    }

    case 'detonate': {
      need(1, 'detonate <file> [--args "..."] [--network off|firewall|on] [--duration <sec>] [--full] [--keep]');
      const s = startOpts(opt);
      const r = await detonate({
        file: pos[0], args: opt.args, durationSec: num(opt.duration, '--duration'), full: !!opt.full, shotEverySec: num(opt.every, '--every'),
        exclude: opt.exclude, max: num(opt.max, '--max'), keep: !!opt.keep, ...s, network: opt.offline ? 'off' : opt.network ?? 'off',
      });
      if (opt.json) console.log(JSON.stringify({ ...r, shots: r.shots.map(({ previewBase64, ...x }) => x) }, null, 2));
      else {
        console.log(detonateSummary(r));
        if (r.kept) console.log('Sandbox left running; `sbx stop` when done.');
      }
      if (opt.open && r.reportPath) spawn('cmd.exe', ['/c', 'start', '', r.reportPath], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      return r.error ? 1 : 0;
    }

    case 'run': {
      need(1, 'run <app.exe|folder> [--exe <name>] [--args "..."] [--console] [--test <script.ps1>] [--collect <path>]... [--keep]');
      const r = await runApp({
        app: pos[0], exe: opt.exe, args: opt.args, console: !!opt.console, record: !!opt.record, waitSec: num(opt.wait, '--wait'), provision: opt.provision,
        cert: opt.cert, deps: opt.deps, appId: opt['app-id'],
        test: opt.test, collect: opt.collect, keep: !!opt.keep, timeoutSec: num(opt.timeout, '--timeout'), ...startOpts(opt),
      });
      if (opt.json) console.log(JSON.stringify({ ...r, shots: r.shots.map(({ previewBase64, ...s }) => s) }, null, 2));
      else {
        console.log(summary(r));
        if (r.console?.stdout) console.log(`--- output ---\n${r.console.stdout.trimEnd()}`);
        if (r.test && r.test.exitCode !== 0) console.log(`--- test ${r.test.script} ---\n${[r.test.stdout, r.test.stderr].filter(Boolean).join('\n').trimEnd()}`);
        if (r.kept) console.log('Sandbox left running; `sbx stop` when done.');
      }
      if (opt.open && r.reportPath) spawn('cmd.exe', ['/c', 'start', '', r.reportPath], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      return r.pass ? 0 : 1;
    }

    default:
      throw new Error(`Unknown command '${cmd}'. Try: sbx help`);
  }
}

try {
  const code = await main(process.argv.slice(2));
  if (code !== null) process.exitCode = code;
} catch (e) {
  console.error(`sbx: ${e.message}`);
  process.exitCode = 1;
}
