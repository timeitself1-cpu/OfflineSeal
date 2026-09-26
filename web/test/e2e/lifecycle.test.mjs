// Lifecycle: tool first, seal second, file last. Also the fail-closed paths.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { syntheticPng } from '../helpers/synthetic-image.mjs';
import { BROWSER, launchBrowser, startApp, openTool, readyTool, waitForShellState, chooseImage, convertTo, sleep, pollFrame } from '../helpers/harness.mjs';

const PAYLOAD = '/assets/sealed/image-converter.sealed.txt';

let browser, app;
before(async () => {
  browser = await launchBrowser();
  app = await startApp();
});
after(async () => {
  await browser?.close();
  await app?.close();
});

// Shell-side timeline: when the iframe appears, with which attributes, and
// when it stops being inert, relative to the frame's `frame-ready` message.
const SHELL_TIMELINE = `(() => {
  if (window !== window.top) return;
  const timeline = [];
  Object.defineProperty(window, '__timeline', { value: timeline });
  window.addEventListener('message', (e) => {
    if (e.data && typeof e.data.type === 'string') timeline.push('message:' + e.data.type);
  }, true);
  new MutationObserver((records) => {
    for (const r of records) {
      for (const n of r.addedNodes) {
        if (n.nodeName === 'IFRAME') timeline.push('iframe-inserted inert=' + n.hasAttribute('inert') + ' sandbox=' + n.getAttribute('sandbox'));
        if (n.nodeName === 'INPUT' && n.type === 'file') timeline.push('FILE-INPUT-IN-SHELL');
      }
      if (r.type === 'attributes' && r.target.nodeName === 'IFRAME') timeline.push(r.target.hasAttribute('inert') ? 'inert-added' : 'inert-removed');
    }
  }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['inert'] });
})();`;

// Frame-side: the moment the sealed script has run (DOMContentLoaded) but
// before its asynchronous seal check has finished, try every way to give the
// frame a file: drop, a set-and-change on the input, and a button click.
const tinyPng = syntheticPng({ width: 4, height: 4 }).toString('base64');
const FRAME_EARLY_ATTEMPTS = `(() => {
  if (window === window.top) return;
  const record = {};
  Object.defineProperty(window, '__preReady', { value: record });
  document.addEventListener('DOMContentLoaded', () => {
    const png = Uint8Array.from(atob('${tinyPng}'), (c) => c.charCodeAt(0));
    const file = () => { const dt = new DataTransfer(); dt.items.add(new File([png], 'early.png', { type: 'image/png' })); return dt; };
    record.state = document.body.dataset.state;
    record.inputDisabled = document.getElementById('file').disabled;
    record.chooseDisabled = document.getElementById('choose').disabled;
    document.getElementById('dropzone').dispatchEvent(new DragEvent('drop', { dataTransfer: file(), bubbles: true, cancelable: true }));
    const input = document.getElementById('file');
    input.files = file().files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    document.getElementById('choose').click();
    record.stateAfterAttempts = document.body.dataset.state;
  });
})();`;

test('file admission is impossible before READY and possible after', async () => {
  const slowApp = await startApp({ delays: { [PAYLOAD]: 1500 } });
  const env = await openTool(browser, slowApp, { initScripts: [SHELL_TIMELINE, FRAME_EARLY_ATTEMPTS] });

  // Phase 1: the tool is still downloading. There is no frame, and no file input anywhere.
  await sleep(500);
  assert.equal(await env.page.getAttribute('body', 'data-state'), 'loading-tool');
  assert.equal(await env.page.getAttribute('[data-step="tool"]', 'data-status'), 'active');
  assert.equal(await env.page.getAttribute('[data-step="area"]', 'data-status'), 'pending');
  assert.equal(await env.page.locator('iframe').count(), 0);
  assert.equal(env.page.frames().length, 1);
  assert.equal(await env.page.locator('input[type="file"]').count(), 0);
  assert.equal(await env.page.textContent('#seal-heading'), 'Preparing secure processing area…');

  // Phase 2: sealed and ready.
  await waitForShellState(env.page, 'ready');
  const frame = env.page.frames().find((f) => f !== env.page.mainFrame());
  const early = await frame.evaluate(() => window.__preReady);
  assert.equal(early.state, 'sealing', 'attempts ran while the frame was still sealing');
  assert.equal(early.inputDisabled, true);
  assert.equal(early.chooseDisabled, true);
  assert.equal(early.stateAfterAttempts, 'sealing', 'an early file was admitted');

  // None of the early attempts got through, even after the frame opened.
  assert.equal(await frame.evaluate(() => document.body.dataset.state), 'ready');
  assert.equal(await frame.evaluate(() => document.getElementById('preview').hidden), true);
  assert.match(await env.page.textContent('#tech-messages'), /^1 accepted · 0 ignored$/);

  // The shell inserted the iframe already sandboxed and inert, and only made it
  // interactive after `frame-ready`.
  const timeline = await env.page.evaluate(() => window.__timeline);
  assert.deepEqual(timeline, [
    'iframe-inserted inert=true sandbox=allow-scripts allow-downloads',
    'message:frame-ready',
    'inert-removed',
  ]);
  assert.equal(await env.page.textContent('#seal-heading'), 'Ready for your file');
  for (const step of ['tool', 'network', 'area']) {
    assert.equal(await env.page.getAttribute(`[data-step="${step}"]`, 'data-status'), 'done', step);
  }

  // Phase 3: now the picker works.
  assert.equal(await frame.evaluate(() => document.getElementById('file').disabled), false);
  await frame.setInputFiles('#file', { name: 'after-ready.png', mimeType: 'image/png', buffer: syntheticPng({ width: 32, height: 32 }) });
  await waitForShellState(env.page, 'file-selected');
  await env.context.close();
  await slowApp.close();
});

