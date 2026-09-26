// The tool contract (src/runtime/tool-schema.js): what a manifest may declare,
// and what a tool's Worker may hand back to the trusted runtime.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { loadToolSchema, listToolDirs } from '../../build.mjs';

const S = await loadToolSchema();
const plain = (v) => JSON.parse(JSON.stringify(v));
const imageManifest = JSON.parse(await readFile(new URL('../../src/tools/image-converter/manifest.json', import.meta.url), 'utf8'));
const M = S.validateManifest(imageManifest);
const clone = () => structuredClone(imageManifest);
const rejects = (mutate, label) => {
  const m = clone();
  mutate(m);
  assert.throws(() => S.validateManifest(m), S.SchemaError, label);
};

class Blob {
  constructor(type, size) {
    this.type = type;
    this.size = size;
  }
}
class ImageBitmap {
  constructor(width = 10, height = 10) {
    this.width = width;
    this.height = height;
  }
}
const env = { Blob, ImageBitmap };

test('every shipped tool manifest is valid', async () => {
  const dirs = await listToolDirs();
  assert.ok(dirs.length >= 2, 'at least two tools');
  for (const dir of dirs) {
    const m = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
    assert.doesNotThrow(() => S.validateManifest(m), dir);
  }
});

test('manifests: unknown fields, versions, ids and control types are rejected', () => {
  rejects((m) => (m.script = 'alert(1)'), 'extra top-level field');
  rejects((m) => (m.manifest = 'offlineseal.tool.v0'), 'version');
  rejects((m) => (m.id = 'Image Converter'), 'id');
  rejects((m) => (m.shell.path = 'assets'), 'reserved path');
  rejects((m) => (m.shell.path = '../x'), 'path traversal');
  rejects((m) => m.controls.push({ type: 'html', id: 'x', html: '<b>' }), 'unknown control type');
  rejects((m) => m.controls.push({ type: 'button', id: 'x', label: 'Go', url: 'https://example.invalid' }), 'unknown control type with url');
  rejects((m) => (m.controls[0].onchange = 'fetch()'), 'extra control field');
  rejects((m) => m.controls.push(structuredClone(m.controls[0])), 'duplicate control id');
  rejects((m) => (m.controls[1].showWhen.control = 'nope'), 'showWhen target');
  rejects((m) => (m.controls[0].options[0].label = 'x'.repeat(50)), 'long label');
  rejects((m) => (m.controls[0].label = 'bad\u0007bell'), 'control characters');
});

test('manifests: only inert output types the runtime allows', () => {
  for (const type of ['text/html', 'image/svg+xml', 'application/xhtml+xml', 'text/javascript', 'application/octet-stream', 'application/x-msdownload']) {
    rejects((m) => (m.outputs.types[0].type = type), type);
  }
  assert.deepEqual(Object.keys(S.OUTPUT_TYPES).sort(), ['application/pdf', 'image/jpeg', 'image/png', 'image/webp']);
});

test('manifests: limits are capped by the runtime', () => {
  rejects((m) => (m.input.maxFiles = 10_000), 'max files');
  rejects((m) => (m.input.maxBytesPerFile = 10 * 1024 ** 3), 'per-file bytes');
  rejects((m) => (m.outputs.maxFiles = 100_000), 'outputs');
  rejects((m) => (m.limits.runTimeoutMs = 3_600_000), 'timeout');
  rejects((m) => (m.limits.runTimeoutMs = 10), 'timeout too short');
});

test('validated manifests are frozen copies', () => {
  assert.ok(Object.isFrozen(M) && Object.isFrozen(M.controls[0].options[0]));
});

test('capabilities: only for capability choices, only declared values', () => {
  assert.deepEqual(plain(S.validateCapabilities(M, { options: { format: ['image/png'] } })), { options: { format: ['image/png'] } });
  assert.throws(() => S.validateCapabilities(M, { options: {} }), 'missing format');
  assert.throws(() => S.validateCapabilities(M, { options: { format: ['image/gif'] } }), 'undeclared value');
  assert.throws(() => S.validateCapabilities(M, { options: { format: ['image/png'], quality: ['1'] } }), 'not a capability choice');
  assert.throws(() => S.validateCapabilities(M, { options: { format: ['image/png'] }, url: 'x' }), 'extra field');
});

const inspectOk = () => ({ summary: ['PNG · 10 × 10'], preview: new ImageBitmap(), controls: { format: { value: 'image/webp' }, size: { base: { width: 10, height: 10 } } } });

