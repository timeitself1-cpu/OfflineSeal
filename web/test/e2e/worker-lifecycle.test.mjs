// Disposable processing Workers: one per job, never two alive, nothing shared
// between files, the frame itself never processing pixels, and clean failure.
//
// Two independent views:
//   - the browser's own: Playwright's Worker created/closed events;
//   - the frame's: FRAME_INSTRUMENTATION wraps the frame realm's Worker
//     constructor (logging create/terminate and message types) and counts
//     every image-processing or byte-reading API the frame's own code calls.
//     Its gate can hold a job's request so a live Worker can be inspected.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { MARKER, containsMarker, syntheticPng } from '../helpers/synthetic-image.mjs';
import { launchBrowser, startApp, startProbe, openTool, waitForShellState, sealedFrame, chooseImage, convertTo, downloadResult, sleep, pollFrame, FRAME_INSTRUMENTATION, trackWorkers, frameAudit, setHold, release, nextWorker, allClosed } from '../helpers/harness.mjs';



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

async function open(options = {}) {
  let track;
  const env = await openTool(browser, app, {
    initScripts: [FRAME_INSTRUMENTATION],
    // Attach before navigating, so the self-check Worker is seen too.
    beforeGoto: (page) => {
      track = trackWorkers(page);
    },
    ...options,
  });
  env.track = track;
  await waitForShellState(env.page, 'ready');
  env.frame = sealedFrame(env.page);
  return env;
}

function maxAlive(events) {
  let alive = 0;
  let max = 0;
  for (const [kind] of events) {
    alive += kind === 'created' ? 1 : -1;
    max = Math.max(max, alive);
  }
  return max;
}

test('one fresh Worker per job, each terminated when its job ends, never two alive', async () => {
  const env = await open();
  await chooseImage(env, syntheticPng({ width: 320, height: 240 }));
  await waitForShellState(env.page, 'file-selected');
  await convertTo(env, 'image/jpeg');
  await convertTo(env, 'image/webp');
  await allClosed(env.track);

  const audit = await frameAudit(env.frame);
  assert.deepEqual(audit.workers.map((w) => w.name), ['offlineseal-self-check', 'offlineseal-inspect', 'offlineseal-convert', 'offlineseal-convert']);
  for (const w of audit.workers) {
    assert.notEqual(w.terminated, null, `${w.name} was not terminated`);
    assert.equal(w.requests.filter((t) => t === 'process-image' || t === 'self-check').length, 1, 'exactly one job per Worker');
    assert.equal(w.requests.at(-1), 'destroy');
  }
  // Each Worker was terminated before the next one was created.
  for (let i = 1; i < audit.workers.length; i++) assert.ok(audit.workers[i - 1].terminated <= audit.workers[i].created);
  // The browser agrees: four distinct Workers, all closed, never two alive at once.
  assert.equal(env.track.workers.length, 4);
  assert.equal(new Set(env.track.workers.map((w) => w.worker)).size, 4);
  assert.equal(maxAlive(env.track.events), 1);
  assert.deepEqual(env.page.workers(), [], 'no Worker alive after the jobs');
  await env.context.close();
});

test('File A and File B: different Workers; A is gone before B starts; B cannot see A\'s state', async () => {
  const env = await open();
  // File A: hold its inspect job so the live Worker can be inspected, and plant state in it.
  await setHold(env.frame, true);
  await chooseImage(env, syntheticPng({ width: 200, height: 150, marker: `${MARKER}-A` }), 'file-a.png');
  const workerA = await nextWorker(env.track, 2); // #1 was the self-check
  await workerA.worker.evaluate((marker) => {
    self.__plantedByTest = marker;
    globalThis.__fileAState = { seen: 'file A' };
  }, `${MARKER}-A`);
  assert.equal(await workerA.worker.evaluate(() => typeof self.__plantedByTest), 'string', 'plant worked');
  await release(env.frame);
  await waitForShellState(env.page, 'file-selected');
  await convertTo(env, 'image/png');
  await allClosed(env.track);
  const aWorkers = env.track.workers.slice();
  const lastAClosed = Math.max(...aWorkers.map((w) => w.closed));

  // File B: "Use another image" gives a fresh frame; hold B's inspect job too.
  await env.page.click('#restart');
  await waitForShellState(env.page, 'ready');
  const frameB = sealedFrame(env.page);
  await setHold(frameB, true);
  await frameB.setInputFiles('#file', { name: 'file-b.png', mimeType: 'image/png', buffer: syntheticPng({ width: 120, height: 90, marker: `${MARKER}-B` }) });
  const workerB = await nextWorker(env.track, aWorkers.length + 2); // B's self-check, then B's inspect
  assert.ok(!aWorkers.some((w) => w.worker === workerB.worker), 'B has its own Worker');
  assert.ok(lastAClosed <= workerB.created, 'every File A Worker closed before File B began');

  const view = await workerB.worker.evaluate(() => {
    const idb = (() => {
      try {
        indexedDB.open('probe');
        return 'opened';
      } catch (e) {
        return e.name;
      }
    })();
    return {
      planted: typeof self.__plantedByTest,
      fileAState: typeof globalThis.__fileAState,
      ownGlobals: Object.getOwnPropertyNames(self).filter((k) => k.startsWith('__')),
      name: self.name,
      origin: self.origin,
      idb,
      caches: typeof caches,
    };
  });
  assert.equal(view.planted, 'undefined');
  assert.equal(view.fileAState, 'undefined');
  assert.deepEqual(view.ownGlobals, []);
  assert.equal(view.name, 'offlineseal-inspect');
  assert.equal(view.origin, 'null');
  assert.equal(view.idb, 'SecurityError', 'no persistent storage that could carry state between Workers');
  assert.equal(view.caches, 'undefined');
  await release(frameB);
  await waitForShellState(env.page, 'file-selected');
  assert.match(await frameB.textContent('#source-meta'), /^PNG · 120 × 90/);
  await env.context.close();
});

