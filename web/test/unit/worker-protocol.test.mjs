// The generic frame <-> Worker protocol (src/runtime/worker-protocol.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src = (p) => readFileSync(new URL(`../../src/${p}`, import.meta.url), 'utf8');
const ctx = vm.runInNewContext(`${src('runtime/tool-schema.js')}\n${src('runtime/worker-protocol.js')}\n({ ToolSchema, WorkerProtocol })`, Object.create(null));
const { ToolSchema, WorkerProtocol: P } = ctx;
const manifest = ToolSchema.validateManifest(JSON.parse(src('tools/image-converter/manifest.json')));

class File {}
class Blob {
  constructor(type, size) {
    this.type = type;
    this.size = size;
  }
}
class ImageBitmap {
  constructor() {
    this.width = 10;
    this.height = 10;
  }
}
const JOB = 'c'.repeat(32);
const file = new File();
const params = { format: 'image/webp', quality: 80, size: { width: 10, height: 10 } };
const req = (extra = {}) => ({ protocol: P.ID, type: 'process', job: JOB, operation: 'run', files: [file], params, previewMax: { width: 100, height: 100 }, ...extra });
const context = { manifest, capabilities: null, env: { Blob, ImageBitmap } };

test('requests: exactly four types', () => {
  assert.equal(P.validateRequest({ protocol: P.ID, type: 'destroy' }, { File }, manifest).ok, true);
  assert.equal(P.validateRequest({ protocol: P.ID, type: 'self-check', job: JOB }, { File }, manifest).ok, true);
  assert.equal(P.validateRequest({ protocol: P.ID, type: 'cancel', job: JOB }, { File }, manifest).ok, true);
  assert.equal(P.validateRequest(req(), { File }, manifest).ok, true);
  assert.equal(P.validateRequest(req({ operation: 'inspect', params: null }), { File }, manifest).ok, true);
});

test('requests: generic or network-flavoured commands are rejected', () => {
  for (const type of ['fetch-url', 'proxy', 'proxy-request', 'eval', 'run-script', 'send-request', 'open-url', 'import', '__proto__', 'constructor']) {
    assert.equal(P.validateRequest({ protocol: P.ID, type, job: JOB, url: 'https://example.invalid/' }, { File }, manifest).ok, false, type);
  }
});

test('requests: exact shapes, manifest file limits and validated params', () => {
  const bad = [
    req({ url: 'x' }),
    req({ files: ['not a file'] }),
    req({ files: [] }),
    req({ files: [file, file] }), // the image tool takes one file
    req({ operation: 'eval' }),
    req({ operation: 'inspect' }), // inspect takes no params
    req({ params: { ...params, format: 'image/gif' } }),
    req({ params: { ...params, extra: 1 } }),
    req({ previewMax: { width: 0, height: 1 } }),
    req({ protocol: 'offlineseal.worker.v1' }),
    { protocol: P.ID, type: 'destroy', url: 'x' },
  ];
  for (const r of bad) assert.equal(P.validateRequest(r, { File }, manifest).ok, false, JSON.stringify(Object.keys(r)));
  for (const data of [null, 'process', ['process'], 42, new Date()]) assert.equal(P.validateRequest(data, { File }, manifest).ok, false);
});

const done = (result) => ({ protocol: P.ID, type: 'processing-complete', job: JOB, operation: 'run', result });

test('responses: valid ones for the expected job and operation', () => {
  const expected = { job: JOB, operation: 'run' };
  assert.equal(P.validateResponse({ protocol: P.ID, type: 'processing-started', job: JOB }, expected, context).ok, true);
  assert.equal(P.validateResponse({ protocol: P.ID, type: 'processing-failed', job: JOB, code: 'tool-failed', message: 'Nope.' }, expected, context).ok, true);
  const ok = P.validateResponse(done({ summary: ['x'], outputs: [{ file: new Blob('image/webp', 3), name: 'a.webp', summary: '' }] }), expected, context);
  assert.equal(ok.ok, true);
  const check = P.validateResponse({ protocol: P.ID, type: 'self-check-passed', job: JOB, capabilities: { options: { format: ['image/png'] } } }, { job: JOB, operation: 'self-check' }, context);
  assert.equal(check.ok, true);
});

test('responses: results are checked against the manifest', () => {
  const expected = { job: JOB, operation: 'run' };
  const bad = [
    done({ summary: ['x'], outputs: [{ file: new Blob('text/html', 3), name: 'a.html', summary: '' }] }),
    done({ summary: ['x'], outputs: [{ file: 'bytes', name: 'a.png', summary: '' }] }),
    done({ summary: ['x'], outputs: [] }),
    { ...done({ summary: [], outputs: [] }), job: 'd'.repeat(32) },
    { ...done({ summary: [], outputs: [] }), operation: 'inspect' },
    { protocol: P.ID, type: 'processing-failed', job: JOB, code: 'https://x', message: '' },
    { protocol: P.ID, type: 'processing-failed', job: JOB, code: 'tool-failed', message: 'x'.repeat(1000) },
    { protocol: P.ID, type: 'self-check-passed', job: JOB, capabilities: { options: {} } },
  ];
  for (const r of bad) assert.equal(P.validateResponse(r, expected, context).ok, false, JSON.stringify(r).slice(0, 80));
  for (const type of ['fetch-url', 'proxy', 'eval', 'run-script', 'upload', 'render-html']) {
    assert.equal(P.validateResponse({ protocol: P.ID, type, job: JOB, url: 'x' }, expected, context).ok, false, type);
  }
});
