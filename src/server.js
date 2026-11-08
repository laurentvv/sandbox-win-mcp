#!/usr/bin/env node
// sandbox-mcp: MCP server that drives Windows Sandbox (one fresh, ephemeral sandbox at a time).
// All the real work lives in core.js (shared with the `sbx` CLI); this file only maps it to MCP tools.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as sbx from './core.js';
import { runApp } from './run.js';
import { installTest, installSummary } from './install.js';
import { detonate, detonateSummary } from './detonate.js';
import { scanDependencies } from './deps.js';
import { provisionSandbox } from './provision.js';

const text = (v) => ({ content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }] });
const image = (base64, caption) => ({ content: [{ type: 'image', data: base64, mimeType: 'image/png' }, { type: 'text', text: caption }] });
const tool = (fn) => async (args) => {
  try { return await fn(args); } catch (e) { return { ...text(`Error: ${e.message}`), isError: true }; }
};
const cap = (s, n = 60_000) => (s && s.length > n ? `…[truncated ${s.length - n} chars]…\n${s.slice(-n)}` : s || '');
const network = z.enum(['on', 'firewall', 'off']).optional().describe(
  'on (default): normal internet. firewall: guest firewall blocks outbound (code running as admin could undo it). ' +
  'off: no network adapter at all (strongest isolation; the agent talks over shared folders, a bit slower).');

// The sandbox this server process started, stopped automatically when the MCP client goes away.
let startedTarget = null;
sbx.setDesktopOwner(process.env.SANDBOX_MCP_WORKFLOW || `mcp:${process.pid}`);
const server = new McpServer({ name: 'sandbox-mcp', version: sbx.VERSION });

server.registerTool('sandbox_deps', {
  title: 'Diagnose application dependencies',
  description: 'Host-only static scan of PE imports, .NET runtime configs, AppxManifest and scripts. Does not boot a sandbox, execute the app or install anything. Unknown/dynamic dependencies still require runtime observation.',
  inputSchema: { path: z.string().describe('Host app file or folder to inspect.') },
}, tool(async ({ path }) => text(scanDependencies(path))));

server.registerTool('sandbox_provision', {
  title: 'Explicitly provision dependencies into a started sandbox',
  description: 'OPT IN only. Host downloads official Microsoft runtime installers, verifies published hashes when available and Microsoft Authenticode signatures, then copies and silently installs in the already-started guest. Works with guest networking off. This is no longer a clean-machine test.',
  inputSchema: {
    app: z.string().describe('Host app path for dependency diagnosis.'),
    provision: z.string().describe('auto or comma-separated vcredist:x64,desktop:10.0:x64,dotnet:10.0:x64,aspnetcore:10.0:x64,windows-app-runtime:1.8:x64'),
  },
}, tool(async ({ app, provision }) => text(await provisionSandbox(app, provision))));

server.registerTool('sandbox_start', {
  title: 'Start Windows Sandbox',
  description: 'Boot a fresh, ephemeral Windows Sandbox (clean Windows install, elevated admin user) and connect the guest agent. ' +
    'Only one sandbox can exist at a time; everything inside is destroyed by sandbox_stop. Takes ~20-40s. ' +
    'Host-side artifacts (screenshots, copied-out files, audit log) stay in runDir after the sandbox is gone.',
  inputSchema: {
    network,
    internet: z.boolean().optional().describe('Deprecated: false is the same as network="off".'),
    memoryMB: z.number().int().min(2048).optional().describe('Memory for the sandbox in MB.'),
    vGpu: z.boolean().optional().describe('GPU acceleration (default true). false = software rendering, smaller attack surface.'),
    window: z.enum(['normal', 'minimized']).optional().describe('Sandbox window state on the host (default normal, so you can watch).'),
  },
}, tool(async (a) => {
  const r = await sbx.startSandbox(a);
  startedTarget = { id: r.id, epoch: r.epoch };
  return text(r);
}));

