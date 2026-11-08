// "What does this file actually do when I run it?" Boot a fresh sandbox (no network adapter by default), turn on
// Windows' own auditing, run the file, watch it, then report every process it started (with command lines), the
// names it looked up, the connections it tried, what it changed on disk and in the registry (autoruns, services,
// scheduled tasks, dropped executables) and what was on screen. The sandbox, and anything the file did, is then deleted.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as sbx from './core.js';
import { shot } from './run.js';
import { installCommand } from './install.js';

const GUEST_DIR = 'C:\\Users\\WDAGUtilityAccount\\Downloads';
const WATCH = `${sbx.GUEST.agent}\\watch.ps1`;

/** Built-in Windows programs that malware leans on ("living off the land"). Seeing them is a reason to look closer, not proof. */
export const LOLBINS = new Set(['powershell.exe', 'pwsh.exe', 'cmd.exe', 'wscript.exe', 'cscript.exe', 'mshta.exe', 'rundll32.exe',
  'regsvr32.exe', 'certutil.exe', 'bitsadmin.exe', 'schtasks.exe', 'reg.exe', 'wmic.exe', 'net.exe', 'net1.exe', 'sc.exe',
  'vssadmin.exe', 'bcdedit.exe', 'wbadmin.exe', 'whoami.exe', 'nltest.exe', 'curl.exe', 'installutil.exe', 'msbuild.exe',
  'regasm.exe', 'cmstp.exe', 'attrib.exe', 'icacls.exe', 'takeown.exe', 'netsh.exe', 'wevtutil.exe', 'fodhelper.exe',
  'msiexec.exe', 'forfiles.exe', 'hh.exe', 'odbcconf.exe', 'msxsl.exe', 'tasklist.exe', 'systeminfo.exe', 'ipconfig.exe']);

const exeName = (p) => String(p || '').split('\\').pop().toLowerCase();

/** How to run a file the way a double-click would (installers silently, scripts with their default host). */
export function detonateCommand(guestPath, args = '') {
  const ext = path.extname(guestPath).toLowerCase();
  if (['.js', '.jse', '.vbs', '.vbe', '.wsf'].includes(ext)) return { file: 'wscript.exe', args: `"${guestPath}" ${args}`.trim() };
  if (ext === '.hta') return { file: 'mshta.exe', args: `"${guestPath}"` };
  if (['.msi', '.ps1', '.cmd', '.bat', '.exe'].includes(ext)) return installCommand(guestPath, args);
  throw new Error(`Don't know how to run ${ext || 'this file'}: use an .exe, .msi, .ps1, .cmd, .bat, .js, .vbs, .wsf or .hta.`);
}

/**
 * Split audited process starts into the file's own process tree and everything else, dropping the agent's own helpers.
 * events: [{pid, ppid, path, commandLine, time}] from 4688. The root is the process the agent launched.
 */
export function processTree(events, rootPid, agentPid) {
  const byParent = new Map();
  for (const e of events) byParent.set(e.ppid, [...(byParent.get(e.ppid) || []), e]);
  const walk = (starts) => {
    const seen = new Set(starts);
    const queue = [...starts];
    while (queue.length) for (const c of byParent.get(queue.shift()) || []) if (!seen.has(c.pid)) { seen.add(c.pid); queue.push(c.pid); }
    return seen;
  };
  const mine = walk([rootPid]);
  const noise = walk(events.filter((e) => e.ppid === agentPid && e.pid !== rootPid).map((e) => e.pid));
  const byTime = (a, b) => String(a.time).localeCompare(String(b.time));
  const depth = (e) => { let d = 0; for (let p = e; p && p.pid !== rootPid && d < 50; p = events.find((x) => x.pid === p.ppid && mine.has(x.pid))) d++; return d; };
  return {
    pids: mine,
    tree: events.filter((e) => mine.has(e.pid)).sort(byTime).map((e) => ({ ...e, depth: depth(e) })),
    others: events.filter((e) => !mine.has(e.pid) && !noise.has(e.pid)).sort(byTime),
  };
}