test('within one file, a second conversion cannot see the first conversion\'s Worker state', async () => {
  const env = await open();
  await chooseImage(env, syntheticPng({ width: 100, height: 80 }));
  await waitForShellState(env.page, 'file-selected');
  await setHold(env.frame, true);
  await env.frame.click('#convert');
  const first = await nextWorker(env.track, 3);
  await first.worker.evaluate(() => { self.__plantedByTest = 'conversion 1'; });
  await release(env.frame);
  await waitForShellState(env.page, 'complete');

  await setHold(env.frame, true);
  await env.frame.check('#formats input[value="image/png"]');
  await env.frame.click('#convert');
  const second = await nextWorker(env.track, 4);
  assert.notEqual(second.worker, first.worker);
  assert.notEqual(first.closed, null, 'first conversion Worker already closed');
  assert.equal(await second.worker.evaluate(() => typeof self.__plantedByTest), 'undefined');
  await release(env.frame);
  await waitForShellState(env.page, 'complete');
  await env.context.close();
});

test('the sealed frame never decodes, resizes, encodes or reads bytes itself', async () => {
  const env = await open();
  await chooseImage(env, syntheticPng({ width: 400, height: 300, alpha: true }));
  await waitForShellState(env.page, 'file-selected');
  await env.frame.click('#scales button[data-scale="50"]');
  await convertTo(env, 'image/jpeg');
  await downloadResult(env);
  await convertTo(env, 'image/webp');

  const audit = await frameAudit(env.frame);
  const used = Object.entries(audit.calls).filter(([, n]) => n > 0);
  assert.deepEqual(used, [], `frame realm called processing APIs: ${JSON.stringify(used)}`);
  assert.deepEqual([...new Set(audit.contexts)], ['bitmaprenderer'], 'the frame only displays Worker bitmaps');
  assert.ok(Object.keys(audit.calls).length >= 20, 'instrumentation installed');
  // Positive control: the counters do see frame-realm calls.
  await env.frame.evaluate(() => createImageBitmap(new ImageData(1, 1)));
  assert.equal((await frameAudit(env.frame)).calls.createImageBitmap, 1);
  await env.context.close();
});

test('selecting another image mid-conversion terminates the running Worker', async () => {
  const env = await open();
  await chooseImage(env, syntheticPng({ width: 300, height: 200 }));
  await waitForShellState(env.page, 'file-selected');
  await setHold(env.frame, true);
  await env.frame.click('#convert');
  const running = await nextWorker(env.track, 3);
  await waitForShellState(env.page, 'processing');
  assert.equal(running.closed, null, 'conversion Worker is alive');

  await env.page.click('#restart');
  await waitForShellState(env.page, 'ready');
  const deadline = Date.now() + 5000;
  while (running.closed === null && Date.now() < deadline) await sleep(20);
  assert.notEqual(running.closed, null, 'the running Worker was terminated with its frame');

  const frameB = sealedFrame(env.page);
  await chooseImage({ frame: frameB }, syntheticPng({ width: 60, height: 40 }), 'next.png');
  await waitForShellState(env.page, 'file-selected');
  const bInspect = env.track.workers.at(-1);
  assert.ok(running.closed <= bInspect.created, 'the old Worker was gone before the next file began');
  await allClosed(env.track);
  await env.context.close();
});