server.registerTool('sandbox_status', {
  title: 'Sandbox status',
  description: 'Show the current sandbox (id, boot epoch, verified agent protocol/version/SHA256, network mode, run folder) and whether the guest agent responds.',
  inputSchema: {},
}, tool(async () => text(await sbx.status())));

server.registerTool('sandbox_stop', {
  title: 'Stop Windows Sandbox',
  description: 'Stop and destroy the sandbox. Returns the host folder holding artifacts (screenshots, copied-out files).',
  inputSchema: { force: z.boolean().optional().describe('Also stop a sandbox not started by sandbox-mcp.') },
}, tool(async (a) => {
  const r = await sbx.stopSandbox(a);
  startedTarget = null;
  return { ...text(r), ...(r.recordingError ? { isError: true } : {}) };
}));

server.registerTool('sandbox_desktop_release', {
  title: 'Release sandbox desktop',
  description: 'End this workflow desktop turn immediately instead of waiting for its four-second idle grace.',
  inputSchema: {},
}, tool(async () => text(sbx.releaseDesktop())));

server.registerTool('sandbox_copy_in', {
  title: 'Copy into sandbox',
  description: 'Copy a host file or folder (e.g. your build output) onto the sandbox local disk.',
  inputSchema: {
    hostPath: z.string().describe('Absolute host path to a file or folder.'),
    sandboxPath: z.string().optional().describe('Destination path inside the sandbox (default C:\\apps\\<name>).'),
  },
}, tool(async ({ hostPath, sandboxPath }) => text(await sbx.copyIn(hostPath, sandboxPath))));

server.registerTool('sandbox_deploy', {
  title: 'Deploy changed build output',
  description: 'Explicit warm-sandbox inner loop: transfer only added/changed files, delete removed files, verify all destination SHA256 hashes. ' +
    'Requires an already running sandbox. Rejects links/reparse points and build output that changes while staging. copy_in still does a full replace.',
  inputSchema: {
    hostPath: z.string().describe('Host build output directory (must be under SANDBOX_MCP_ALLOWED_ROOTS when set).'),
    sandboxPath: z.string().optional().describe('Exclusive deployment directory; extra guest files are removed. Default C:\\apps\\<name>.'),
    launch: z.string().optional().describe('Executable inside the destination, relative or absolute, to launch after verification.'),
    args: z.string().optional(),
    restart: z.boolean().optional().describe('Stop processes whose image path is under the destination before applying; requires launch.'),
  },
}, tool(async (a) => text(await sbx.deploy(a))));

server.registerTool('sandbox_copy_out', {
  title: 'Copy out of sandbox',
  description: 'Copy a file or folder from the sandbox back to the host (into the run outDir/files). Returns the host path.',
  inputSchema: {
    sandboxPath: z.string().describe('Path inside the sandbox.'),
    name: z.string().optional().describe('Name for the copy under outDir/files (default: source name).'),
  },
}, tool(async ({ sandboxPath, name }) => text(await sbx.copyOut(sandboxPath, name))));

server.registerTool('sandbox_exec', {
  title: 'Run command in sandbox',
  description: 'Run a command in the sandbox (elevated admin user session) and wait for it. Returns stdout, stderr and exit code. ' +
    'Use sandbox_launch for GUI apps or anything long-running. The sandbox has Windows PowerShell 5.1 and .NET Framework 4, ' +
    'but no Store apps (no Notepad, Calculator, Terminal) and no winget.',
  inputSchema: {
    command: z.string(),
    shell: z.enum(['powershell', 'cmd']).optional().describe('Default powershell (Windows PowerShell 5.1).'),
    cwd: z.string().optional(),
    timeoutSec: z.number().positive().optional().describe('Default 120. The process tree is killed on timeout.'),
  },
}, tool(async (a) => {
  const r = await sbx.exec(a);
  const body = [`exitCode: ${r.timedOut ? 'TIMED OUT' : r.exitCode}  (${r.durationMs}ms)`,
    r.stdout && `--- stdout ---\n${cap(r.stdout)}`, r.stderr && `--- stderr ---\n${cap(r.stderr)}`].filter(Boolean).join('\n');
  return { ...text(body), isError: r.timedOut || r.exitCode !== 0 };
}));