/** Plain-language findings, most serious first. level: high (persistence, tampering), medium (worth a look), info. */
export function findings({ tree = [], lookups = [], connections = [], diff, windows = [], crashes = [] }) {
  const out = [];
  const add = (level, text) => out.push({ level, text });
  const children = tree.filter((p) => p.depth > 0);
  if (diff) {
    const autoruns = diff.values.filter((v) => v.change !== 'removed' && /\\(Run|RunOnce)\\|\\Winlogon\\|\\Image File Execution Options\\/i.test(v.name));
    for (const v of autoruns) add('high', `starts itself with Windows: ${v.change} \`${v.name}\` = \`${v.after}\``);
    for (const s of diff.services.filter((x) => x.change === 'added')) add('high', `installed a service or driver: \`${s.name}\` (${(s.after || '').split('|')[3] || 'no image path'})`);
    const tasks = diff.files.added.filter((f) => /^C:\\Windows\\System32\\Tasks\\/i.test(f.path));
    for (const t of tasks) add('high', `created a scheduled task: \`${t.path.slice('C:\\Windows\\System32\\Tasks\\'.length)}\``);
    const startup = [...diff.files.added.map((f) => f.path), ...diff.files.executables].filter((p) => /\\Start Menu\\Programs\\Startup\\/i.test(p));
    for (const p of [...new Set(startup)]) add('high', `put something in a Startup folder: \`${p}\``);
    if (diff.files.changed.some((p) => /\\drivers\\etc\\hosts$/i.test(p))) add('high', 'changed the hosts file (can redirect websites)');
    const policy = diff.registry.added.filter((k) => /\\Policies\\Microsoft\\(Windows Defender|WindowsFirewall)|\\SharedAccess\\Parameters\\FirewallPolicy/i.test(k.path));
    for (const k of policy) add('high', `changed security policy: \`${k.path}\``);
    const env = diff.values.filter((v) => /\\Environment\\/i.test(v.name));
    if (env.length) add('medium', `changed environment variables: ${env.map((v) => `\`${v.name.split('\\').pop()}\``).join(', ')}`);
    if (diff.files.executableCount) {
      const shown = diff.files.executables.slice(0, 5).map((p) => `\`${p}\``).join(', ');
      add('medium', `wrote ${diff.files.executableCount} runnable file(s): ${shown}${diff.files.executableCount > 5 ? ', …' : ''}`);
    }
    for (const p of diff.programsAdded) add('info', `installed ${p.displayName}${p.displayVersion ? ` ${p.displayVersion}` : ''}`);
  }
  const tools = [...new Set(children.map((p) => exeName(p.path)).filter((n) => LOLBINS.has(n)))];
  if (tools.length) add('medium', `ran built-in Windows tools that malware often uses: ${tools.join(', ')}`);
  if (lookups.length) add('medium', `looked up ${lookups.length} internet name(s): ${lookups.slice(0, 6).map((l) => l.name).join(', ')}${lookups.length > 6 ? ', …' : ''}`);
  if (connections.length) {
    const ends = connections.slice(0, 6).map((c) => `${c.address}:${c.port}`).join(', ');
    add('medium', `tried to connect to ${connections.length} address(es): ${ends}${connections.length > 6 ? ', …' : ''}`);
  }
  if (children.length) add('info', `started ${children.length} other process(es)`);
  if (windows.length) add('info', `opened ${windows.length} window(s): ${windows.map((w) => `"${w.title}"`).join(', ')}`);
  if (crashes.length) add('info', `${crashes.length} application error(s) in the event log`);
  const rank = { high: 0, medium: 1, info: 2 };
  return out.sort((a, b) => rank[a.level] - rank[b.level]);
}

