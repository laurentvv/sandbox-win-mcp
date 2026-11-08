import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; }
};

export function retryFile(fn) {
  for (let i = 0; ; i++) {
    try { return fn(); } catch (e) {
      if (i === 39 || !['EBUSY', 'EPERM', 'EACCES'].includes(e.code)) throw e;
      pause(25);
    }
  }
}

export function atomicJson(file, value) {
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
    retryFile(() => fs.renameSync(tmp, file));
  } finally { fs.rmSync(tmp, { force: true }); }
}

export function readJson(file) {
  try { return JSON.parse(retryFile(() => fs.readFileSync(file, 'utf8'))); } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

// Only synchronous, local read/modify/write work belongs inside this lock.
export function withStateLock(home, fn, { timeoutMs = 10_000, staleMs = 30_000 } = {}) {
  fs.mkdirSync(home, { recursive: true });
  const file = path.join(home, 'state.lock');
  const deadline = Date.now() + timeoutMs;
  const inspect = (name) => {
    try {
      const raw = retryFile(() => fs.readFileSync(name, 'utf8'));
      const stat = fs.statSync(name);
      let owner;
      try { owner = JSON.parse(raw); } catch (e) { if (!(e instanceof SyntaxError)) throw e; }
      const validPid = Number.isSafeInteger(owner?.pid) && owner.pid > 0;
      return { raw, stat, stale: validPid ? !alive(owner.pid) : Date.now() - stat.mtimeMs > staleMs };
    } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  };
  const removeObserved = (name, observed) => {
    const now = inspect(name);
    if (now?.stale && now.raw === observed.raw && now.stat.ino === observed.stat.ino &&
        now.stat.birthtimeMs === observed.stat.birthtimeMs && now.stat.mtimeMs === observed.stat.mtimeMs) {
      retryFile(() => fs.rmSync(name, { force: true }));
    }
  };
  let fd;
  while (fd === undefined) {
    try {
      fd = fs.openSync(file, 'wx');
    } catch (e) {
      if (['EBUSY', 'EPERM', 'EACCES'].includes(e.code)) {
        if (Date.now() >= deadline) throw new Error('Timed out waiting for sandbox state lock');
        pause(10);
        continue;
      }
      if (e.code !== 'EEXIST') throw e;
      const observed = inspect(file);
      if (observed?.stale) {
        // Serialize stale recovery too: two reclaimers must not unlink a successor's lock.
        const recovery = `${file}.recovery`;
        let recoveryFd;
        try {
          recoveryFd = fs.openSync(recovery, 'wx');
          fs.writeFileSync(recoveryFd, JSON.stringify({ pid: process.pid }));
          removeObserved(file, observed);
        } catch (err) {
          if (err.code === 'EEXIST') {
            const abandoned = inspect(recovery);
            if (abandoned?.stale) removeObserved(recovery, abandoned);
          }
          if (!['EEXIST', 'ENOENT'].includes(err.code)) throw err;
        } finally {
          if (recoveryFd !== undefined) { fs.closeSync(recoveryFd); retryFile(() => fs.rmSync(recovery)); }
        }
      }
      if (Date.now() >= deadline) throw new Error('Timed out waiting for sandbox state lock');
      pause(10);
    }
  }
  try {
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid }));
    return fn();
  } finally { fs.closeSync(fd); retryFile(() => fs.rmSync(file)); }
}

export function createDesktop(home, { owner = `cli:${process.pid}`, persistent = false, graceMs = 4000, timeoutMs = 60_000 } = {}) {
  const file = path.join(home, 'desktop.json');
  const edit = (fn) => withStateLock(home, () => {
    const state = readJson(file) || { queue: [], lease: null };
    state.queue = state.queue.filter((q) => alive(q.pid));
    if (state.lease && (state.lease.active ? !alive(state.lease.pid) : state.lease.until <= Date.now())) state.lease = null;
    const result = fn(state);
    atomicJson(file, state);
    return result;
  });
  return {
    owner,
    release() {
      return edit((s) => {
        if (s.lease?.owner === owner && !s.lease.active) s.lease = null;
        return { released: !s.lease || s.lease.owner !== owner };
      });
    },
    async run(fn) {
      const ticket = randomUUID();
      edit((s) => s.queue.push({ ticket, pid: process.pid, owner }));
      const deadline = Date.now() + timeoutMs;
      let held = false;
      try {
        while (!held) {
          let holder;
          held = edit((s) => {
            holder = s.lease?.owner;
            if (s.lease?.active) return false;
            // An existing owner can finish its turn during the idle grace.
            if (s.lease && s.lease.owner !== owner) return false;
            if (!s.lease && s.queue[0]?.ticket !== ticket) return false;
            s.queue = s.queue.filter((q) => q.ticket !== ticket);
            s.lease = { owner, pid: process.pid, active: ticket };
            return true;
          });
          if (!held) {
            if (Date.now() >= deadline) throw new Error(`desktop busy: held by ${holder || 'another queued workflow'}`);
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
        }
        return await fn();
      } finally {
        edit((s) => {
          s.queue = s.queue.filter((q) => q.ticket !== ticket);
          if (held && s.lease?.active === ticket) s.lease = persistent
            ? { owner, pid: process.pid, active: null, until: Date.now() + graceMs } : null;
        });
      }
    },
  };
}
