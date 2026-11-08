// Adversarial transport probes against an already-running, caller-owned Sandbox.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { HOME, sleep } from '../src/core.js';
import { createFramer } from '../src/protocol.js';
import { withStateLock, atomicJson, readJson, retryFile } from '../src/coordination.js';

export async function protocolProof(target) {
  const key = fs.readFileSync(path.join(target.runDir, 'agent', 'token.txt'), 'utf8').trim();
  const stateFile = path.join(HOME, 'current.json');
  assert.equal(fs.readFileSync(stateFile, 'utf8').includes(key), false, 'key must stay out of current.json');
  const reserve = () => withStateLock(HOME, () => {
    const state = readJson(stateFile);
    const counter = ++state.protocolSeq;
    atomicJson(stateFile, state);
    return counter;
  });
  const send = async (frame) => {
    assert.equal(JSON.stringify(frame).includes(key), false, 'key must stay off wire');
    if (target.transport !== 'files') {
      return new Promise((resolve, reject) => {
        let text = '';
        const socket = net.createConnection({ host: target.ip, port: target.port });
        socket.setEncoding('utf8');
        socket.setTimeout(15_000, () => socket.destroy(new Error('protocol proof socket timed out')));
        socket.on('connect', () => socket.write(JSON.stringify(frame) + '\n'));
        socket.on('data', (data) => text += data);
        socket.on('error', reject);
        socket.on('end', () => { try { resolve(JSON.parse(text)); } catch (e) { reject(e); } });
      });
    }
    const files = withStateLock(HOME, () => {
      const state = readJson(stateFile);
      const n = String(++state.mailboxSeq).padStart(6, '0');
      atomicJson(stateFile, state);
      const req = path.join(target.runDir, 'in', 'mailbox', `req-${n}.json`);
      const resp = path.join(target.runDir, 'out', 'mailbox', `resp-${n}.json`);
      atomicJson(req, frame);
      retryFile(() => fs.writeFileSync(path.join(path.dirname(req), 'seq.txt'), String(Number(n))));
      return { req, resp };
    });
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (fs.existsSync(files.resp)) {
        const response = readJson(files.resp);
        fs.rmSync(files.req); fs.rmSync(files.resp);
        return response;
      }
      await sleep(50);
    }
    throw new Error('protocol proof mailbox timed out');
  };
  const decode = (response, counter) => createFramer(key, target.epoch).open(response, 'response', counter);
  const normal = createFramer(key, target.epoch).seal({ op: 'ping' }, 'request', reserve());
  const first = decode(await send(normal), normal.counter);
  assert.equal(first.ok, true);
  assert.equal(first.result.epoch, target.epoch);
  assert.deepEqual({
    protocolVersion: first.result.protocolVersion, agentVersion: first.result.agentVersion, agentSha256: first.result.agentSha256,
  }, target.identity);
  const replay = decode(await send(normal), normal.counter);
  assert.equal(replay.ok, false);
  assert.match(replay.error, /replay/);
  const altered = createFramer(key, target.epoch).seal({ op: 'exec', command: "'must-not-execute'" }, 'request', reserve());
  altered.mac = Buffer.alloc(32).toString('base64');
  const rejected = decode(await send(altered), altered.counter);
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /authentication failed/);
  const stale = createFramer(key, 'old-boot').seal({ op: 'ping' }, 'request', reserve());
  const staleResponse = await send(stale);
  assert.match(decode(staleResponse, stale.counter).error, /restarted\/replaced/);
  assert.throws(() => createFramer(key, 'old-boot').open(staleResponse, 'response', stale.counter), /restarted\/replaced/);
  const mismatch = createFramer(key, target.epoch).seal({ op: 'ping' }, 'request', reserve());
  mismatch.version++;
  assert.match(decode(await send(mismatch), mismatch.counter).error, /protocol mismatch/);
  console.log(`${target.network}: authenticated ping, identity, tamper, replay, stale epoch, protocol mismatch passed`);
}