/** Dedupe DNS events into one row per name (failed unless any attempt succeeded) and connections into one row per endpoint. */
export function network(c, pids) {
  const names = new Map();
  for (const d of c.dns.filter((x) => pids.has(x.pid))) {
    const n = names.get(d.name.toLowerCase()) || { name: d.name, pid: d.pid, time: d.time, ok: false };
    if (d.status === '0') n.ok = true;
    names.set(d.name.toLowerCase(), n);
  }
  const ends = new Map();
  for (const x of c.connections.filter((y) => pids.has(y.pid))) {
    const k = `${x.address}|${x.port}|${x.protocol}`;
    const e = ends.get(k) || { ...x, count: 0 };
    e.count++; e.blocked = e.blocked && x.blocked;
    ends.set(k, e);
  }
  return { lookups: [...names.values()], connections: [...ends.values()] };
}

async function collect(since) {
  const r = await sbx.exec({ command: `& '${WATCH}' -Since '${since}'`, timeoutSec: 120 });
  if (r.exitCode !== 0) throw new Error(`collecting events failed: ${r.stderr || r.stdout}`);
  const c = JSON.parse(r.stdout.trim());
  for (const k of ['processes', 'connections', 'dns', 'alive']) c[k] = [].concat(c[k] ?? []);
  return c;
}

/**
 * file: host path. Options: args, durationSec (max watch time, default 60), full (always watch the whole time instead of
 * stopping once everything it started has exited), shotEverySec (default 15), exclude[], keep, plus startSandbox options
 * (network defaults to 'off').
 */
