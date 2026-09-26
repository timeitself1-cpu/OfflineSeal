import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../src/sealed/worker-protocol.js', import.meta.url), 'utf8');
const P = vm.runInNewContext(`${source}\nWorkerProtocol`, Object.create(null));

// Stand-ins for the receiving realm's constructors.
class File {}
class Blob {
  constructor(type, size) {
    this.type = type;
    this.size = size;
  }
}
class ImageBitmap {}
const env = { File, Blob, ImageBitmap };
const JOB = 'c'.repeat(32);
const file = new File();

const inspect = (extra = {}) => ({ protocol: P.ID, type: 'process-image', job: JOB, operation: 'inspect', file, previewMax: { width: 100, height: 100 }, ...extra });
const convert = (output = {}, extra = {}) => ({
  protocol: P.ID,
  type: 'process-image',
  job: JOB,
  operation: 'convert',
  file,
  previewMax: { width: 64, height: 64 },
  output: { type: 'image/webp', quality: 0.8, width: 10, height: 10, ...output },
  ...extra,
});

test('requests: exactly four types', () => {
  assert.equal(P.validateRequest({ protocol: P.ID, type: 'destroy' }, env).ok, true);
  assert.equal(P.validateRequest({ protocol: P.ID, type: 'self-check', job: JOB }, env).ok, true);
  assert.equal(P.validateRequest({ protocol: P.ID, type: 'cancel', job: JOB }, env).ok, true);
  assert.equal(P.validateRequest(inspect(), env).ok, true);
  assert.equal(P.validateRequest(convert(), env).ok, true);
  assert.equal(P.validateRequest(convert({ type: 'image/png', quality: null }), env).ok, true);
});

test('requests: generic or network-flavoured commands are rejected', () => {
  for (const type of ['fetch-url', 'proxy', 'proxy-request', 'eval', 'run-script', 'send-request', 'open-url', 'import', '__proto__', 'constructor']) {
    assert.equal(P.validateRequest({ protocol: P.ID, type, job: JOB, url: 'https://example.invalid/' }, env).ok, false, type);
  }
});

test('requests: exact shapes only', () => {
  assert.equal(P.validateRequest({ protocol: P.ID, type: 'destroy', url: 'x' }, env).ok, false);
  assert.equal(P.validateRequest({ protocol: P.ID, type: 'cancel', job: JOB, endpoint: 'x' }, env).ok, false);
  assert.equal(P.validateRequest({ protocol: P.ID, type: 'self-check', job: 'short' }, env).ok, false);
  assert.equal(P.validateRequest(inspect({ url: 'x' }), env).ok, false);
  assert.equal(P.validateRequest(inspect({ file: 'not a file' }), env).ok, false);
  assert.equal(P.validateRequest(inspect({ file: { name: 'x.png' } }), env).ok, false);
  assert.equal(P.validateRequest(inspect({ previewMax: { width: 0, height: 10 } }), env).ok, false);
  assert.equal(P.validateRequest(inspect({ operation: 'run' }), env).ok, false);
  assert.equal(P.validateRequest(convert({ type: 'image/svg+xml' }), env).ok, false);
  assert.equal(P.validateRequest(convert({ width: 1e9 }), env).ok, false);
  assert.equal(P.validateRequest(convert({ quality: 5 }), env).ok, false);
  assert.equal(P.validateRequest(convert({ endpoint: 'x' }), env).ok, false);
  assert.equal(P.validateRequest({ ...convert(), protocol: 'other' }, env).ok, false);
  for (const data of [null, 'process-image', ['process-image'], 42, new Date()]) {
    assert.equal(P.validateRequest(data, env).ok, false, String(data));
  }
});

const expectedConvert = { job: JOB, operation: 'convert' };
const complete = (extra = {}) => ({
  protocol: P.ID,
  type: 'processing-complete',
  job: JOB,
  operation: 'convert',
  info: { type: 'image/webp', width: 10, height: 10, size: 99 },
  output: new Blob('image/webp', 99),
  preview: new ImageBitmap(),
  ...extra,
});

test('responses: valid ones for the expected job and operation', () => {
  assert.equal(P.validateResponse({ protocol: P.ID, type: 'processing-started', job: JOB }, env, expectedConvert).ok, true);
  assert.equal(P.validateResponse({ protocol: P.ID, type: 'processing-failed', job: JOB, code: 'decode-failed' }, env, expectedConvert).ok, true);
  assert.equal(P.validateResponse(complete(), env, expectedConvert).ok, true);
  const inspectDone = { protocol: P.ID, type: 'processing-complete', job: JOB, operation: 'inspect', info: { type: 'image/gif', width: 3, height: 4 }, preview: new ImageBitmap() };
  assert.equal(P.validateResponse(inspectDone, env, { job: JOB, operation: 'inspect' }).ok, true);
  const check = { protocol: P.ID, type: 'self-check-passed', job: JOB, encoders: ['image/png', 'image/jpeg'] };
  assert.equal(P.validateResponse(check, env, { job: JOB, operation: 'self-check' }).ok, true);
});

test('responses: wrong job, wrong operation, bad shapes and unknown types are rejected', () => {
  assert.equal(P.validateResponse(complete({ job: 'd'.repeat(32) }), env, expectedConvert).ok, false);
  assert.equal(P.validateResponse(complete(), env, { job: JOB, operation: 'inspect' }).ok, false);
  assert.equal(P.validateResponse(complete({ url: 'x' }), env, expectedConvert).ok, false);
  assert.equal(P.validateResponse(complete({ output: 'bytes' }), env, expectedConvert).ok, false);
  assert.equal(P.validateResponse(complete({ output: new Blob('image/png', 99) }), env, expectedConvert).ok, false, 'type mismatch');
  assert.equal(P.validateResponse(complete({ output: new Blob('image/webp', 5) }), env, expectedConvert).ok, false, 'size mismatch');
  assert.equal(P.validateResponse(complete({ preview: {} }), env, expectedConvert).ok, false);
  assert.equal(P.validateResponse({ protocol: P.ID, type: 'processing-failed', job: JOB, code: 'https://x' }, env, expectedConvert).ok, false);
  assert.equal(P.validateResponse({ protocol: P.ID, type: 'self-check-passed', job: JOB, encoders: ['image/png'] }, env, expectedConvert).ok, false);
  assert.equal(P.validateResponse({ protocol: P.ID, type: 'self-check-passed', job: JOB, encoders: ['image/png', 'image/png'] }, env, { job: JOB, operation: 'self-check' }).ok, false);
  assert.equal(P.validateResponse({ protocol: P.ID, type: 'processing-started', job: JOB }, env, { job: JOB, operation: 'self-check' }).ok, false);
  for (const type of ['fetch-url', 'proxy', 'eval', 'run-script', 'upload']) {
    assert.equal(P.validateResponse({ protocol: P.ID, type, job: JOB, url: 'x' }, env, expectedConvert).ok, false, type);
  }
  assert.equal(P.validateResponse(complete(), env, null).ok, false);
});
