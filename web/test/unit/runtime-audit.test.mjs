// Static audit of the trusted runtime and of every tool. Browser policy is the
// enforcement; this checks that the code also stays in its lane:
//   - the frame runtime is generic (nothing tool-specific) and never touches
//     file bytes or pixels;
//   - every tool is a manifest plus Worker-only code: no DOM, no network API,
//     no direct messaging, no HTML or CSS of its own;
//   - the runtime script is byte-identical in every tool's payload. So a tool
//     cannot have added a privileged hook to the frame.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { buildRuntime, buildTool, listToolDirs } from '../../build.mjs';
import { MESSAGE_TYPES, SEAL_FAILURE_CODES, PROCESSING_FAILURE_CODES } from '../../src/shell/assets/protocol.js';

const src = (p) => readFile(new URL(`../../src/${p}`, import.meta.url), 'utf8');
const stripComments = (code) => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const frame = stripComments(await src('runtime/frame.js'));
const host = stripComments(await src('runtime/worker-host.js'));
const sealCheck = stripComments(await src('runtime/seal-check.js'));
const schema = stripComments(await src('runtime/tool-schema.js'));
const protocol = stripComments(await src('runtime/worker-protocol.js'));
const runtimeAll = [frame, host, sealCheck, schema, protocol].join('\n');
const shell = stripComments(await src('shell/assets/app.js'));
const toolDirs = await listToolDirs();
const toolCode = await Promise.all(
  toolDirs.map(async (dir) => {
    const files = (await readdir(dir)).filter((f) => f.endsWith('.js'));
    return { id: basename(dir), dir, files: await readdir(dir), code: stripComments((await Promise.all(files.map((f) => readFile(join(dir, f), 'utf8')))).join('\n')) };
  }),
);

const NETWORK_APIS = [
  'XMLHttpRequest', 'WebSocket', 'EventSource', 'sendBeacon', 'WebTransport', 'importScripts', 'window.open', 'location.href',
  'location.assign', 'location.replace', '.submit(', 'RTCPeerConnection(', 'navigator.serviceWorker', 'SharedWorker',
  'document.cookie', 'localStorage', 'sessionStorage', 'BroadcastChannel', 'import(',
];

