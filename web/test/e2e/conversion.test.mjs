// The restrictions must not make the product useless: real conversions,
// validated independently of the converter, and real local downloads.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { syntheticPng } from '../helpers/synthetic-image.mjs';
import { inspectImage } from '../helpers/image-inspect.mjs';
import { launchBrowser, startApp, readyTool, chooseImage, convertTo, downloadResult, decodeInCleanPage, waitForShellState, pollFrame } from '../helpers/harness.mjs';

let browser, app;
before(async () => {
  browser = await launchBrowser();
  app = await startApp();
});
after(async () => {
  await browser?.close();
  await app?.close();
});

async function convertAndDownload(env, type) {
  await convertTo(env, type);
  const file = await downloadResult(env);
  const bytes = await readFile(file.path);
  return { ...file, bytes, header: inspectImage(bytes) };
}

test('PNG → JPEG, WebP and PNG: valid images, downloaded locally', async (t) => {
  const env = await readyTool(browser, app);
  await chooseImage(env, syntheticPng({ width: 640, height: 480 }), 'holiday.png');
  await waitForShellState(env.page, 'file-selected');
  for (const [type, ext] of [['image/jpeg', 'jpg'], ['image/webp', 'webp'], ['image/png', 'png']]) {
    const out = await convertAndDownload(env, type);
    t.diagnostic(`${type}: ${out.name} ${out.bytes.length} bytes`);
    assert.deepEqual(out.header, { type, width: 640, height: 480 });
    assert.equal(out.name, ext === 'png' ? 'holiday-converted.png' : `holiday.${ext}`);
    const decoded = await decodeInCleanPage(env.context, out.bytes);
    assert.deepEqual([decoded.width, decoded.height], [640, 480]);
    assert.equal(await env.page.getAttribute('body', 'data-state'), 'complete');
  }
  await env.context.close();
});

test('resize: presets, custom width with proportions, and free size', async () => {
  const env = await readyTool(browser, app);
  await chooseImage(env, syntheticPng({ width: 800, height: 600 }));
  await waitForShellState(env.page, 'file-selected');

  await env.frame.click('[data-control="size"] button[data-scale="50"]');
  let out = await convertAndDownload(env, 'image/webp');
  assert.deepEqual(out.header, { type: 'image/webp', width: 400, height: 300 });

  await env.frame.fill('[data-control="size"] input[data-dim="width"]', '200');
  await env.frame.dispatchEvent('[data-control="size"] input[data-dim="width"]', 'change');
  assert.equal(await env.frame.inputValue('[data-control="size"] input[data-dim="height"]'), '150', 'height follows width');
  out = await convertAndDownload(env, 'image/jpeg');
  assert.deepEqual(out.header, { type: 'image/jpeg', width: 200, height: 150 });

  await env.frame.uncheck('[data-control="size"] input[data-lock]');
  await env.frame.fill('[data-control="size"] input[data-dim="height"]', '50');
  await env.frame.dispatchEvent('[data-control="size"] input[data-dim="height"]', 'change');
  out = await convertAndDownload(env, 'image/png');
  assert.deepEqual(out.header, { type: 'image/png', width: 200, height: 50 });
  await env.context.close();
});

test('transparent PNG → JPEG is flattened onto white', async () => {
  const env = await readyTool(browser, app);
  await chooseImage(env, syntheticPng({ width: 300, height: 90, alpha: true }));
  await waitForShellState(env.page, 'file-selected');
  assert.equal(await env.frame.isVisible('[data-control="jpeg-hint"]'), true, 'user is told about JPEG transparency');
  const out = await convertAndDownload(env, 'image/jpeg');
  const decoded = await decodeInCleanPage(env.context, out.bytes, [[10, 45], [250, 45]]);
  const [transparentArea, opaqueArea] = decoded.samples;
  assert.ok(transparentArea.slice(0, 3).every((v) => v > 245), `expected white, got ${transparentArea}`);
  assert.ok(opaqueArea[0] > 150 && opaqueArea[2] < 200, `expected image colour, got ${opaqueArea}`);
  await env.context.close();
});

test('other inputs: JPEG and GIF convert too', async () => {
  const env = await readyTool(browser, app);
  await chooseImage(env, syntheticPng({ width: 100, height: 100 }));
  await waitForShellState(env.page, 'file-selected');
  const jpeg = await convertAndDownload(env, 'image/jpeg');
  await env.context.close();

  const env2 = await readyTool(browser, app);
  await env2.frame.setInputFiles('#file', { name: 'photo.jpg', mimeType: 'image/jpeg', buffer: jpeg.bytes });
  await waitForShellState(env2.page, 'file-selected');
  assert.match(await env2.frame.textContent('#source-meta'), /^JPEG · 100 × 100/);
  const webp = await convertAndDownload(env2, 'image/webp');
  assert.deepEqual(webp.header, { type: 'image/webp', width: 100, height: 100 });
  await env2.context.close();

  const gif = Buffer.from('R0lGODlhAgACAIAAAP8AAAAA/yH5BAAAAAAALAAAAAACAAIAAAIDRAIFADs=', 'base64');
  const env3 = await readyTool(browser, app);
  await env3.frame.setInputFiles('#file', { name: 'tiny.gif', mimeType: 'image/gif', buffer: gif });
  await waitForShellState(env3.page, 'file-selected');
  const png = await convertAndDownload(env3, 'image/png');
  assert.deepEqual(png.header, { type: 'image/png', width: 2, height: 2 });
  await env3.context.close();
});

test('drag and drop into the sealed frame', async () => {
  const env = await readyTool(browser, app);
  const dataTransfer = await env.frame.evaluateHandle((b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'dropped.png', { type: 'image/png' }));
    return dt;
  }, syntheticPng({ width: 50, height: 40 }).toString('base64'));
  await env.frame.dispatchEvent('#dropzone', 'dragover', { dataTransfer });
  await env.frame.dispatchEvent('#dropzone', 'drop', { dataTransfer });
  await waitForShellState(env.page, 'file-selected');
  assert.match(await env.frame.textContent('#source-meta'), /^PNG · 50 × 40/);
  // A second drop is ignored: one frame, one file. "Use another image" makes a fresh frame.
  await env.frame.dispatchEvent('#preview', 'drop', { dataTransfer });
  assert.equal(await env.frame.evaluate(() => document.body.dataset.state), 'loaded');
  await env.context.close();
});

test('a non-image file is refused inside the frame; the shell learns nothing', async () => {
  const env = await readyTool(browser, app);
  await env.frame.setInputFiles('#file', { name: 'notes.png', mimeType: 'image/png', buffer: Buffer.from('just some text, not an image') });
  await pollFrame(env.frame, () => !document.getElementById('dz-message').hidden);
  assert.match(await env.frame.textContent('#dz-message'), /not a supported image/);
  assert.equal(await env.page.getAttribute('body', 'data-state'), 'ready');
  assert.match(await env.page.textContent('#tech-messages'), /^1 accepted · 0 ignored$/);
  // Still usable afterwards.
  await chooseImage(env, syntheticPng({ width: 20, height: 20 }));
  await waitForShellState(env.page, 'file-selected');
  await env.context.close();
});
