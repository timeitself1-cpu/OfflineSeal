// Static audit of the first-party sealed code. Browser policy is the
// enforcement. This checks that the code also doesn't *try* to use channels
// the policy is meant to block, and that each part stays in its lane:
//   - frame UI (converter-ui.js): UI and Worker management only; never touches bytes or pixels
//   - Worker (image-worker.js): all image processing; no network, no code loading
//   - seal check (seal-check.js): the single data: URL self-check

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { MESSAGE_TYPES, SEAL_FAILURE_CODES, PROCESSING_FAILURE_CODES } from '../../src/shell/assets/protocol.js';

const src = (p) => readFileSync(new URL(`../../src/${p}`, import.meta.url), 'utf8');
const stripComments = (code) => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const ui = stripComments(src('sealed/converter-ui.js'));
const worker = stripComments(src('sealed/image-worker.js'));
const sealCheck = stripComments(src('sealed/seal-check.js'));
const core = stripComments(src('sealed/converter-core.js'));
const workerProtocol = stripComments(src('sealed/worker-protocol.js'));
const allSealed = [ui, worker, sealCheck, core, workerProtocol].join('\n');
const shell = stripComments(src('shell/assets/app.js'));

const NETWORK_APIS = [
  'XMLHttpRequest',
  'WebSocket',
  'EventSource',
  'sendBeacon',
  'WebTransport',
  'importScripts',
  'window.open',
  'location.href',
  'location.assign',
  'location.replace',
  '.submit(',
  'RTCPeerConnection(',
  'navigator.serviceWorker',
  'SharedWorker',
  'document.cookie',
  'localStorage',
  'sessionStorage',
  'BroadcastChannel',
];

test('no sealed code uses a network API; the only fetch is the data: seal check', () => {
  const fetches = [...allSealed.matchAll(/\bfetch\s*\(([^)]*)\)/g)].map((m) => m[1].trim());
  assert.deepEqual(fetches, ["'data:text/plain,offlineseal-seal-check'"]);
  assert.ok(sealCheck.includes("fetch('data:text/plain,offlineseal-seal-check')"), 'the one fetch lives in seal-check.js');
  for (const api of NETWORK_APIS) assert.ok(!allSealed.includes(api), `sealed code references ${api}`);
  // indexedDB appears only in the Worker's "storage must be unavailable" check.
  assert.deepEqual([...allSealed.matchAll(/indexedDB\.open\(/g)].length, 1);
});