test('inspect results: exact shapes, declared controls, bounded text and previews', () => {
  assert.doesNotThrow(() => S.validateInspectResult(M, inspectOk(), env, null));
  const bad = [
    (r) => (r.html = '<b>'),
    (r) => (r.summary = ['x'.repeat(500)]),
    (r) => (r.summary = new Array(20).fill('x')),
    (r) => (r.preview = { width: 10, height: 10 }),
    (r) => (r.preview = new ImageBitmap(50_000, 10)),
    (r) => (r.controls.format.value = 'image/gif'),
    (r) => (r.controls.nope = { value: 1 }),
    (r) => delete r.controls.size,
    (r) => (r.controls.size.base.width = -1),
  ];
  for (const mutate of bad) {
    const r = inspectOk();
    mutate(r);
    assert.throws(() => S.validateInspectResult(M, r, env, null), S.SchemaError);
  }
  // Capabilities narrow what an inspect result may choose.
  assert.throws(() => S.validateInspectResult(M, inspectOk(), env, { options: { format: ['image/png'] } }));
});

const runOk = () => ({ summary: ['done'], outputs: [{ file: new Blob('image/png', 5), name: 'a.png', summary: '' }] });

test('run results: outputs must be non-empty Blobs of declared types, within count', () => {
  assert.doesNotThrow(() => S.validateRunResult(M, runOk(), env));
  const bad = [
    (r) => (r.outputs[0].file = 'bytes'),
    (r) => (r.outputs[0].file = new Blob('text/html', 5)),
    (r) => (r.outputs[0].file = new Blob('application/pdf', 5)),
    (r) => (r.outputs[0].file = new Blob('image/png', 0)),
    (r) => (r.outputs[0].url = 'https://example.invalid/'),
    (r) => r.outputs.push(runOk().outputs[0]),
    (r) => (r.outputs = []),
    (r) => (r.redirect = 'x'),
  ];
  for (const mutate of bad) {
    const r = runOk();
    mutate(r);
    assert.throws(() => S.validateRunResult(M, r, env), S.SchemaError);
  }
});

test('run results: the runtime, not the tool, decides file names and extensions', () => {
  const r = runOk();
  r.outputs[0].name = '../../evil.html';
  assert.equal(S.validateRunResult(M, r, env).outputs[0].name, 'evil.png');
  r.outputs[0].name = 'report\u0000.exe';
  assert.throws(() => S.validateRunResult(M, r, env), 'control characters rejected');
  assert.equal(S.safeFileName('a<b>:c|d?.jpeg', 'jpg'), 'a-b-c-d.jpg');
  assert.equal(S.safeFileName('...', 'pdf'), 'output.pdf');
});

test('params: exactly the declared controls, each within its spec', () => {
  const ok = { format: 'image/png', quality: 80, size: { width: 10, height: 10 } };
  assert.doesNotThrow(() => S.validateParams(M, ok));
  for (const bad of [
    { ...ok, extra: 1 },
    { ...ok, format: 'image/gif' },
    { ...ok, quality: 500 },
    { ...ok, size: { width: 20000, height: 10 } },
    { ...ok, size: { width: 10000, height: 10000 } },
    { format: 'image/png', quality: 80 },
  ]) {
    assert.throws(() => S.validateParams(M, bad), S.SchemaError, JSON.stringify(bad));
  }
});

test('text pattern spec', () => {
  assert.equal(S.textPatternAllows('0-9 ,-', '1-3, 5'), true);
  assert.equal(S.textPatternAllows('0-9 ,-', '1;3'), false);
  assert.equal(S.textPatternAllows('0-9 ,-', '<script>'), false);
});

test('fitSize / scaleSize: proportions, whole pixels and limits', () => {
  const limits = { maxDimension: 16384, maxArea: 64_000_000 };
  assert.deepEqual(plain(S.fitSize({ base: { width: 4000, height: 3000 }, width: 1000, keepAspect: true, changed: 'width', ...limits })), { width: 1000, height: 750 });
  assert.deepEqual(plain(S.fitSize({ base: { width: 4000, height: 3000 }, height: 300, keepAspect: true, changed: 'height', ...limits })), { width: 400, height: 300 });
  assert.deepEqual(plain(S.fitSize({ base: { width: 400, height: 300 }, width: 100, height: 100, keepAspect: false, ...limits })), { width: 100, height: 100 });
  assert.deepEqual(plain(S.fitSize({ base: { width: 400, height: 300 }, width: -5, height: NaN, keepAspect: false, ...limits })), { width: 400, height: 300 });
  const big = S.fitSize({ base: { width: 40000, height: 20000 }, width: 40000, height: 20000, keepAspect: false, ...limits });
  assert.ok(big.width <= 16384 && big.width * big.height <= 64_000_000 * 1.001 && Math.abs(big.width / big.height - 2) < 0.01);
  assert.deepEqual(plain(S.scaleSize({ width: 640, height: 480 }, 50, limits)), { width: 320, height: 240 });
  assert.deepEqual(plain(S.scaleSize({ width: 640, height: 480 }, 25, limits)), { width: 160, height: 120 });
});
