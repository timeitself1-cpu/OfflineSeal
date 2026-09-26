// Static audit of the first-party sealed tool code. Browser policy is the
// enforcement. This checks that the tool also doesn't *try* to use channels
// the policy is meant to block, so a policy regression can't be masked by a
// tool that quietly depends on it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { MESSAGE_TYPES, SEAL_FAILURE_CODES, PROCESSING_FAILURE_CODES } from '../../src/shell/assets/protocol.js';

const src = (p) => readFileSync(new URL(`../../src/${p}`, import.meta.url), 'utf8');
const stripComments = (code) => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const sealed = stripComments(src('sealed/converter-core.js') + '\n' + src('sealed/converter-ui.js'));
const shell = stripComments(src('shell/assets/app.js'));

test('sealed code uses no network API (except the data: seal self-check)', () => {
  const fetches = [...sealed.matchAll(/\bfetch\s*\(([^)]*)\)/g)].map((m) => m[1].trim());
  assert.deepEqual(fetches, ["'data:text/plain,offlineseal-seal-check'"]);
  for (const api of [
    'XMLHttpRequest',
    'WebSocket',
    'EventSource',
    'sendBeacon',
    'WebTransport',
    'importScripts',
    'Worker(',
    'window.open',
    'location.href',
    'location.assign',
    'location.replace',
    '.submit(',
    'RTCPeerConnection(',
    'navigator.serviceWorker',
    'document.cookie',
    'localStorage',
    'sessionStorage',
    'indexedDB',
  ]) {
    assert.ok(!sealed.includes(api), `sealed code references ${api}`);
  }
});

test('sealed code has no dynamic code or HTML-string sinks', () => {
  for (const pattern of [/\beval\s*\(/, /\bnew\s+Function\b/, /\binnerHTML\b/, /\bouterHTML\b/, /insertAdjacentHTML/, /document\.write/, /setTimeout\(\s*['"`]/, /\bsrcdoc\b/]) {
    assert.doesNotMatch(sealed, pattern);
  }
});

test('sealed code never listens for messages and only posts protocol messages', () => {
  assert.doesNotMatch(sealed, /addEventListener\(\s*['"]message['"]/);
  assert.doesNotMatch(sealed, /\bonmessage\b/);
  const posts = [...sealed.matchAll(/\bpostMessage\(/g)];
  assert.equal(posts.length, 1, 'exactly one postMessage call site (inside post())');
  const calls = [...sealed.matchAll(/\bpost\('([a-z-]+)'(?:,\s*('([a-z-]+)'|[a-z]+))?\)/g)];
  assert.ok(calls.length >= 6);
  for (const [, type, , literalCode] of calls) {
    assert.ok(type in MESSAGE_TYPES, `unknown message type ${type}`);
    if (literalCode) assert.ok([...SEAL_FAILURE_CODES, ...PROCESSING_FAILURE_CODES].includes(literalCode), literalCode);
  }
  // Every code the frame can send must be a code the shell accepts.
  for (const code of [...sealed.matchAll(/failure = '([a-z-]+)'/g)].map((m) => m[1])) {
    assert.ok(PROCESSING_FAILURE_CODES.includes(code), code);
  }
});

test('WebRTC is removed before any other sealed code runs', () => {
  const ui = src('sealed/converter-ui.js');
  const firstStatement = stripComments(ui).trim().split('\n')[0];
  assert.match(firstStatement, /^for \(const name of Object\.getOwnPropertyNames\(window\)\)/);
});

test('shell never reads files, never posts to the frame, and fetches only the pinned payload', () => {
  for (const api of ['FileReader', '.arrayBuffer(', 'createObjectURL', 'dataTransfer.files', 'dataTransfer.items', 'getData(', 'type="file"', "'file'", 'postMessage(', 'XMLHttpRequest', 'sendBeacon', 'WebSocket', 'window.open']) {
    assert.ok(!shell.includes(api), `shell references ${api}`);
  }
  const fetches = [...shell.matchAll(/\bfetch\s*\(/g)];
  assert.equal(fetches.length, 1, 'one fetch: the tool payload');
  assert.match(shell, /fetch\(new URL\(SEALED_TOOL\.path, import\.meta\.url\), \{\s*integrity: SEALED_TOOL\.integrity/);
});