server.registerTool('sandbox_launch', {
  title: 'Launch app in sandbox',
  description: 'Start a program (e.g. a GUI app) on the sandbox desktop without waiting for it to exit. Returns its pid.',
  inputSchema: {
    path: z.string().optional().describe('Executable path inside the sandbox, or PackageFamilyName!ApplicationId.'),
    aumid: z.string().optional().describe('Installed packaged app AUMID (PackageFamilyName!ApplicationId), instead of path.'),
    args: z.string().optional(),
    cwd: z.string().optional(),
    waitForWindowSec: z.number().min(0).optional().describe('Wait up to N seconds for a main window (default 15).'),
  },
}, tool(async (a) => text(await sbx.launch(a))));

server.registerTool('sandbox_process', {
  title: 'Check launched process',
  description: 'Is a process started with sandbox_launch still running? Returns hasExited, exitCode and its main window title.',
  inputSchema: { pid: z.number().int() },
}, tool(async ({ pid }) => text(await sbx.processInfo(pid))));

server.registerTool('sandbox_windows', {
  title: 'List sandbox windows',
  description: 'List top-level windows on the sandbox desktop (pid, process, title, screen rect).',
  inputSchema: {},
}, tool(async () => text(await sbx.windows())));

server.registerTool('sandbox_screenshot', {
  title: 'Screenshot sandbox',
  description: 'Capture the sandbox desktop, or one window by title/pid. Returns a preview image; the full-resolution PNG is saved ' +
    'on the host. sandbox_click coordinates refer to this image by default.',
  inputSchema: {
    windowTitle: z.string().optional().describe('Capture only the first window whose title contains this text.'),
    pid: z.number().int().optional().describe('Capture only the main window of this process.'),
    name: z.string().optional().describe('Label used in the saved file name.'),
    maxWidth: z.number().int().min(200).max(4000).optional().describe('Preview width (default 1280).'),
  },
}, tool(async (a) => {
  const s = await sbx.screenshot(a);
  return image(s.previewBase64, `Saved ${s.path}; source bounds (${s.left},${s.top}) ${s.width}x${s.height}; preview ${s.previewWidth}x${s.previewHeight}, scale ${s.scale}; captureId ${s.captureId}.`);
}));

server.registerTool('sandbox_record_start', {
  title: 'Record sandbox desktop',
  description: 'Capture bounded desktop evidence in an independent guest process, including during long exec calls. Frames and metadata stream to the host share; no guest dependencies or network needed.',
  inputSchema: {
    fps: z.number().int().min(1).max(5).optional().describe('Frames per second (default 2).'),
    maxDurationSec: z.number().int().min(1).max(300).optional().describe('Maximum duration (default 120 seconds).'),
    maxFrames: z.number().int().min(1).max(600).optional().describe('Maximum frames (default fps * duration, capped at 600).'),
  },
}, tool(async (a) => text(await sbx.recordStart(a))));

server.registerTool('sandbox_record_stop', {
  title: 'Publish sandbox recording',
  description: 'Stop the tracked recorder and publish a self-contained HTML flipbook, plus MP4 when host ffmpeg is available. Keeps raw frames and manifest even on failure. Also publishes partial evidence after a guest crash.',
  inputSchema: {},
}, tool(async () => {
  const r = await sbx.recordStop();
  return { ...text(r), ...(!r.stopped ? { isError: true } : {}) };
}));

server.registerTool('sandbox_click', {
  title: 'Click in sandbox',
  description: 'Click at a point. By default x/y are pixel coordinates in the most recent sandbox_screenshot image. ' +
    'Prefer sandbox_ui_action when the target control has a name: it is more reliable than pixels.',
  inputSchema: {
    x: z.number(), y: z.number(),
    button: z.enum(['left', 'right']).optional(),
    double: z.boolean().optional(),
    coordinates: z.enum(['screenshot', 'screen']).optional().describe('screenshot (default) or raw sandbox screen pixels.'),
    captureId: z.string().optional().describe('Screenshot to map coordinates against (default latest). Moved/resized windows are rejected.'),
  },
}, tool(async ({ coordinates = 'screenshot', ...a }) => text(await sbx.click({ ...a, coordinates }))));

