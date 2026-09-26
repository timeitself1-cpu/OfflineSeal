// Runs a real, built tool Worker script (the Image Converter's) in a fake
// Worker global (node:vm), to check the runtime Worker host deterministically:
// message handling, one job per Worker, and failing closed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { join } from 'node:path';

import { buildTool, TOOLS_DIR } from '../../build.mjs';

const { workerScript } = await buildTool(join(TOOLS_DIR, 'image-converter'));
const JOB = 'e'.repeat(32);
const ID = 'offlineseal.worker.v2';

// A fake DedicatedWorkerGlobalScope. `sealed` controls whether fetch of the
// data: URL is refused with a connect-src violation (the real, sealed
// behaviour) or quietly succeeds (a browser that failed to enforce the policy).
function fakeWorker({ sealed = true } = {}) {
  const listeners = {};
  const posted = [];
  const reads = { slice: 0, arrayBuffer: 0 };
  class File {
    constructor(name = 'x.png', size = 10) {
      this.name = name;
      this.size = size;
    }
    slice() {
      reads.slice += 1;
      return { arrayBuffer: async () => { reads.arrayBuffer += 1; return new ArrayBuffer(32); } };
    }
    async arrayBuffer() {
      reads.arrayBuffer += 1;
      return new ArrayBuffer(32);
    }
  }
  class Blob {}
  class ImageBitmap {}
  const g = {
    origin: 'null',
    File,
    Blob,
    ImageBitmap,
    closed: false,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    Uint8Array,
    ArrayBuffer,
    indexedDB: { open() { throw Object.assign(new Error('opaque origin'), { name: 'SecurityError' }); } },
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    removeEventListener(type, fn) { listeners[type] = (listeners[type] || []).filter((f) => f !== fn); },
    postMessage(message) { posted.push(message); },
    close() { g.closed = true; },
    fetch() {
      if (!sealed) return Promise.resolve({ ok: true });
      queueMicrotask(() => {
        for (const fn of listeners.securitypolicyviolation || []) fn({ effectiveDirective: 'connect-src', originalPolicy: "default-src 'none'; connect-src 'none'" });
      });
      return Promise.reject(new TypeError('Failed to fetch'));
    },
    createImageBitmap: async () => { throw new Error('decode not available in this fake'); },
  };
  g.self = g;
  vm.createContext(g);
  vm.runInContext(workerScript, g);
  const send = (data) => { for (const fn of listeners.message || []) fn({ data }); };
  return { g, send, posted, reads };
}

const settle = () => new Promise((r) => setTimeout(r, 50));
const inspect = (g, job = JOB) => ({ protocol: ID, type: 'process', job, operation: 'inspect', files: [new g.File()], params: null, previewMax: { width: 10, height: 10 } });

test('unknown and malformed requests get no reply and change nothing', async () => {
  const { g, send, posted } = fakeWorker();
  for (const data of [
    { protocol: ID, type: 'fetch-url', url: 'https://example.invalid/' },
    { protocol: ID, type: 'run-script', payload: 'x' },
    { protocol: ID, type: 'eval', payload: '1' },
    { ...inspect(g), files: ['bytes'] },
    { ...inspect(g), operation: 'run', params: { format: 'text/html' } },
    { protocol: 'offlineseal.worker.v1', type: 'destroy' },
    { protocol: ID, type: 'destroy', url: 'x' },
    'destroy',
    null,
  ]) {
    send(data);
  }
  await settle();
  assert.deepEqual(posted, []);
  assert.equal(g.closed, false);
});

test('destroy closes the Worker; cancel only for its own job', async () => {
  const a = fakeWorker();
  a.send({ protocol: ID, type: 'cancel', job: JOB });
  assert.equal(a.g.closed, false, 'no job yet, nothing to cancel');
  a.send({ protocol: ID, type: 'destroy' });
  assert.equal(a.g.closed, true);
});

test('a Worker takes exactly one job', async () => {
  const { send, posted, g } = fakeWorker();
  send(inspect(g));
  send(inspect(g, 'f'.repeat(32)));
  send({ protocol: ID, type: 'self-check', job: 'a'.repeat(32) });
  await settle();
  assert.deepEqual([...new Set(posted.map((m) => m.job))], [JOB], 'only the first job was served');
  assert.equal(posted[0].type, 'processing-started');
  assert.equal(posted.at(-1).type, 'processing-failed', 'this fake cannot decode, so the job fails cleanly');
});

test('a Worker whose network seal cannot be verified refuses to read the files', async () => {
  const { send, posted, reads, g } = fakeWorker({ sealed: false });
  send(inspect(g));
  await settle();
  assert.deepEqual(posted.map((m) => [m.type, m.code]), [['processing-started', undefined], ['processing-failed', 'worker-seal-failed']]);
  assert.deepEqual(reads, { slice: 0, arrayBuffer: 0 }, 'not a single byte was read');
});

test('self-check fails closed when the seal cannot be verified', async () => {
  const { send, posted } = fakeWorker({ sealed: false });
  send({ protocol: ID, type: 'self-check', job: JOB });
  await settle();
  assert.deepEqual(posted.map((m) => [m.type, m.code]), [['processing-failed', 'worker-seal-failed']]);
});

test('every reply uses the Worker protocol and names the job', async () => {
  const { send, posted, g } = fakeWorker();
  send(inspect(g));
  await settle();
  assert.ok(posted.length >= 2);
  for (const m of posted) {
    assert.equal(m.protocol, ID);
    assert.equal(m.job, JOB);
  }
});