export async function detonate(o) {
  const src = path.resolve(o.file);
  if (!fs.existsSync(src) || !fs.statSync(src).isFile()) throw new Error(`File not found: ${src}`);
  const name = path.basename(src);
  detonateCommand(name); // validate the extension before booting
  const net = o.network ?? (o.internet === true ? 'on' : 'off');
  const durationSec = o.durationSec ?? 60;
  const r = {
    file: name, hostPath: src, sha256: createHash('sha256').update(fs.readFileSync(src)).digest('hex'), args: o.args || '',
    startedAt: new Date().toISOString(), shots: [], windows: [], crashes: [],
  };
  const t0 = Date.now();
  let booted = false;
  try {
    const boot = await sbx.startSandbox({ ...o, network: net });
    booted = true;
    r.sandbox = { id: boot.id, epoch: boot.epoch, network: boot.network, bootSeconds: boot.bootSeconds };
    r.runDir = boot.runDir; r.outDir = boot.outDir;
    const guest = `${GUEST_DIR}\\${name}`;
    await sbx.copyIn(src, guest);

    const ag = await sbx.exec({ command: '(Get-CimInstance Win32_Process -Filter "ProcessId=$PID").ParentProcessId', timeoutSec: 60 });
    const agentPid = Number(ag.stdout.trim());
    sbx.log('turning on process, connection and DNS auditing');
    const armed = await sbx.exec({ command: `& '${WATCH}' -Arm`, timeoutSec: 60 });
    if (armed.exitCode !== 0) throw new Error(`could not turn on auditing: ${armed.stderr || armed.stdout}`);
    r.since = armed.stdout.trim();
    sbx.log('snapshot before');
    await sbx.snapshot('before', o.exclude);
    const windowsBefore = await sbx.windows();

    const cmd = detonateCommand(guest, o.args);
    sbx.log(`running ${name} and watching for up to ${durationSec}s`);
    const l = await sbx.launch({ path: cmd.file, args: cmd.args, cwd: GUEST_DIR, waitForWindowSec: 0 });
    r.command = `${cmd.file} ${cmd.args || ''}`.trim();
    r.rootPid = l.pid;
    const every = o.shotEverySec ?? 15;
    let nextShot = 5, quiet = 0, w0 = Date.now();
    for (;;) {
      await sbx.sleep(2500);
      const s = (Date.now() - w0) / 1000;
      if (s >= nextShot) { r.shots.push(await shot({ name: `t+${Math.round(s)}s` })); nextShot += every; }
      if (s >= durationSec) break;
      const p = await sbx.processInfo(l.pid);
      if (p.hasExited) {
        r.exitCode ??= p.exitCode;
        if (o.full) continue;
        const c = await collect(r.since);
        const t = processTree(c.processes, l.pid, agentPid);
        if (c.alive.some((pid) => t.pids.has(pid))) quiet = 0;
        else if (++quiet >= 3) { r.stoppedEarly = true; break; }
      }
    }
    r.watchedSeconds = (Date.now() - w0) / 1000;
    sbx.log('collecting what happened');
    r.shots.push(await shot({ name: 'end' }));
    const seen = new Set(windowsBefore.map((w) => `${w.pid}|${w.title}`));
    r.windows = (await sbx.windows()).filter((w) => !seen.has(`${w.pid}|${w.title}`));
    const c = await collect(r.since);
    const t = processTree(c.processes, l.pid, agentPid);
    // Measure from the file's own start, and leave out background activity from before it ran (the snapshot, boot tasks).
    r.launchedAt = t.tree[0]?.time ?? r.since;
    const after = (x) => ms(x.time) >= ms(r.launchedAt) - 1000;
    r.tree = t.tree; r.others = t.others.filter(after);
    r.stillRunning = t.tree.filter((p) => c.alive.includes(p.pid)).map((p) => p.pid);
    Object.assign(r, network(c, t.pids));
    const otherPids = new Set(r.others.map((p) => p.pid));
    r.otherLookups = [...new Set(c.dns.filter((d) => !t.pids.has(d.pid) && after(d)).map((d) => d.name.toLowerCase()))];
    r.otherConnections = network(c, otherPids).connections;
    r.crashes = await sbx.appErrors(r.since);
    sbx.log('snapshot after');
    await sbx.snapshot('after', o.exclude);
    r.diff = await sbx.diffSnapshots('before', 'after', o.max ?? 200);
  } catch (e) {
    r.error = e.message;
    r.errorStack = e.stack;
  } finally {
    if (booted && !o.keep) {
      sbx.log('destroying the sandbox');
      const st = await sbx.stopSandbox({ target: r.sandbox }).catch((e) => ({ error: e.message }));
      if (st.error) r.stopError = st.error;
    }
    r.kept = booted && !!o.keep;
  }
  r.seconds = (Date.now() - t0) / 1000;
  r.findings = r.error ? [] : findings(r);
  if (r.outDir) {
    fs.mkdirSync(r.outDir, { recursive: true });
    r.reportPath = path.join(r.outDir, 'report.md');
    fs.writeFileSync(r.reportPath, renderDetonateReport(r));
    fs.writeFileSync(path.join(r.outDir, 'report.json'), JSON.stringify({ ...r, shots: r.shots.map(({ previewBase64, ...s }) => s) }, null, 2));
  }
  return r;
}