server.registerTool('sandbox_type', {
  title: 'Send keys in sandbox',
  description: 'Type text or send key chords to the focused window (or a window found by title/pid, which is focused first). ' +
    'With literal=false, uses SendKeys syntax: {ENTER}, {TAB}, ^s (Ctrl+S), %{F4} (Alt+F4).',
  inputSchema: {
    keys: z.string(),
    literal: z.boolean().optional().describe('Treat keys as plain text (default true).'),
    windowTitle: z.string().optional(),
    pid: z.number().int().optional(),
  },
}, tool(async (a) => text(await sbx.type(a))));

const target = {
  pid: z.number().int().optional().describe('Process whose windows to search (from sandbox_launch).'),
  windowTitle: z.string().optional().describe('Or: a window whose title contains this text.'),
};
const selector = {
  name: z.string().optional().describe('Element name (visible label), exact match; falls back to contains.'),
  automationId: z.string().optional().describe('AutomationId (control name in WinForms/WPF), exact match.'),
  controlType: z.string().optional().describe('Button, Edit, CheckBox, ComboBox, ListItem, MenuItem, TabItem, Text, ...'),
};

server.registerTool('sandbox_ui_tree', {
  title: 'UI Automation tree',
  description: 'Read the accessibility (UI Automation) tree of an app in the sandbox: one line per control with type, "name", ' +
    '#automationId, = value, [x] toggle state and {available actions}. Much cheaper and more precise than a screenshot ' +
    'for finding controls. Without pid/windowTitle it reads every top-level window (can be large).',
  inputSchema: {
    ...target,
    depth: z.number().int().min(1).max(50).optional().describe('Max depth (default 12).'),
    maxNodes: z.number().int().min(10).max(5000).optional().describe('Max elements (default 400).'),
    json: z.boolean().optional().describe('Return raw JSON (with screen rects) instead of the outline.'),
  },
}, tool(async ({ json, ...a }) => {
  const t = await sbx.uiTree(a);
  return text(json ? t : sbx.formatUiTree(t) || '(no UI elements found)');
}));

server.registerTool('sandbox_ui_action', {
  title: 'Act on a UI control',
  description: 'Find a control by name / automationId / controlType (any combination) and act on it through UI Automation: ' +
    'click (Invoke, Toggle, Select or ExpandCollapse as appropriate, else a real mouse click), doubleclick, rightclick, ' +
    'setvalue (type into an edit box), toggle, select, expand, collapse, focus, or read (just return its state). ' +
    'Use sandbox_ui_tree first to see names. If a click opens a modal dialog the result is {pending:true}; that is fine.',
  inputSchema: {
    ...target, ...selector,
    index: z.number().int().min(0).optional().describe('Which match to use when several match (default 0).'),
    action: z.enum(['click', 'doubleclick', 'rightclick', 'setvalue', 'toggle', 'select', 'expand', 'collapse', 'focus', 'read'])
      .optional().describe('Default click.'),
    value: z.string().optional().describe('Text for setvalue.'),
  },
}, tool(async (a) => {
  const r = await sbx.uiAction(a);
  return text(r.pending ? r : `${r.did}: ${sbx.formatUiNode(r, false)}${r.matches > 1 ? ` (1 of ${r.matches} matches)` : ''}`);
}));

server.registerTool('sandbox_ui_wait', {
  title: 'Wait for a UI control',
  description: 'Wait until a control matching name / automationId / controlType appears (e.g. a result label, a dialog, a ' +
    'finished state). Returns the element, or an error after timeoutSec.',
  inputSchema: { ...target, ...selector, timeoutSec: z.number().min(1).max(600).optional().describe('Default 30.') },
}, tool(async (a) => {
  const r = await sbx.waitForUi(a);
  return text(`found after ${r.waitedMs}ms: ${sbx.formatUiNode(r, false)}`);
}));

