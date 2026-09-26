import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PROTOCOL_ID,
  MESSAGE_TYPES,
  TRANSITIONS,
  validateFrameMessage,
  nextState,
} from '../../src/shell/assets/protocol.js';

const frameWindow = { name: 'sealed-frame-window' };
const expected = { source: frameWindow, instance: 'abc123' };
const msg = (data, overrides = {}) => ({ source: frameWindow, origin: 'null', data, ...overrides });
const base = (type, extra = {}) => ({ protocol: PROTOCOL_ID, instance: 'abc123', type, ...extra });

test('vocabulary is exactly the six documented status messages', () => {
  assert.deepEqual(Object.keys(MESSAGE_TYPES).sort(), [
    'file-selected',
    'frame-ready',
    'processing-complete',
    'processing-failed',
    'processing-started',
    'seal-failed',
  ]);
});

test('accepts every well-formed message', () => {
  for (const type of ['frame-ready', 'file-selected', 'processing-started', 'processing-complete']) {
    assert.deepEqual(validateFrameMessage(msg(base(type)), expected), { ok: true, type, code: null });
  }
  assert.equal(validateFrameMessage(msg(base('seal-failed', { code: 'csp-not-enforced' })), expected).ok, true);
  assert.equal(validateFrameMessage(msg(base('processing-failed', { code: 'decode-failed' })), expected).ok, true);
});

test('rejects messages not from the active frame window', () => {
  assert.equal(validateFrameMessage(msg(base('frame-ready'), { source: {} }), expected).ok, false);
  assert.equal(validateFrameMessage(msg(base('frame-ready'), { source: null }), expected).ok, false);
  assert.equal(validateFrameMessage(msg(base('frame-ready')), null).ok, false);
});

test('rejects non-opaque sender origins', () => {
  for (const origin of ['https://offlineseal.app', 'http://127.0.0.1:8080', '', 'NULL']) {
    assert.equal(validateFrameMessage(msg(base('frame-ready'), { origin }), expected).ok, false, origin);
  }
});

test('rejects wrong protocol or frame instance', () => {
  assert.equal(validateFrameMessage(msg({ ...base('frame-ready'), protocol: 'other' }), expected).ok, false);
  assert.equal(validateFrameMessage(msg({ ...base('frame-ready'), instance: 'stale' }), expected).ok, false);
  assert.equal(validateFrameMessage(msg({ ...base('frame-ready'), instance: 42 }), expected).ok, false);
});

test('rejects unknown types, including network-sounding ones', () => {
  for (const type of ['fetch-url', 'open-url', 'send-request', 'proxy-request', 'run-script', 'eval', 'upload', '__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
    const v = validateFrameMessage(msg(base(type, { url: 'https://example.invalid/' })), expected);
    assert.equal(v.ok, false, type);
  }
});

test('rejects extra fields on valid types (no smuggled url/endpoint/payload)', () => {
  for (const key of ['url', 'endpoint', 'request', 'fetch', 'payload', 'data', 'bytes', 'name']) {
    const v = validateFrameMessage(msg(base('processing-complete', { [key]: 'x' })), expected);
    assert.deepEqual(v, { ok: false, reason: 'unexpected message fields' }, key);
  }
});

test('rejects missing or unknown codes, and codes on types without codes', () => {
  assert.equal(validateFrameMessage(msg(base('processing-failed')), expected).ok, false);
  assert.equal(validateFrameMessage(msg(base('processing-failed', { code: 'https://x' })), expected).ok, false);
  assert.equal(validateFrameMessage(msg(base('seal-failed', { code: 'decode-failed' })), expected).ok, false);
  assert.equal(validateFrameMessage(msg(base('frame-ready', { code: 'not-framed' })), expected).ok, false);
});

test('rejects non-plain-object payloads', () => {
  for (const data of [null, undefined, 'frame-ready', 42, ['frame-ready'], new Date(), new Map(), new Uint8Array(4), new ArrayBuffer(4)]) {
    assert.equal(validateFrameMessage(msg(data), expected).ok, false, String(data));
  }
  class Fake {}
  assert.equal(validateFrameMessage(msg(Object.assign(new Fake(), base('frame-ready'))), expected).ok, false);
});

test('rejection reasons are fixed strings, never echoing message content', () => {
  const v = validateFrameMessage(msg(base('fetch-url', { url: 'SECRET' })), expected);
  assert.equal(v.ok, false);
  assert.ok(!v.reason.includes('SECRET') && !v.reason.includes('fetch-url'));
});

test('state machine only allows documented transitions', () => {
  assert.equal(nextState('sealing', 'frame-ready'), 'ready');
  assert.equal(nextState('ready', 'file-selected'), 'file-selected');
  assert.equal(nextState('file-selected', 'processing-started'), 'processing');
  assert.equal(nextState('processing', 'processing-complete'), 'complete');
  assert.equal(nextState('complete', 'processing-started'), 'processing');
  // out of order
  assert.equal(nextState('sealing', 'file-selected'), null);
  assert.equal(nextState('ready', 'processing-complete'), null);
  assert.equal(nextState('ready', 'frame-ready'), null);
  assert.equal(nextState('fatal', 'frame-ready'), null);
  assert.equal(nextState('loading-tool', 'frame-ready'), null);
  assert.equal(nextState('__proto__', 'frame-ready'), null);
  assert.equal(nextState('ready', 'constructor'), null);
  // every transition target is a known state or fatal
  for (const edges of Object.values(TRANSITIONS)) {
    for (const target of Object.values(edges)) assert.ok(target === 'fatal' || target in TRANSITIONS, target);
  }
});
