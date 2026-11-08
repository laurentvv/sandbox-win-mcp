import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const PROTOCOL_VERSION = 2;
export const STALE_BOOT = 'The sandbox was restarted/replaced; start a new one.';
const MAX_AGE_MS = 300_000;

export function agentHash(dir) {
  const entries = fs.readdirSync(dir).filter((name) => !['token.txt', 'identity.json'].includes(name)).sort();
  return createHash('sha256').update(entries.map((name) =>
    `${name}\0${createHash('sha256').update(fs.readFileSync(path.join(dir, name))).digest('hex')}\n`).join('')).digest('hex');
}

export function createFramer(keyHex, epoch, { now = Date.now } = {}) {
  if (!/^[a-f0-9]{64}$/i.test(keyHex)) throw new Error('Invalid sandbox transport key');
  const key = Buffer.from(keyHex, 'hex');
  const derive = (direction, purpose) => Buffer.from(hkdfSync('sha256', key, Buffer.from(epoch), `sbx/v2/${direction}/${purpose}`, 32));
  const keys = Object.fromEntries(['request', 'response'].map((direction) => [direction, {
    encryption: derive(direction, 'encryption'), authentication: derive(direction, 'authentication'),
  }]));
  const received = Object.fromEntries(['request', 'response'].map((direction) => [direction, { seen: new Set(), highest: 0 }]));
  const canonical = (f) => [f.version, f.epoch, f.direction, f.counter, f.timestamp, f.iv, f.ciphertext].join('\n');
  return {
    seal(value, direction, counter) {
      if (!keys[direction] || !Number.isSafeInteger(counter) || counter <= 0) throw new Error('Invalid protocol direction/counter');
      const iv = randomBytes(16);
      const cipher = createCipheriv('aes-256-cbc', keys[direction].encryption, iv);
      const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]).toString('base64');
      const frame = { version: PROTOCOL_VERSION, epoch, direction, counter, timestamp: now(), iv: iv.toString('base64'), ciphertext };
      return { ...frame, mac: createHmac('sha256', keys[direction].authentication).update(canonical(frame)).digest('base64') };
    },
    open(frame, direction, expectedCounter) {
      if (frame.version !== PROTOCOL_VERSION) throw new Error(`Sandbox protocol mismatch: expected ${PROTOCOL_VERSION}, got ${frame.version}. Start a new sandbox with matching agent files.`);
      if (frame.epoch !== epoch) throw new Error(STALE_BOOT);
      if (!keys[direction] || frame.direction !== direction || !Number.isSafeInteger(frame.counter) || frame.counter <= 0 ||
          !Number.isSafeInteger(frame.timestamp) || typeof frame.iv !== 'string' || typeof frame.ciphertext !== 'string' || typeof frame.mac !== 'string') {
        throw new Error('Invalid authenticated sandbox frame');
      }
      const supplied = Buffer.from(frame.mac, 'base64');
      const mac = createHmac('sha256', keys[direction].authentication).update(canonical(frame)).digest();
      if (supplied.length !== mac.length || !timingSafeEqual(mac, supplied)) throw new Error('Sandbox frame authentication failed');
      if (Math.abs(now() - frame.timestamp) > MAX_AGE_MS) throw new Error('Sandbox frame timestamp expired');
      const state = received[direction];
      if ((expectedCounter !== undefined && frame.counter !== expectedCounter) || state.seen.has(frame.counter) || frame.counter <= state.highest - 4096) {
        throw new Error('Sandbox frame replay/counter mismatch');
      }
      const iv = Buffer.from(frame.iv, 'base64');
      if (iv.length !== 16) throw new Error('Invalid sandbox frame IV');
      const decipher = createDecipheriv('aes-256-cbc', keys[direction].encryption, iv);
      const result = JSON.parse(Buffer.concat([decipher.update(Buffer.from(frame.ciphertext, 'base64')), decipher.final()]).toString('utf8'));
      state.seen.add(frame.counter);
      state.highest = Math.max(state.highest, frame.counter);
      for (const n of state.seen) if (n <= state.highest - 4096) state.seen.delete(n);
      return result;
    },
  };
}
