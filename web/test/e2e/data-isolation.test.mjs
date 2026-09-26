// Parent data isolation and server observation.
//
// A deterministic synthetic PNG carrying a unique harmless marker goes through
// the whole flow: choose, convert twice, download twice. Meanwhile:
//   - the shell realm is instrumented (SHELL_AUDIT_SCRIPT) for any access to
//     file contents, and every message it receives is recorded;
//   - the app server records every request (URL, headers, body);
//   - Playwright records every request from every frame.
// This is observation of what happened in this run in Chromium, not a proof
// about every browser behaviour.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { PROTOCOL_ID } from '../../src/shell/assets/protocol.js';
import { MARKER, markerForms, containsMarker, syntheticPng } from '../helpers/synthetic-image.mjs';
import { launchBrowser, startApp, startProbe, readyTool, chooseImage, convertTo, downloadResult, waitForShellState, sleep } from '../helpers/harness.mjs';

let browser, app, probe;
before(async () => {
  browser = await launchBrowser();
  app = await startApp();
  probe = await startProbe();
});
after(async () => {
  await browser?.close();
  await app?.close();
  await probe?.close();
});

const FILE_NAME = 'synthetic-test-image.png';

test('the file and its bytes stay in the sealed frame; the shell and server never see them', async (t) => {
  const image = syntheticPng({ width: 640, height: 480 });
  assert.ok(image.includes(Buffer.from(MARKER)), 'the synthetic file really contains the marker');

  const requests = [];
  const env = await readyTool(browser, app, {
    beforeGoto: (page) => {
      page.on('request', (r) => requests.push({ time: Date.now(), method: r.method(), url: r.url(), frame: r.frame() === page.mainFrame() ? 'shell' : 'sealed', body: r.postData() ?? '' }));
    },
  });
  const readyAt = Date.now();
  const serverLogAtReady = app.log.length;
  const instance = await env.page.textContent('#tech-instance');

  await chooseImage(env, image, FILE_NAME);
  await waitForShellState(env.page, 'file-selected');
  // The image really is inside the frame (preview has pixels).
  const previewPainted = await env.frame.evaluate(() => {
    const c = document.getElementById('preview-canvas');
    const d = c.getContext('2d').getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data;
    return d[3] === 255;
  });
  assert.ok(previewPainted);

  await convertTo(env, 'image/jpeg');
  const jpeg = await downloadResult(env);
  await convertTo(env, 'image/webp');
  const webp = await downloadResult(env);
  await sleep(1000);

  // 1. Shell realm: no file access of any kind, no binary data received.
  const audit = await env.page.evaluate(() => window.__offlinesealAudit);
  t.diagnostic(`shell audit: ${JSON.stringify({ ...audit, messages: audit.messages.length })}`);
  assert.equal(audit.binaryInMessages, 0, 'binary data (Blob/File/ArrayBuffer/typed array) reached the shell');
  assert.equal(audit.blobReads, 0, 'shell read a Blob');
  assert.equal(audit.fileReaderReads, 0, 'shell used FileReader');
  assert.equal(audit.objectUrlsCreated, 0, 'shell created an object URL');
  assert.equal(audit.dataTransferReads, 0, 'shell read drag-and-drop data');
  assert.equal(audit.fileInputReads, 0, 'shell read a file input');

  // 2. Every message the shell received was a protocol status message.
  const allowedStrings = new Set(['protocol', 'instance', 'type', 'code', PROTOCOL_ID, instance, 'frame-ready', 'file-selected', 'processing-started', 'processing-complete']);
  assert.ok(audit.messages.length >= 5);
  for (const m of audit.messages) {
    assert.equal(m.origin, 'null');
    for (const s of m.strings) assert.ok(allowedStrings.has(s), `unexpected string in a message to the shell: ${JSON.stringify(s).slice(0, 80)}`);
  }

  // 3. Nothing in the shell's DOM or storage holds the marker or even the file name.
  const shellText = await env.page.evaluate(() => document.documentElement.outerHTML + JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
  assert.equal(containsMarker(shellText), false, 'marker found in the shell');
  assert.ok(!shellText.includes(FILE_NAME), 'the shell does not even learn the file name');

  // 4. Server: nothing at all after READY, and the marker nowhere, ever.
  const forms = markerForms();
  const afterReady = app.log.slice(serverLogAtReady);
  assert.deepEqual(afterReady.map((e) => `${e.method} ${e.url}`), [], 'server received requests during processing');
  for (const e of app.log) {
    assert.equal(containsMarker(e.url, forms), false, 'marker in a request URL');
    assert.equal(containsMarker(e.body, forms), false, 'marker in a request body');
    assert.equal(containsMarker(JSON.stringify(e.headers), forms), false, 'marker in request headers');
    assert.ok(e.method === 'GET', `unexpected ${e.method} (upload?) request`);
  }
  assert.deepEqual(probe.log, []);

  // 5. Browser-side view: no request from any frame after READY.
  const processingRequests = requests.filter((r) => r.time >= readyAt);
  assert.deepEqual(processingRequests, [], 'the browser issued requests during processing');
  const loadRequests = requests.filter((r) => r.time < readyAt);
  assert.ok(loadRequests.every((r) => r.frame === 'shell' && r.method === 'GET' && r.url.startsWith(app.origin)));
  t.diagnostic(`requests before READY: ${loadRequests.map((r) => new URL(r.url).pathname).join(', ')}`);

  // 6. The results exist only as local downloads.
  assert.match(jpeg.name, /\.jpg$/);
  assert.match(webp.name, /\.webp$/);
  await env.context.close();
});

test('positive control: the shell audit detects leaked bytes and marker if a frame posts them', async () => {
  const env = await readyTool(browser, app);
  // Simulate a hostile tool: post raw bytes and the marker to the shell.
  await env.frame.evaluate(
    ({ protocol, marker }) => {
      const instance = document.querySelector('meta[name="offlineseal-instance"]').content;
      window.parent.postMessage({ protocol, instance, type: 'processing-complete', payload: new TextEncoder().encode(marker).buffer }, '*');
      window.parent.postMessage({ protocol, instance, type: 'exfiltrate', data: marker }, '*');
    },
    { protocol: PROTOCOL_ID, marker: MARKER },
  );
  await sleep(300);
  const audit = await env.page.evaluate(() => window.__offlinesealAudit);
  assert.equal(audit.binaryInMessages, 1, 'detector saw the ArrayBuffer');
  assert.ok(audit.messages.some((m) => m.strings.includes(MARKER)), 'detector saw the marker');
  // ...and the shell ignored both: still ready, nothing stored, nothing sent.
  assert.equal(await env.page.getAttribute('body', 'data-state'), 'ready');
  assert.match(await env.page.textContent('#tech-messages'), /1 accepted · 2 ignored/);
  const shellText = await env.page.evaluate(() => document.documentElement.outerHTML);
  assert.equal(containsMarker(shellText), false);
  await env.context.close();
});