server.registerTool('sandbox_app_errors', {
  title: 'Application errors in sandbox',
  description: 'Error and critical events from the sandbox Application event log (crashes, .NET unhandled exceptions, side-by-side errors).',
  inputSchema: { since: z.string().optional().describe('ISO time (e.g. launchedAt from sandbox_launch). Default: last hour.') },
}, tool(async ({ since }) => text(await sbx.appErrors(since))));

server.registerTool('sandbox_run', {
  title: 'Test an app in a fresh sandbox',
  description: 'One shot: boot a fresh sandbox, copy the app folder in, run it, screenshot it, check for crashes, optionally run a ' +
    'PowerShell test script inside, copy files out, destroy the sandbox and write report.md. Use this for "does my build work on a ' +
    'clean Windows machine?". Fails if a sandbox is already running.',
  inputSchema: {
    app: z.string().describe('Host path to an .exe, app folder, .msix, .msixbundle, .appx or .appxbundle.'),
    cert: z.string().optional().describe('Host .cer to trust in the disposable guest TrustedPeople store only.'),
    deps: z.string().optional().describe('Host folder of dependency packages. Defaults to a deps folder beside the package.'),
    appId: z.string().optional().describe('Manifest Application Id; required when the package has multiple applications.'),
    exe: z.string().optional().describe('Exe name when app is a folder with more than one .exe.'),
    args: z.string().optional(),
    console: z.boolean().optional().describe('Console app: run to completion and capture stdout instead of launching a window.'),
    provision: z.string().optional().describe('Explicit opt-in: auto or comma-separated runtime list (e.g. desktop:10.0:x64,vcredist:x64). Host downloads and verifies installers; guest can stay offline. Marks this run PROVISIONED, never a clean-machine pass. Omit for a true clean-machine test.'),
    record: z.boolean().optional().describe('Record desktop evidence at 2 fps for up to 120 seconds; report links HTML and optional MP4.'),
    waitSec: z.number().min(0).optional().describe('GUI apps: seconds to let the app settle before observing (default 5).'),
    test: z.string().optional().describe('Host path to a .ps1 run inside after launch. Gets $env:SBX_APP_PID, SBX_APP_DIR, SBX_APP_EXE, SBX_OUT. Non-zero exit = fail.'),
    collect: z.array(z.string()).optional().describe('Sandbox paths to copy back to the host afterwards (logs, output files).'),
    keep: z.boolean().optional().describe('Leave the sandbox running afterwards for more poking.'),
    network,
    memoryMB: z.number().int().min(2048).optional(),
    window: z.enum(['normal', 'minimized']).optional(),
  },
}, tool(async (a) => {
  const r = await runApp(a);
  if (r.kept) startedTarget = r.sandbox;
  const summary = [
    `${r.pass ? 'PASS' : 'FAIL'}: ${r.app}${r.failures.length ? ` (${r.failures.join('; ')})` : ''}`,
    `Report: ${r.reportPath ?? '(none)'}`,
    r.provisionRequested && `PROVISIONED (not a clean-machine pass): ${JSON.stringify(r.provisioned)}`,
    r.console && `--- console stdout ---\n${cap(r.console.stdout, 20_000)}`,
    r.test && `--- test ${r.test.script}: exit ${r.test.exitCode} ---\n${cap(r.test.stdout, 20_000)}${r.test.stderr ? `\n--- test stderr ---\n${cap(r.test.stderr, 10_000)}` : ''}`,
    r.crashes.length && `--- crash events ---\n${r.crashes.map((e) => `${e.source} ${e.id}: ${e.message}`).join('\n\n')}`,
    `Took ${r.seconds.toFixed(1)}s; sandbox ${r.kept ? 'still running' : r.stopError ? 'teardown failed' : r.sandbox ? 'destroyed' : 'not started'}.`,
  ].filter(Boolean).join('\n');
  const shot = r.shots.find((s) => s.name === 'app') ?? r.shots.at(-1);
  const content = [{ type: 'text', text: summary }];
  if (shot) content.push({ type: 'image', data: shot.previewBase64, mimeType: 'image/png' });
  return { content, isError: !r.pass };
}));