test('a tampered tool payload is refused (fail closed)', async () => {
  const env = await openTool(browser, app, {
    beforeGoto: (page) =>
      page.route(`**${PAYLOAD}`, async (route) => {
        const response = await route.fetch();
        // Strip the frame's CSP: exactly the kind of change pinning must catch.
        const body = (await response.text()).replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '');
        await route.fulfill({ response, body });
      }),
  });
  await waitForShellState(env.page, 'fatal');
  assert.match(await env.page.textContent('#fatal-text'), /did not match its pinned fingerprint/);
  assert.equal(await env.page.getAttribute('[data-step="tool"]', 'data-status'), 'failed');
  assert.equal(await env.page.locator('iframe').count(), 0);
  assert.equal(env.page.frames().length, 1);
  await env.context.close();
});

// These two simulate a broken browser or a crashing tool by patching the frame
// *before* its script runs, via a Playwright init script. Measured: in Chromium
// the init script runs before the frame's inline script; in Edge 154 it runs
// after it (the body already exists and the seal check has started). So the
// simulation cannot be expressed in Edge through Playwright. The fail-closed
// logic itself is browser-independent JavaScript, covered here in Chromium and
// by test/unit/worker-runtime.test.mjs for the Worker.
const PRE_SCRIPT_INJECTION = BROWSER === 'chromium' ? false : `init scripts run after the frame script in ${BROWSER}`;

test('a frame whose seal self-check fails never opens (fail closed)', { skip: PRE_SCRIPT_INJECTION }, async () => {
  // Simulate a browser where connect-src is not enforced: fetch "succeeds".
  const env = await openTool(browser, app, {
    initScripts: [`if (window !== window.top) window.fetch = () => Promise.resolve(new Response('simulated'));`],
  });
  await waitForShellState(env.page, 'fatal');
  assert.match(await env.page.textContent('#fatal-text'), /failed a security check \(csp-not-enforced\)/);
  assert.equal(await env.page.getAttribute('[data-step="network"]', 'data-status'), 'failed');
  assert.equal(await env.page.locator('iframe').count(), 0, 'frame destroyed');
  await env.context.close();
});

test('a frame that never reports READY is shut down after the timeout', { skip: PRE_SCRIPT_INJECTION }, async () => {
  const env = await openTool(browser, app, {
    // Simulate a tool that crashes during start-up.
    initScripts: [`if (window !== window.top) Document.prototype.getElementById = () => { throw new Error('simulated crash'); };`],
  });
  await sleep(2000);
  assert.equal(await env.page.getAttribute('body', 'data-state'), 'sealing');
  assert.equal(await env.page.$eval('iframe', (f) => f.hasAttribute('inert')), true, 'still inert while unsealed');
  await waitForShellState(env.page, 'fatal', 15_000);
  assert.match(await env.page.textContent('#fatal-text'), /did not finish its security checks in time/);
  assert.equal(await env.page.locator('iframe').count(), 0);
  await env.context.close();
});

test('each new image gets a fresh sealed frame', async () => {
  const env = await readyTool(browser, app);
  const firstInstance = await env.page.textContent('#tech-instance');
  await chooseImage(env, syntheticPng({ width: 120, height: 80 }));
  await convertTo(env, 'image/jpeg');
  assert.equal(await env.page.isVisible('#restart'), true);

  await env.page.click('#restart');
  await waitForShellState(env.page, 'ready');
  const secondInstance = await env.page.textContent('#tech-instance');
  assert.notEqual(secondInstance, firstInstance);
  assert.match(secondInstance, /^[0-9a-f]{32}$/);
  assert.equal(await env.page.locator('iframe').count(), 1);
  assert.equal(env.page.frames().length, 2, 'the previous frame is gone');
  const frame = env.page.frames().find((f) => f !== env.page.mainFrame());
  assert.equal(frame.isDetached(), false);
  assert.notEqual(frame, env.frame);
  assert.equal(env.frame.isDetached(), true, 'the old frame (and its image) was discarded');
  await pollFrame(frame, () => document.body.dataset.state === 'ready');
  assert.equal(await frame.evaluate(() => document.getElementById('preview').hidden), true, 'fresh frame holds no image');
  assert.equal(await env.page.isVisible('#restart'), false);
  await env.context.close();
});

test('a file dropped on the page outside the frame is neither read nor opened', async () => {
  const env = await readyTool(browser, app);
  const dataTransfer = await env.page.evaluateHandle(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(['benign'], 'dropped-on-shell.png', { type: 'image/png' }));
    return dt;
  });
  const readsBefore = await env.page.evaluate(() => window.__offlinesealAudit.dataTransferReads);
  await env.page.dispatchEvent('main', 'dragenter', { dataTransfer });
  await env.page.dispatchEvent('main', 'dragover', { dataTransfer });
  await env.page.dispatchEvent('main', 'drop', { dataTransfer });
  const readsAfter = await env.page.evaluate(() => window.__offlinesealAudit.dataTransferReads);
  assert.equal(readsAfter, readsBefore, 'the shell read the dropped data');
  assert.equal(env.page.url(), `${app.origin}/image`);
  assert.equal(await env.page.isVisible('#drop-nudge'), true, 'user is pointed at the processing area');
  assert.equal(await env.page.getAttribute('body', 'data-state'), 'ready');
  await env.context.close();
});