const icon = { high: '🔴', medium: '🟠', info: '⚪' };
const count = (r, level) => r.findings.filter((f) => f.level === level).length;
const plain = (s) => s.replace(/`/g, '');

export function headline(r) {
  if (r.error) return `ERROR  ${r.file}: ${r.error.split('\n')[0]}`;
  const h = count(r, 'high'), m = count(r, 'medium');
  const verdict = h ? `${h} red flag(s)` : m ? `${m} thing(s) worth a look` : 'nothing notable';
  return `${r.file}: ${verdict} (watched ${r.watchedSeconds?.toFixed(0) ?? '?'}s, network ${r.sandbox?.network ?? '?'})`;
}

export function detonateSummary(r) {
  const lines = [headline(r)];
  const row = (k, v) => lines.push(`  ${k.padEnd(10)} ${v}`);
  for (const [i, f] of r.findings.filter((x) => x.level !== 'info').entries()) row(i ? '' : 'findings', `${icon[f.level]} ${plain(f.text)}`);
  if (r.tree) row('processes', `${r.tree.length} (${r.tree.slice(0, 5).map((p) => exeName(p.path)).join(' → ')}${r.tree.length > 5 ? ' …' : ''})`);
  if (r.lookups) row('network', `${r.lookups.length} name lookup(s), ${r.connections.length} connection attempt(s)`);
  if (r.diff) {
    const d = r.diff;
    row('changed', `${d.files.addedCount} files added, ${d.files.changedCount} changed, ${d.registry.addedCount} registry keys, ` +
      `${d.values.length} autorun/env values, ${d.services.length} services`);
  }
  if (r.reportPath) row('report', r.reportPath);
  return lines.join('\n');
}

const fence = (s) => '```text\n' + (s || '').trimEnd().slice(-20_000) + '\n```';
const md = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');

/** Guest ISO times have 7-digit fractions; trim to 3 for Date.parse. */
const ms = (s) => Date.parse(String(s).replace(/(\.\d{3})\d+/, '$1'));
/** Seconds since `since`, e.g. "+3.2s". */
const at = (since, t) => {
  const d = (ms(t) - ms(since)) / 1000;
  return Number.isFinite(d) ? `${d < 0 ? '' : '+'}${d.toFixed(1)}s` : '';
};

export function renderDetonateReport(r) {
  const rel = (p) => path.relative(r.outDir, p).split(path.sep).join('/');
  const lines = [`# sbx detonate: ${r.file}`, '', `**${headline(r)}**`, '', '| | |', '|---|---|',
    `| File | \`${r.hostPath}\`${r.args ? ` \`${r.args}\`` : ''} |`,
    `| SHA-256 | \`${r.sha256}\` |`,
    `| Sandbox | fresh Windows Sandbox, network ${r.sandbox?.network ?? '?'}, booted in ${r.sandbox?.bootSeconds?.toFixed(1) ?? '?'}s |`,
    `| Ran | ${r.command ? `\`${md(r.command)}\`` : 'not run'} |`,
    `| Watched | ${r.watchedSeconds?.toFixed(0) ?? '?'}s${r.stoppedEarly ? ' (stopped early: everything it started had exited)' : ''}` +
      `${r.exitCode !== undefined && r.exitCode !== null ? `, exit code ${r.exitCode}` : ''}${r.stillRunning?.length ? `, ${r.stillRunning.length} process(es) still running at the end` : ''} |`,
    `| Total time | ${r.seconds.toFixed(1)}s |`, ''];
  if (r.findings.length) {
    lines.push('## Findings', '');
    for (const f of r.findings) lines.push(`- ${icon[f.level]} ${f.text}`);
    lines.push('', '_Heuristics, not a verdict: installers legitimately add autoruns and services. Read the details below._', '');
  }
  if (r.tree) {
    const events = [
      ...r.tree.map((p) => ({ time: p.time, text: `start    ${exeName(p.path)} (pid ${p.pid})  ${p.commandLine || p.path}` })),
      ...(r.lookups || []).map((l) => ({ time: l.time, text: `lookup   ${l.name} (${l.ok ? 'resolved' : 'failed'})` })),
      ...(r.connections || []).map((c) => ({ time: c.time, text: `connect  ${c.address}:${c.port}/${c.protocol} ${c.blocked ? 'blocked' : 'allowed'} (${exeName(c.path)})` })),
    ].sort((a, b) => String(a.time).localeCompare(String(b.time)));
    lines.push('## Timeline', '', fence(events.slice(0, 200).map((e) => `${at(r.launchedAt || r.since, e.time).padStart(7)}  ${e.text}`).join('\n')), '');
    lines.push('## Processes it started', '', '```text');
    for (const p of r.tree) lines.push(`${'  '.repeat(p.depth)}${exeName(p.path)} (pid ${p.pid})${r.stillRunning?.includes(p.pid) ? ' [still running]' : ''}  ${p.commandLine || p.path}`);
    lines.push('```', '');
  }
  if (r.lookups?.length || r.connections?.length) {
    lines.push('## Network', '');
    if (r.lookups.length) {
      lines.push('| Name looked up | Result | By |', '|---|---|---|');
      for (const l of r.lookups) lines.push(`| \`${md(l.name)}\` | ${l.ok ? 'resolved' : 'failed'} | pid ${l.pid} |`);
      lines.push('');
    }
    if (r.connections.length) {
      lines.push('| Connection | Result | By |', '|---|---|---|');
      for (const c of r.connections) lines.push(`| ${c.address}:${c.port}/${c.protocol}${c.count > 1 ? ` ×${c.count}` : ''} | ${c.blocked ? 'blocked' : 'allowed'} | \`${md(c.path)}\` (pid ${c.pid}) |`);
      lines.push('');
    }
  }
  if (r.sandbox?.network === 'off') {
    lines.push('_Network was off (no adapter): name lookups are still recorded, but connections to IP addresses never leave the process. ' +
      'Use `--network firewall` to also see the addresses it tries to reach (blocked by the guest firewall)._', '');
  }
  if (r.diff) lines.push('## What it changed', '', sbx.formatDiff(r.diff, { title: 'before → after' }), '');
  if (r.diff?.files.executables.length) {
    lines.push('**Runnable files written**', '');
    for (const p of r.diff.files.executables) lines.push(`- \`${p}\``);
    if (r.diff.files.executableCount > r.diff.files.executables.length) lines.push(`- … and ${r.diff.files.executableCount - r.diff.files.executables.length} more`);
    lines.push('');
  }
  if (r.windows.length) {
    lines.push('## Windows it opened', '');
    for (const w of r.windows) lines.push(`- ${w.process} (pid ${w.pid}): "${w.title}"`);
    lines.push('');
  }
  if (r.crashes.length) {
    lines.push('## Application errors', '');
    for (const e of r.crashes.slice(0, 10)) lines.push(`- ${e.source} ${e.id}: ${md(String(e.message).slice(0, 300))}`);
    lines.push('');
  }
  if (r.others?.length || r.otherLookups?.length) {
    lines.push('## Everything else that happened', '', 'Usually Windows itself, but a file can also act through services, WMI or scheduled tasks.', '');
    if (r.others.length) {
      lines.push('```text');
      for (const p of r.others.slice(0, 40)) lines.push(`${at(r.launchedAt || r.since, p.time).padStart(7)}  ${exeName(p.path)} (pid ${p.pid}, parent ${exeName(p.parentPath)})  ${p.commandLine || p.path}`);
      if (r.others.length > 40) lines.push(`… and ${r.others.length - 40} more`);
      lines.push('```', '');
    }
    if (r.otherLookups?.length) lines.push(`Other name lookups: ${r.otherLookups.slice(0, 30).map((n) => `\`${n}\``).join(', ')}`, '');
    if (r.otherConnections?.length) lines.push(`Other connections: ${r.otherConnections.slice(0, 20).map((c) => `${c.address}:${c.port} (${exeName(c.path)})`).join(', ')}`, '');
  }
  if (r.shots.length) {
    lines.push('## Screenshots', '');
    for (const s of r.shots) lines.push(`**${s.name}**`, '', `![${s.name}](${rel(s.path)})`, '');
  }
  if (r.error) lines.push('## Error', '', fence(r.errorStack || r.error), '');
  lines.push('---', 'Files in this folder were written by the sandbox: treat them as untrusted. ' +
    `Audit log: \`${path.join(r.runDir || '', 'audit.jsonl')}\`${r.kept ? ' · sandbox left running (--keep)' : ''}`);
  return lines.join('\n') + '\n';
}