server.registerTool('sandbox_snapshot', {
  title: 'Snapshot sandbox state',
  description: 'Record files (Program Files, ProgramData, user profiles, drivers, scheduled tasks, top of C:\\ and System32), all ' +
    'HKLM\\SOFTWARE and HKCU\\Software keys, services/drivers, autoruns, environment and Add/Remove Programs entries under a name. ' +
    'Known Windows background noise is filtered out. Takes ~15s. Compare two with sandbox_diff.',
  inputSchema: {
    name: z.string().regex(/^[\w-]+$/).describe('e.g. "before", "after-install"'),
    exclude: z.array(z.string()).optional().describe('Extra file or registry (HKLM\\..., HKCU\\...) paths to ignore. A trailing * makes it a prefix match.'),
  },
}, tool(async ({ name, exclude }) => text(await sbx.snapshot(name, exclude))));

server.registerTool('sandbox_diff', {
  title: 'Diff two sandbox snapshots',
  description: 'What changed between two snapshots: installed programs, services/drivers, autorun/environment values, files and ' +
    'registry keys added/removed/changed. New folders and keys are collapsed to their topmost new parent. Markdown.',
  inputSchema: {
    from: z.string().regex(/^[\w-]+$/), to: z.string().regex(/^[\w-]+$/),
    max: z.number().int().min(1).optional().describe('Max entries per list (default 200).'),
  },
}, tool(async ({ from, to, max }) => text(sbx.formatDiff(await sbx.diffSnapshots(from, to, max), { title: `${from} → ${to}` }))));

server.registerTool('sandbox_install_test', {
  title: 'Test an installer in a fresh sandbox',
  description: 'One shot: boot a fresh sandbox, snapshot, run the installer silently, snapshot, optionally run a test script, ' +
    'uninstall using what the installer registered in Add/Remove Programs, snapshot again, destroy the sandbox. Reports exactly what ' +
    'the install added (files, registry, services, autoruns, scheduled tasks, processes left running) and what the uninstaller left ' +
    'behind. If an installer hangs (usually a dialog waiting for a click), it is screenshotted and its controls are listed. ' +
    'Fails if a sandbox is already running.',
  inputSchema: {
    installer: z.string().describe('Host path to a .msi, .exe, .ps1, .cmd or .bat installer.'),
    args: z.string().optional().describe('Installer arguments. .msi already gets /qn /norestart; for .exe pass the silent switch (/S, /VERYSILENT, /quiet...).'),
    uninstall: z.string().optional().describe('"auto" (default), "none", or an uninstall command line to run instead.'),
    uninstallArgs: z.string().optional().describe('Auto mode: appended to the registered UninstallString when there is no QuietUninstallString, e.g. /S.'),
    test: z.string().optional().describe('Host .ps1 run after install. Gets $env:SBX_INSTALL_DIR, SBX_PROGRAM, SBX_OUT. Non-zero exit = fail.'),
    timeoutSec: z.number().min(10).optional().describe('Per installer/uninstaller run (default 600).'),
    failOnLeftovers: z.boolean().optional(),
    exclude: z.array(z.string()).optional().describe('Extra noisy paths to ignore in the snapshots.'),
    keep: z.boolean().optional(),
    network,
  },
}, tool(async (a) => {
  const r = await installTest(a);
  if (r.kept) startedTarget = r.sandbox;
  const parts = [installSummary(r)];
  if (r.installDiff) parts.push(sbx.formatDiff(r.installDiff, { title: 'What the install changed' }));
  if (r.leftovers) parts.push(sbx.formatDiff(r.leftovers, { title: 'Left behind after uninstall' }));
  for (const x of [r.install, ...r.uninstalls].filter((x) => x?.stuckUi)) parts.push(`--- stuck: ${x.command} ---\n${x.stuckUi}`);
  if (r.test) parts.push(`--- test ${r.test.script}: exit ${r.test.exitCode} ---\n${cap(r.test.stdout, 10_000)}${r.test.stderr ? `\n${cap(r.test.stderr, 5_000)}` : ''}`);
  const content = [{ type: 'text', text: cap(parts.join('\n\n'), 60_000) }];
  const shot = r.shots.find((s) => s.name.endsWith('-stuck')) ?? r.shots.find((s) => s.name === 'after-install');
  if (shot) content.push({ type: 'image', data: shot.previewBase64, mimeType: 'image/png' });
  return { content, isError: !r.pass };
}));