test('unknown and malformed Worker messages are ignored; the job still completes', async () => {
  const env = await open();
  await chooseImage(env, syntheticPng({ width: 160, height: 120 }));
  await waitForShellState(env.page, 'file-selected');
  await setHold(env.frame, true);
  await env.frame.click('#convert');
  const live = await nextWorker(env.track, 3);
  const job = (await frameAudit(env.frame)).workers.at(-1).job;
  const appLogStart = app.log.length;
  const warningsBefore = env.consoleMessages.filter((m) => m.text.includes('Ignored worker message')).length;

  // Worker -> frame: hostile or malformed messages from the live Worker.
  const sent = await live.worker.evaluate(
    ({ job, target }) => {
      const P = 'offlineseal.worker.v1';
      const messages = [
        { protocol: P, type: 'fetch-url', job, url: `${target}/w-fetch-url` },
        { protocol: P, type: 'proxy-request', job, endpoint: `${target}/w-proxy`, request: { method: 'POST' } },
        { protocol: P, type: 'run-script', job, payload: `fetch('${target}/w-run')` },
        { protocol: P, type: 'eval', job, payload: '1+1' },
        { protocol: P, type: 'open-url', job, url: `${target}/w-open` },
        { protocol: P, type: 'processing-complete', job: 'f'.repeat(32), operation: 'convert' },
        { protocol: P, type: 'processing-complete', job, operation: 'convert', info: { type: 'image/png', width: 1, height: 1, size: 3 }, output: 'not a blob', preview: null, url: `${target}/w-extra` },
        { protocol: P, type: 'processing-failed', job, code: `${target}/w-code` },
        { protocol: P, type: 'self-check-passed', job, encoders: ['image/png'] },
        { type: 'processing-complete', job },
        `fetch ${target}/w-string`,
        [job, 'processing-complete'],
      ];
      for (const m of messages) postMessage(m);
      return messages.length;
    },
    { job, target: probe.origin },
  );
  // Frame -> worker: hostile requests delivered straight to the Worker's own handler.
  await live.worker.evaluate((target) => {
    const P = 'offlineseal.worker.v1';
    for (const data of [
      { protocol: P, type: 'fetch-url', url: `${target}/wr-fetch` },
      { protocol: P, type: 'run-script', payload: `fetch('${target}/wr-run')` },
      { protocol: P, type: 'process-image', job: 'a'.repeat(32), operation: 'convert', file: 'not a file', previewMax: { width: 1, height: 1 } },
      { protocol: P, type: 'cancel', job: 'b'.repeat(32), url: `${target}/wr-cancel` },
    ]) {
      self.dispatchEvent(new MessageEvent('message', { data }));
    }
  }, probe.origin);
  await sleep(500);

  const warnings = env.consoleMessages.filter((m) => m.text.includes('Ignored worker message')).length - warningsBefore;
  assert.equal(warnings, sent, 'every hostile Worker message was dropped');
  assert.equal(await env.frame.evaluate(() => document.body.dataset.state), 'processing', 'frame state unchanged');
  assert.equal(await env.page.getAttribute('body', 'data-state'), 'processing', 'shell state unchanged');
  assert.equal(live.closed, null, 'the Worker ignored the hostile requests (still waiting for its job)');
  assert.deepEqual(probe.log, []);
  assert.equal(probe.counts.tcp, 0);
  assert.deepEqual(app.log.slice(appLogStart), []);

  await release(env.frame);
  await waitForShellState(env.page, 'complete');
  const out = await downloadResult(env);
  assert.match(out.name, /\.jpg$/);
  await env.context.close();
});

test('Worker failures fail cleanly: decode error and crash, with nothing leaked to the shell', async () => {
  const env = await open();
  // 1. A file that looks like a PNG but cannot be decoded.
  const broken = Buffer.concat([syntheticPng({ width: 8, height: 8 }).subarray(0, 40), Buffer.from(`${MARKER} corrupted`)]);
  await env.frame.setInputFiles('#file', { name: 'broken.png', mimeType: 'image/png', buffer: broken });
  await pollFrame(env.frame, () => !document.getElementById('dz-message').hidden);
  assert.match(await env.frame.textContent('#dz-message'), /could not be read/);
  assert.equal(await env.page.getAttribute('body', 'data-state'), 'ready', 'shell was never told about the file');
  await allClosed(env.track);
  let audit = await frameAudit(env.frame);
  assert.deepEqual(audit.workers[1].responses, ['processing-started', 'processing-failed']);

  // 2. A Worker that crashes mid-job.
  await chooseImage(env, syntheticPng({ width: 200, height: 100 }));
  await waitForShellState(env.page, 'file-selected');
  await setHold(env.frame, true);
  await env.frame.click('#convert');
  const doomed = await nextWorker(env.track, 4);
  await doomed.worker.evaluate(() => {
    setTimeout(() => {
      throw new Error('simulated worker crash');
    }, 0);
  });
  await waitForShellState(env.page, 'failed');
  assert.match(await env.frame.textContent('#message'), /did not work/);
  await allClosed(env.track);
  audit = await frameAudit(env.frame);
  assert.notEqual(audit.workers.at(-1).terminated, null, 'crashed Worker terminated');
  await release(env.frame); // the held request goes to the terminated Worker: dropped

  // The shell learned only status codes, never bytes.
  const shellAudit = await env.page.evaluate(() => window.__offlinesealAudit);
  assert.equal(shellAudit.binaryInMessages, 0);
  assert.equal(shellAudit.blobReads + shellAudit.fileReaderReads + shellAudit.objectUrlsCreated, 0);
  const strings = shellAudit.messages.flatMap((m) => m.strings);
  assert.ok(strings.includes('worker-failed'), 'the shell was told the conversion failed');
  assert.ok(!strings.some((s) => containsMarker(s)), 'marker reached the shell');
  assert.ok(!containsMarker(await env.page.content()));

  // And the tool still works afterwards, in a fresh Worker.
  await convertTo(env, 'image/png');
  await env.context.close();
});
