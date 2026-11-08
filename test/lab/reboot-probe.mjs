// Guest-reboot exploration (batch D): does an IN-GUEST reboot keep the sandbox alive, its state,
// its shares and our agent re-injectable? MS docs say data persists through in-guest restarts
// since 22H2 - if true, reboot-requiring installers become testable.
// Raw probe: logs a timeline, saves JSON, tears the sandbox down at the end.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import * as sbx from '../../src/core.js';

const wsb = (args, timeoutMs = 60_000) => new Promise((resolve) => {
  execFile('wsb.exe', [...args, '--raw'], { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
    let json = null;
    try { json = JSON.parse(stdout); } catch {}
    resolve({ ok: !err, json, err: err?.message, text: `${stdout}${stderr}`.slice(0, 300) });
  });
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const timeline = [];
const T = (phase, fact) => { timeline.push({ t: Date.now(), phase, fact }); console.log(`[${phase}] ${fact}`); };
const report = { startedAt: new Date().toISOString(), timeline };

try {
  const boot = await sbx.startSandbox({ network: 'on', idleMinutes: 120 });
  report.boot = { id: boot.id, bootSeconds: boot.bootSeconds, ip: boot.ip, runDir: boot.runDir };
  T('boot', `id=${boot.id.slice(0, 8)} ip=${boot.ip} ${boot.bootSeconds.toFixed(1)}s`);

  await sbx.exec({ command: 'Set-Content C:\\sbx-marker.txt "before-reboot"' });
  const marker = await sbx.exec({ command: 'Get-Content C:\\sbx-marker.txt' });
  T('marker', `written: ${JSON.stringify(marker.stdout.trim())}`);

  // Reboot INSIDE the guest through the platform channel (our agent dies with the session).
  const r = await wsb(['exec', '--id', boot.id, '-r', 'System', '-c', 'shutdown /r /t 3']);
  T('reboot-cmd', `wsb exec shutdown: ok=${r.ok} ${r.text.slice(0, 80)}`);

  // Watch the platform: does the id stay listed, does the IP change, how long is the gap?
  let sawGone = false, ip = boot.ip, backAt = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 300_000) {
    const list = await wsb(['list']);
    const ids = list.json?.WindowsSandboxEnvironments?.map((e) => e.Id) ?? [];
    const present = ids.includes(boot.id);
    if (!present) sawGone = true;
    const ipr = await wsb(['ip', '--id', boot.id]);
    const newIp = ipr.json?.Networks?.find((n) => n.IpV4Address)?.IpV4Address ?? null;
    if (newIp && newIp !== ip) { T('ip-change', `${ip} -> ${newIp}`); ip = newIp; }
    T('poll', `${((Date.now() - t0) / 1000).toFixed(0)}s listed=${present} sawGone=${sawGone} ip=${newIp ?? '?'}`);
    if (present && sawGone) { backAt = Date.now() - t0; break; }  // vanished then returned = rebooted
    if (present && Date.now() - t0 > 90_000) { backAt = Date.now() - t0; break; } // never vanished: still counts as back
    await sleep(5000);
  }
  report.sawGone = sawGone; report.backAfterMs = backAt; report.ipAfter = ip;
  T('back', `id back after ${backAt ? (backAt / 1000).toFixed(0) + 's' : 'TIMEOUT'} (sawGone=${sawGone}) ip=${ip}`);

  // Session: does an interactive logon exist again?
  const login = await wsb(['exec', '--id', boot.id, '-r', 'ExistingLogin', '-c', 'cmd /c exit 0'], 30_000);
  T('user-session', `ExistingLogin exec ok=${login.ok} exit=${login.json?.ExitCode}`);

  // State persistence: is the marker still there?
  const marker2 = await wsb(['exec', '--id', boot.id, '-r', 'System', '-c', 'cmd /c type C:\\sbx-marker.txt']);
  T('persistence', `marker after reboot: ${JSON.stringify((marker2.json?.Stdout ?? '').trim())}`);

  // Shares: are C:\sbx\agent / in / out still mapped?
  const shares = await wsb(['exec', '--id', boot.id, '-r', 'System', '-c', 'cmd /c dir /b C:\\sbx\\agent']);
  T('shares', `agent dir: ${JSON.stringify((shares.json?.Stdout ?? '').split(/\r?\n/).filter(Boolean).slice(0, 6))}`);

  // Our agent: dead (session died). Re-inject it the same way boot does.
  if (login.ok) {
    const relaunch = await wsb(['exec', '--id', boot.id, '-r', 'ExistingLogin', '-c',
      'cmd /c start /min powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File C:\\sbx\\agent\\agent.ps1 -Port 5985 -IdleMinutes 120'], 30_000);
    T('agent-relaunch', `ok=${relaunch.ok} ${relaunch.text.slice(0, 60)}`);
    // If the IP changed, the host state must learn it before ping works.
    if (ip !== boot.ip) {
      const stateFile = path.join(sbx.HOME, 'current.json');
      const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      st.ip = ip;
      fs.writeFileSync(stateFile, JSON.stringify(st));
      T('state-patch', `host state ip -> ${ip}`);
    }
    // The agent's firewall rule should have persisted with the guest's system state; give it a moment.
    await sleep(4000);
    const status = await sbx.status().catch((e) => ({ error: String(e.message) }));
    T('agent-ping', `status: ${JSON.stringify(status).slice(0, 220)}`);
    if (status.agent === 'ok') {
      const mk = await sbx.exec({ command: 'Get-Content C:\\sbx-marker.txt' }).catch((e) => ({ stdout: `AGENT FAIL: ${e.message}` }));
      T('agent-marker', `through reconnected agent: ${JSON.stringify(String(mk.stdout).trim())}`);
    }
  }
} catch (e) {
  report.fatal = String(e.message);
  console.error(`PROBE FATAL: ${e.message}`);
} finally {
  try { report.stop = await sbx.stopSandbox({ force: true }); } catch (e) { report.stop = { error: String(e.message) }; }
  report.timeline = timeline;
  fs.writeFileSync(path.join(process.cwd(), 'reboot-probe.json'), JSON.stringify(report, null, 2));
  console.log('report: reboot-probe.json');
}