test('the frame runtime contains nothing tool-specific', () => {
  for (const word of [/pdf/i, /jpe?g/i, /\bpng\b/i, /webp/i, /image\//i, /convert/i, /ImageCore|PdfCore/]) {
    assert.doesNotMatch(frame, word, `frame runtime mentions ${word}`);
  }
  for (const t of toolCode) assert.ok(!frame.includes(t.id), `frame runtime mentions tool ${t.id}`);
});

test('the runtime script is byte-identical in every tool payload, and pinned by the CSP', async () => {
  const runtime = await buildRuntime();
  const scripts = [];
  for (const dir of toolDirs) {
    const { payload, manifest } = await buildTool(dir, runtime);
    const executable = [...payload.matchAll(/<script(\b[^>]*)>([\s\S]*?)<\/script>/g)].filter(([, attrs]) => !/type=/.test(attrs));
    assert.equal(executable.length, 1, `${manifest.id}: one executable script`);
    scripts.push(executable[0][2]);
    const blocks = [...payload.matchAll(/<script type="([^"]+)" id="([^"]+)">/g)].map((m) => `${m[1]}#${m[2]}`);
    assert.deepEqual(blocks, ['application/json#offlineseal-manifest', 'text/plain#offlineseal-worker'], `${manifest.id}: only the two inert data blocks`);
  }
  assert.ok(scripts.length >= 2);
  assert.equal(new Set(scripts).size, 1, 'every tool ships the same runtime bytes');
  assert.equal(createHash('sha256').update(scripts[0], 'utf8').digest('base64'), runtime.hashes.scriptHash);
});

test('a tool is a manifest plus Worker-only JavaScript: no HTML, CSS or other files', () => {
  for (const t of toolCode) {
    assert.ok(t.files.includes('manifest.json') && t.files.includes('tool.js'), t.id);
    for (const f of t.files) assert.match(f, /^(manifest\.json|[a-z0-9-]+\.js)$/, `${t.id}: unexpected file ${f}`);
  }
});

test('tool code is Worker-only: no DOM, no network API, no messaging of its own, no dynamic code', () => {
  for (const t of toolCode) {
    for (const api of [...NETWORK_APIS, 'document.', 'window.', 'postMessage(', 'addEventListener(', 'new Worker', 'fetch(', 'Function(', 'eval(', 'setTimeout(\'', 'innerHTML']) {
      assert.ok(!t.code.includes(api), `${t.id} references ${api}`);
    }
    assert.match(t.code, /OfflineSealTool\.define\(/, `${t.id} registers through the Worker host`);
  }
});

test('the runtime uses no network API; its only fetch is the data: seal check', () => {
  const fetches = [...runtimeAll.matchAll(/\bfetch\s*\(([^)]*)\)/g)].map((m) => m[1].trim());
  assert.deepEqual(fetches, ["'data:text/plain,offlineseal-seal-check'"]);
  for (const api of NETWORK_APIS) assert.ok(!runtimeAll.includes(api), `runtime references ${api}`);
});

test('no runtime code has dynamic code or HTML-string sinks', () => {
  for (const pattern of [/\beval\s*\(/, /\bnew\s+Function\b/, /\binnerHTML\b/, /\bouterHTML\b/, /insertAdjacentHTML/, /document\.write/, /setTimeout\(\s*['"`]/, /\bsrcdoc\b/, /createHTML/, /createScript\(/]) {
    assert.doesNotMatch(runtimeAll, pattern);
  }
});

test('the frame runtime never decodes, renders, encodes or reads file bytes', () => {
  for (const api of ['createImageBitmap', 'OffscreenCanvas', 'toBlob', 'toDataURL', 'convertToBlob', "getContext('2d')", 'drawImage', 'getImageData', 'putImageData', 'arrayBuffer', '.slice(0', '.text()', '.stream()', 'FileReader', 'ImageDecoder', 'new Response']) {
    assert.ok(!frame.includes(api), `frame runtime references ${api}`);
  }
  assert.deepEqual([...frame.matchAll(/getContext\('([a-z0-9]+)'\)/g)].map((m) => m[1]), ['bitmaprenderer']);
});

test('Workers are created in one place, only from the payload\'s Worker code, via Trusted Types', () => {
  assert.equal([...runtimeAll.matchAll(/\bnew\s+Worker\s*\(/g)].length, 1);
  assert.match(frame, /new Worker\(url, \{ name: `offlineseal-\$\{operation\}` \}\)/);
  assert.match(frame, /const url = workerUrlPolicy \? workerUrlPolicy\.createScriptURL\(WORKER_CODE_URL\) : WORKER_CODE_URL;/);
  assert.match(frame, /if \(WORKER_CODE_URL === null \|\| url !== WORKER_CODE_URL\) \{\s*throw new TypeError/);
  assert.equal([...frame.matchAll(/createPolicy\(/g)].length, 1, 'one Trusted Types policy');
  assert.equal([...frame.matchAll(/\.terminate\(\)/g)].length, 1);
  assert.match(frame, /function destroyWorker\(job\) \{[\s\S]*?job\.worker\.terminate\(\);/);
});

test('messages: the frame listens only to its own Workers; the host only to the frame', () => {
  assert.doesNotMatch(frame, /(window|document|self|globalThis)\.addEventListener\(\s*['"]message['"]/);
  assert.doesNotMatch(frame, /\bonmessage\b/);
  assert.equal([...frame.matchAll(/worker\.addEventListener\('message'/g)].length, 1);
  assert.equal([...host.matchAll(/self\.addEventListener\('message'/g)].length, 1);
  assert.equal([...host.matchAll(/\bpostMessage\(/g)].length, 1, 'the host posts only through reply()');
  assert.equal([...frame.matchAll(/window\.parent\.postMessage\(/g)].length, 1);
  const types = [...frame.matchAll(/\bpost\('([a-z-]+)'/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(types)].sort(), Object.keys(MESSAGE_TYPES).sort(), 'the frame uses exactly the shell vocabulary');
  for (const code of [...frame.matchAll(/return '([a-z-]+)';/g)].map((m) => m[1])) {
    assert.ok(SEAL_FAILURE_CODES.includes(code), `seal failure code ${code} unknown to the shell`);
  }
  const mapped = /const SHELL_FAILURE_CODES = \{([^}]+)\}/.exec(frame)[1];
  for (const code of [...mapped.matchAll(/: '([a-z-]+)'/g)].map((m) => m[1])) assert.ok(PROCESSING_FAILURE_CODES.includes(code), code);
  assert.ok(PROCESSING_FAILURE_CODES.includes('worker-failed'));
});

test('WebRTC is removed before any other code runs, in the frame and in every Worker', () => {
  const firstStatement = (code) => code.split('\n').map((l) => l.trim()).filter(Boolean)[0];
  assert.equal(firstStatement(frame), 'SealCheck.removeWebRtc(window);');
  assert.equal(firstStatement(host), 'SealCheck.removeWebRtc(self);');
});

test('shell never reads files, never posts to the frame, and fetches only the pinned payload', () => {
  for (const api of ['FileReader', '.arrayBuffer(', 'createObjectURL', 'dataTransfer.files', 'dataTransfer.items', 'getData(', 'type="file"', "'file'", 'postMessage(', 'XMLHttpRequest', 'sendBeacon', 'WebSocket', 'window.open', 'Worker(']) {
    assert.ok(!shell.includes(api), `shell references ${api}`);
  }
  assert.equal([...shell.matchAll(/\bfetch\s*\(/g)].length, 1, 'one fetch: the tool payload');
  assert.match(shell, /fetch\(new URL\(TOOL\.path, import\.meta\.url\), \{\s*integrity: TOOL\.integrity/);
});
