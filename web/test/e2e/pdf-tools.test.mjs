// PDF Tools: the second tool, built on exactly the same contract as the Image
// Converter. Outputs are verified independently with pdf-lib, and with qpdf
// when it is installed.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { MARKER, containsMarker, markerForms } from '../helpers/synthetic-image.mjs';
import { describePdf, makePdf } from '../helpers/synthetic-pdf.mjs';
import {
  launchBrowser, startApp, startProbe, openTool, waitForShellState, sealedFrame, selectChoice, runTool, downloadResult, pollFrame, sleep,
  FRAME_INSTRUMENTATION, trackWorkers, frameAudit, setHold, release, workerNamed, allClosed,
} from '../helpers/harness.mjs';

const fixture = (name) => readFileSync(new URL(`../fixtures/pdf/${name}`, import.meta.url));
const pdfFile = (name, buffer) => ({ name, mimeType: 'application/pdf', buffer });
const pairs = (pages) => pages.map((p) => [p.width, p.rotation]);
const hasQpdf = (() => {
  try {
    execFileSync('qpdf', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
const qpdfOk = (path) => {
  if (!hasQpdf) return true;
  try {
    execFileSync('qpdf', ['--check', path], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
};

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

async function openPdf(files, options = {}) {
  let track;
  const env = await openTool(browser, app, {
    path: 'pdf',
    initScripts: [FRAME_INSTRUMENTATION],
    beforeGoto: (page) => {
      track = trackWorkers(page);
    },
    ...options,
  });
  env.track = track;
  await waitForShellState(env.page, 'ready');
  env.frame = sealedFrame(env.page);
  if (files) {
    await env.frame.setInputFiles('#file', files);
    await waitForShellState(env.page, 'file-selected');
  }
  return env;
}
const itemOp = (env, key, op) => env.frame.click(`[data-control="pages"] li[data-key="${key}"] button[data-op="${op}"]`);
const itemKeys = (env) => env.frame.$$eval('[data-control="pages"] li', (lis) => lis.map((li) => li.dataset.key));

test('merge two PDFs with pages reordered, rotated and removed', async () => {
  const env = await openPdf([pdfFile('contract.pdf', fixture('classic-3.pdf')), pdfFile('scans.pdf', fixture('objstm-4.pdf'))]);
  assert.equal(await env.frame.textContent('#source-meta'), '7 pages');
  assert.deepEqual(await itemKeys(env), ['0:0', '0:1', '0:2', '1:0', '1:1', '1:2', '1:3']);
  await itemOp(env, '1:3', 'up'); // scans p4 before scans p3
  await itemOp(env, '0:0', 'down'); // contract p1 after contract p2
  await itemOp(env, '0:2', 'rotate-left'); // 0 -> 270
  await itemOp(env, '1:1', 'rotate-right'); // 90 -> 180
  await itemOp(env, '1:0', 'remove');
  assert.match(await env.frame.textContent('[data-control="pages"] .count'), /^6 of 7 pages$/);
  await runTool(env);
  const out = await downloadResult(env);
  assert.equal(out.name, 'contract-merged.pdf');
  assert.deepEqual(pairs(await describePdf(readFileSync(out.path))), [[302, 0], [301, 0], [303, 270], [402, 180], [404, 270], [403, 0]]);
  assert.ok(qpdfOk(out.path), 'qpdf --check');
  await env.context.close();
});

test('each page as its own PDF', async () => {
  const env = await openPdf([pdfFile('booklet.pdf', fixture('inherited-3.pdf'))]);
  await selectChoice(env, 'mode', 'each');
  assert.equal(await env.frame.isVisible('[data-control="each-hint"]'), true);
  await runTool(env);
  assert.equal(await env.frame.locator('#outputs a').count(), 3);
  const expected = [[501, 90], [502, 0], [503, 0]];
  for (let i = 0; i < 3; i++) {
    const out = await downloadResult(env, i);
    assert.equal(out.name, `booklet-page-${i + 1}.pdf`);
    assert.deepEqual(pairs(await describePdf(readFileSync(out.path))), [expected[i]]);
    assert.ok(qpdfOk(out.path));
  }
  await env.context.close();
});

test('split by ranges, following the order shown; bad ranges are explained', async () => {
  const env = await openPdf([pdfFile('scan.pdf', fixture('linearized-4.pdf'))]);
  await selectChoice(env, 'mode', 'ranges');
  // Only the characters the manifest allows can be typed.
  await env.frame.fill('#control-ranges', '1-2; <b>3');
  assert.equal(await env.frame.inputValue('#control-ranges'), '1-2 3');
  await env.frame.fill('#control-ranges', '1-9');
  await env.frame.click('#action');
  await waitForShellState(env.page, 'failed');
  assert.match(await env.frame.textContent('#message'), /outside pages 1–4/);

  await itemOp(env, '0:3', 'up'); // order: 1 2 4 3
  await env.frame.fill('#control-ranges', '1-2, 3-4');
  await runTool(env);
  const a = await downloadResult(env, 0);
  const b = await downloadResult(env, 1);
  assert.deepEqual([a.name, b.name], ['scan-pages-1-2.pdf', 'scan-pages-3-4.pdf']);
  assert.deepEqual(pairs(await describePdf(readFileSync(a.path))), [[401, 0], [402, 90]]);
  assert.deepEqual(pairs(await describePdf(readFileSync(b.path))), [[404, 270], [403, 0]]);
  await env.context.close();
});

test('real-world, damaged and incrementally updated PDFs are handled', async () => {
  const env = await openPdf([
    pdfFile('chromium.pdf', fixture('chromium-2.pdf')),
    pdfFile('updated.pdf', fixture('incremental-3.pdf')),
    pdfFile('broken.pdf', fixture('broken-xref-3.pdf')),
  ]);
  assert.match(await env.frame.textContent('#source-meta'), /^8 pages · 1 file had damaged structure/);
  await runTool(env);
  const out = await downloadResult(env);
  assert.deepEqual(pairs(await describePdf(readFileSync(out.path))), [[397, 0], [397, 0], [501, 90], [502, 180], [503, 0], [501, 90], [502, 0], [503, 0]]);
  assert.ok(qpdfOk(out.path));
  await env.context.close();
});

test('encrypted PDFs, non-PDFs and too many files are refused inside the frame; the shell learns nothing', async () => {
  const env = await openPdf();
  const refused = async (files, pattern) => {
    await env.frame.setInputFiles('#file', files);
    await pollFrame(env.frame, () => !document.getElementById('dz-message').hidden);
    assert.match(await env.frame.textContent('#dz-message'), pattern);
    assert.equal(await env.page.getAttribute('body', 'data-state'), 'ready');
  };
  await refused([pdfFile('locked.pdf', fixture('encrypted.pdf'))], /locked\.pdf is password-protected/);
  await refused([pdfFile('fake.pdf', Buffer.from('not really a pdf'))], /fake\.pdf is not a PDF/);
  await refused([{ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('x') }], /not a supported file type/);
  const many = Array.from({ length: 21 }, (_, i) => pdfFile(`f${i}.pdf`, fixture('classic-3.pdf')));
  await refused(many, /at most 20 files/);
  assert.match(await env.page.textContent('#tech-messages'), /^1 accepted · 0 ignored$/);
  // Still usable afterwards.
  await env.frame.setInputFiles('#file', [pdfFile('ok.pdf', fixture('classic-3.pdf'))]);
  await waitForShellState(env.page, 'file-selected');
  await env.context.close();
});

test('the PDFs stay in the sealed Workers: shell, frame realm and server never see their bytes', async () => {
  const requests = [];
  const env = await openPdf(null, {
    // Replaces openPdf's Worker tracker; this test checks Workers through the frame audit.
    beforeGoto: (page) => {
      page.on('request', (r) => requests.push({ time: Date.now(), url: r.url(), method: r.method() }));
    },
  });
  const readyAt = Date.now();
  const serverAtReady = app.log.length;
  const a = await makePdf({ widths: [311, 312], marker: `${MARKER}-pdf-a` });
  const b = await makePdf({ widths: [321], marker: `${MARKER}-pdf-b`, objectStreams: true });
  assert.ok(a.includes(Buffer.from(`${MARKER}-pdf-a`)), 'the marker really is in the file bytes');
  await env.frame.setInputFiles('#file', [pdfFile('private-a.pdf', a), pdfFile('private-b.pdf', b)]);
  await waitForShellState(env.page, 'file-selected');
  await itemOp(env, '1:0', 'up');
  await runTool(env);
  const out = await downloadResult(env);
  assert.deepEqual(pairs(await describePdf(readFileSync(out.path))), [[311, 0], [321, 0], [312, 0]]);
  // The output carries no source metadata (the Info dictionary is not copied).
  assert.ok(!readFileSync(out.path).includes(Buffer.from(MARKER)));
  await sleep(500);

  const shellAudit = await env.page.evaluate(() => window.__offlinesealAudit);
  assert.equal(shellAudit.binaryInMessages + shellAudit.blobReads + shellAudit.fileReaderReads + shellAudit.objectUrlsCreated + shellAudit.dataTransferReads, 0);
  const shellText = await env.page.content();
  assert.ok(!containsMarker(shellText) && !shellText.includes('private-a.pdf'), 'shell saw neither content nor names');

  const audit = await frameAudit(env.frame);
  assert.deepEqual(Object.entries(audit.calls).filter(([, n]) => n > 0), [], 'the frame realm read or processed nothing');
  assert.deepEqual(audit.workers.map((w) => w.name).filter((n) => n !== 'offlineseal-self-check'), ['offlineseal-inspect', 'offlineseal-run']);
  assert.ok(audit.workers.every((w) => w.terminated !== null), 'every Worker terminated');

  const forms = markerForms(`${MARKER}-pdf-a`);
  assert.deepEqual(app.log.slice(serverAtReady).map((e) => `${e.method} ${e.path}`), [], 'no server request after READY');
  for (const e of app.log) assert.ok(!containsMarker(e.url + e.body + JSON.stringify(e.headers), forms));
  const network = requests.filter((r) => r.time >= readyAt && !r.url.startsWith('blob:null/'));
  assert.deepEqual(network, [], 'no network request after READY');
  await env.context.close();
});

test('PDF Worker: network probes are blocked while it holds the files', async () => {
  probe.reset();
  const env = await openPdf();
  await setHold(env.frame, true);
  await env.frame.setInputFiles('#file', [pdfFile('probe.pdf', fixture('classic-3.pdf'))]);
  const live = await workerNamed(env.track, 'offlineseal-inspect');
  const results = await live.worker.evaluate(async (P) => {
    const out = {};
    out.fetch = await fetch(`${P}/pdf-worker`).then(() => 'reached', () => 'refused');
    out.post = await fetch(`${P}/pdf-worker-post`, { method: 'POST', body: 'benign' }).then(() => 'reached', () => 'refused');
    out.ws = await new Promise((r) => { const w = new WebSocket(P.replace('http', 'ws') + '/pdf-ws'); w.onopen = () => r('open'); w.onerror = () => r('error'); });
    try { importScripts(`${P}/pdf-import`); out.importScripts = 'loaded'; } catch (e) { out.importScripts = e.name; }
    return out;
  }, probe.origin);
  await release(env.frame);
  await waitForShellState(env.page, 'file-selected');
  await sleep(500);
  assert.deepEqual(results, { fetch: 'refused', post: 'refused', ws: 'error', importScripts: 'TypeError' });
  assert.deepEqual(probe.log, []);
  assert.equal(probe.counts.tcp, 0);
  await allClosed(env.track);
  await env.context.close();
});
