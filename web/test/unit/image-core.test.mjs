import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

import { syntheticPng } from '../helpers/synthetic-image.mjs';

// image-core.js is Worker-only tool code (a classic script). Evaluate it in an
// empty context: that also proves it needs no browser APIs.
const source = readFileSync(new URL('../../src/tools/image-converter/image-core.js', import.meta.url), 'utf8');
const Core = vm.runInNewContext(`${source}\nImageCore`, Object.create(null));
// Objects from the vm context have that context's Object.prototype; compare as plain data.
const plain = (v) => JSON.parse(JSON.stringify(v));

const bytes = (...xs) => Uint8Array.from(xs.flatMap((x) => (typeof x === 'string' ? [...x].map((c) => c.charCodeAt(0)) : [x])));

test('sniffs formats by signature', () => {
  assert.equal(Core.sniffImageType(new Uint8Array(syntheticPng({ width: 2, height: 2 }))), 'image/png');
  assert.equal(Core.sniffImageType(bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0)), 'image/jpeg');
  assert.equal(Core.sniffImageType(bytes('RIFF', 0, 0, 0, 0, 'WEBPVP8 ')), 'image/webp');
  assert.equal(Core.sniffImageType(bytes('GIF89a', 0, 0)), 'image/gif');
  assert.equal(Core.sniffImageType(bytes('BM', ...new Array(30).fill(0))), 'image/bmp');
  assert.equal(Core.sniffImageType(bytes(0, 0, 0, 0x1c, 'ftypavif')), 'image/avif');
  assert.equal(Core.sniffImageType(bytes('%PDF-1.7')), null);
  assert.equal(Core.sniffImageType(bytes('<svg')), null);
  assert.equal(Core.sniffImageType(new Uint8Array(0)), null);
  assert.equal(Core.sniffImageType(null), null);
});

test('default output avoids a no-op conversion', () => {
  const all = ['image/jpeg', 'image/png', 'image/webp'];
  assert.equal(Core.defaultOutputType('image/png', all), 'image/jpeg');
  assert.equal(Core.defaultOutputType('image/jpeg', all), 'image/webp');
  assert.equal(Core.defaultOutputType('image/jpeg', ['image/jpeg', 'image/png']), 'image/jpeg');
  assert.equal(Core.defaultOutputType('image/png', []), null);
});

test('downscaleSteps halves progressively and ends at the target', () => {
  assert.deepEqual(plain(Core.downscaleSteps(1000, 800, 1000, 800)), [{ width: 1000, height: 800 }]);
  const steps = Core.downscaleSteps(4000, 3000, 300, 225);
  assert.deepEqual(plain(steps.at(-1)), { width: 300, height: 225 });
  for (let i = 1; i < steps.length; i++) assert.ok(steps[i].width >= steps[i - 1].width / 2 - 1);
  assert.deepEqual(plain(Core.downscaleSteps(100, 100, 400, 400)), [{ width: 400, height: 400 }]);
});

test('outputFileName is safe and never overwrites the input name', () => {
  assert.equal(Core.outputFileName('holiday.png', 'image/jpeg'), 'holiday.jpg');
  assert.equal(Core.outputFileName('holiday.jpg', 'image/jpeg'), 'holiday-converted.jpg');
  assert.equal(Core.outputFileName('../../etc/passwd.png', 'image/webp'), 'etc-passwd.webp');
  assert.equal(Core.outputFileName('a<b>:c|d?.png', 'image/png'), 'a-b-c-d.png');
  assert.equal(Core.outputFileName('', 'image/png'), 'image.png');
  assert.equal(Core.outputFileName('.png', 'image/png'), 'image.png');
  assert.equal(Core.outputFileName(undefined, 'image/webp'), 'image.webp');
});

test('formatBytes and sizeChange', () => {
  assert.equal(Core.formatBytes(512), '512 B');
  assert.equal(Core.formatBytes(1536), '1.5 KB');
  assert.equal(Core.formatBytes(5 * 1024 * 1024), '5.0 MB');
  assert.equal(Core.sizeChange(1000, 250), '75% smaller than original');
  assert.equal(Core.sizeChange(1000, 1500), '50% larger than original');
  assert.equal(Core.sizeChange(1000, 1000), 'same size as original');
});