test('no sealed code has dynamic code or HTML-string sinks', () => {
  for (const pattern of [/\beval\s*\(/, /\bnew\s+Function\b/, /\binnerHTML\b/, /\bouterHTML\b/, /insertAdjacentHTML/, /document\.write/, /setTimeout\(\s*['"`]/, /\bsrcdoc\b/, /createHTML/, /createScript\(/]) {
    assert.doesNotMatch(allSealed, pattern);
  }
});

test('the frame UI never decodes, resizes, encodes or reads file bytes', () => {
  for (const api of [
    'createImageBitmap',
    'OffscreenCanvas',
    'toBlob',
    'toDataURL',
    'convertToBlob',
    "getContext('2d')",
    'drawImage',
    'getImageData',
    'putImageData',
    'arrayBuffer',
    '.slice(0',
    '.text()',
    '.stream()',
    'FileReader',
    'ImageDecoder',
    'new Response',
    'sniffImageType',
  ]) {
    assert.ok(!ui.includes(api), `frame UI references ${api}`);
  }
  // The frame only *displays* bitmaps produced by a Worker.
  assert.deepEqual([...ui.matchAll(/getContext\('([a-z0-9]+)'\)/g)].map((m) => m[1]), ['bitmaprenderer']);
});

test('all image processing lives in the Worker', () => {
  for (const api of ['createImageBitmap(file', 'OffscreenCanvas', 'convertToBlob', 'sniffImageType', 'downscaleSteps']) {
    assert.ok(worker.includes(api), `Worker lacks ${api}`);
  }
  assert.ok(!worker.includes('document'.concat('.')), 'Worker code references document');
});

test('Workers are created in exactly one place, only from the pinned code, via Trusted Types', () => {
  const creations = [...allSealed.matchAll(/\bnew\s+Worker\s*\(/g)];
  assert.equal(creations.length, 1);
  assert.match(ui, /new Worker\(url, \{ name: `offlineseal-\$\{operation\}` \}\)/);
  assert.match(ui, /const url = workerUrlPolicy \? workerUrlPolicy\.createScriptURL\(WORKER_CODE_URL\) : WORKER_CODE_URL;/);
  assert.match(ui, /if \(url !== WORKER_CODE_URL\) throw new TypeError/);
  assert.match(ui, /const WORKER_CODE_URL = URL\.createObjectURL\(new Blob\(\[WORKER_SOURCE\]/);
  assert.equal([...ui.matchAll(/createPolicy\(/g)].length, 1, 'one Trusted Types policy');
  // Every Worker ends with terminate(), in one place.
  assert.equal([...ui.matchAll(/\.terminate\(\)/g)].length, 1);
  assert.match(ui, /function destroyWorker\(job\) \{[\s\S]*?job\.worker\.terminate\(\);/);
});

test('messages: the frame listens only to its own Workers; the Worker only to the frame', () => {
  assert.doesNotMatch(ui, /(window|document|self|globalThis)\.addEventListener\(\s*['"]message['"]/);
  assert.doesNotMatch(ui, /\bonmessage\b/);
  assert.equal([...ui.matchAll(/worker\.addEventListener\('message'/g)].length, 1);
  assert.equal([...worker.matchAll(/self\.addEventListener\('message'/g)].length, 1);
  assert.equal([...worker.matchAll(/\bpostMessage\(/g)].length, 1, 'the Worker posts only through reply()');

  // Frame -> shell: one call site, and only protocol types and codes.
  assert.equal([...ui.matchAll(/window\.parent\.postMessage\(/g)].length, 1);
  const types = [...ui.matchAll(/\bpost\('([a-z-]+)'/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(types)].sort(), Object.keys(MESSAGE_TYPES).sort(), 'the frame uses exactly the shell vocabulary');
  assert.equal([...ui.matchAll(/\bpost\(/g)].length - 1, types.length, 'every post() call names its type literally');
  // Every seal failure the frame can report is a code the shell accepts.
  for (const code of [...ui.matchAll(/return '([a-z-]+)';/g)].map((m) => m[1])) {
    assert.ok(SEAL_FAILURE_CODES.includes(code), `seal failure code ${code} unknown to the shell`);
  }
  // Worker failure codes that pass through to the shell are shell codes.
  const passthrough = /const SHELL_FAILURE_CODES = \[([^\]]+)\]/.exec(ui)[1].match(/'([a-z-]+)'/g).map((s) => s.slice(1, -1));
  for (const code of [...passthrough, 'worker-failed']) assert.ok(PROCESSING_FAILURE_CODES.includes(code), code);
});

test('WebRTC is removed before any other code runs, in the frame and in the Worker', () => {
  const firstStatement = (code) => code.split('\n').map((l) => l.trim()).filter(Boolean)[0];
  assert.equal(firstStatement(ui), 'SealCheck.removeWebRtc(window);');
  assert.equal(firstStatement(worker), 'SealCheck.removeWebRtc(self);');
});

test('shell never reads files, never posts to the frame, and fetches only the pinned payload', () => {
  for (const api of ['FileReader', '.arrayBuffer(', 'createObjectURL', 'dataTransfer.files', 'dataTransfer.items', 'getData(', 'type="file"', "'file'", 'postMessage(', 'XMLHttpRequest', 'sendBeacon', 'WebSocket', 'window.open', 'Worker(']) {
    assert.ok(!shell.includes(api), `shell references ${api}`);
  }
  const fetches = [...shell.matchAll(/\bfetch\s*\(/g)];
  assert.equal(fetches.length, 1, 'one fetch: the tool payload');
  assert.match(shell, /fetch\(new URL\(SEALED_TOOL\.path, import\.meta\.url\), \{\s*integrity: SEALED_TOOL\.integrity/);
});