server.registerTool('sandbox_detonate', {
  title: 'Run an untrusted file and report what it does',
  description: 'One shot: boot a fresh sandbox (no network adapter by default), turn on Windows process, connection and DNS auditing, ' +
    'run the file the way a double-click would, watch it, then destroy the sandbox. Reports every process it started (with ' +
    'command lines), names it looked up, connections it tried, files/registry/autoruns/services/scheduled tasks it changed, ' +
    'windows and screenshots, plus plain-language findings (heuristics, not a verdict). Fails if a sandbox is already running.',
  inputSchema: {
    file: z.string().describe('Host path to an .exe, .msi, .ps1, .cmd, .bat, .js, .vbs, .wsf or .hta.'),
    args: z.string().optional(),
    network: z.enum(['off', 'firewall', 'on']).optional().describe(
      'off (default): no adapter; name lookups are still recorded. firewall: also records the addresses it tries (blocked by the ' +
      'guest firewall, which admin code could undo). on: real internet; only for files you are prepared to let talk to the world.'),
    durationSec: z.number().min(5).optional().describe('Watch for at most this long (default 60).'),
    full: z.boolean().optional().describe('Watch the whole duration even after everything it started has exited.'),
    exclude: z.array(z.string()).optional().describe('Extra noisy paths to ignore in the snapshots.'),
    keep: z.boolean().optional().describe('Leave the sandbox running afterwards (it keeps whatever the file did).'),
  },
}, tool(async (a) => {
  const r = await detonate({ ...a, network: a.network ?? 'off' });
  if (r.kept) startedTarget = r.sandbox;
  const parts = [detonateSummary(r)];
  if (r.findings.length) parts.push(r.findings.map((f) => `- [${f.level}] ${f.text}`).join('\n'));
  if (r.tree?.length) parts.push('Processes:\n' + r.tree.map((p) => `${'  '.repeat(p.depth)}${p.pid} ${p.commandLine || p.path}`).join('\n'));
  if (r.error) parts.push(`Error: ${r.error}`);
  const content = [{ type: 'text', text: cap(parts.join('\n\n'), 60_000) }];
  const last = r.shots.at(-1);
  if (last?.previewBase64) content.push({ type: 'image', data: last.previewBase64, mimeType: 'image/png' });
  return { content, isError: !!r.error };
}));

// Lifecycle: a sandbox started by this server should not outlive the client that asked for it.
let exiting = false;
function shutdown(why) {
  if (exiting) return;
  exiting = true;
  if (startedTarget && process.env.SANDBOX_MCP_KEEP_ON_EXIT !== '1') {
    sbx.log(`${why}: stopping owned sandbox ${startedTarget.id} (epoch ${startedTarget.epoch})`);
    try { sbx.stopDetached(startedTarget); } catch (e) { sbx.log(`Owned sandbox teardown failed: ${e.message}`); }
  }
  setTimeout(() => process.exit(0), 100);
}
process.stdin.on('end', () => shutdown('client disconnected'));
process.stdin.on('close', () => shutdown('client disconnected'));
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) process.on(sig, () => shutdown(sig));

await server.connect(new StdioServerTransport());
sbx.log(`sandbox-mcp ${sbx.VERSION} ready; home=${sbx.HOME}`);
