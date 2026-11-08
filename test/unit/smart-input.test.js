import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTypeMode } from '../../src/core.js';

test('mode text and keys map to literal false/true semantics', () => {
  assert.deepEqual(resolveTypeMode({ mode: 'text' }), { literal: true, deprecation: null });
  assert.deepEqual(resolveTypeMode({ mode: 'keys' }), { literal: false, deprecation: null });
});

test('an ambiguous typing request without mode or literal is rejected, not defaulted', () => {
  // Lesson 5: literal=true default silently typed "{ENTER}" as text. There is no default anymore.
  assert.throws(() => resolveTypeMode({}), /Pass mode: 'text'|Pass mode: "text"/);
  assert.throws(() => resolveTypeMode({ keys: '{ENTER}' }), /Pass mode/);
});

test('invalid modes are rejected with the offending value', () => {
  assert.throws(() => resolveTypeMode({ mode: 'sendkeys' }), /mode must be 'text' or 'keys'/);
  assert.throws(() => resolveTypeMode({ mode: 3 }), /mode must be 'text' or 'keys'/);
});

test('legacy literal still maps for one release, with a deprecation note', () => {
  assert.deepEqual(resolveTypeMode({ literal: true }), { literal: true, deprecation: 'literal is deprecated; pass mode: "text" or "keys"' });
  assert.deepEqual(resolveTypeMode({ literal: false }), { literal: false, deprecation: 'literal is deprecated; pass mode: "text" or "keys"' });
});

test('mode and literal must agree when both are given', () => {
  assert.throws(() => resolveTypeMode({ mode: 'text', literal: false }), /contradicts/);
  assert.throws(() => resolveTypeMode({ mode: 'keys', literal: true }), /contradicts/);
  assert.equal(resolveTypeMode({ mode: 'text', literal: true }).literal, true);
});
