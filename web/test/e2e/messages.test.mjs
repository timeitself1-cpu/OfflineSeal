// Parent <-> sealed-frame message allowlist, tested against the live shell.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { PROTOCOL_ID } from '../../src/shell/assets/protocol.js';
import { syntheticPng } from '../helpers/synthetic-image.mjs';
import { launchBrowser, startApp, startProbe, readyTool, chooseImage, convertTo, sleep } from '../helpers/harness.mjs';

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

const shellSnapshot = (page) =>
  page.evaluate(() => ({
    state: document.body.dataset.state,
    url: location.href,
    elements: document.querySelectorAll('*').length,
    iframes: document.querySelectorAll('iframe').length,
    loaders: document.querySelectorAll('img, script:not([type="module"]), link[rel]:not([rel="icon"]):not([rel="stylesheet"]), form, object, embed').length,
  }));

test('unknown, malformed and network-flavoured messages cause no shell action', async (t) => {
  const env = await readyTool(browser, app);
  // Count anything the shell might send *into* the frame (it should send nothing).
  await env.frame.evaluate(() => {
    window.__fromShell = 0;
    window.addEventListener('message', () => {
      window.__fromShell += 1;
    });
  });
  const before = await shellSnapshot(env.page);
  const appLogStart = app.log.length;
  const warningsStart = env.consoleMessages.filter((m) => m.text.includes('[OfflineSeal] Ignored')).length;

  const sent = await env.frame.evaluate(
    ({ protocol, target }) => {
      const instance = document.querySelector('meta[name="offlineseal-instance"]').content;
      const base = { protocol, instance };
      const messages = [
        { ...base, type: 'fetch-url', url: `${target}/msg-fetch-url` },
        { ...base, type: 'open-url', url: `${target}/msg-open-url` },
        { ...base, type: 'send-request', endpoint: `${target}/msg-endpoint`, request: { method: 'POST', body: 'benign' } },
        { ...base, type: 'proxy-request', url: `${target}/msg-proxy`, payload: 'benign' },
        { ...base, type: 'run-script', payload: `fetch('${target}/msg-run-script')` },
        { ...base, type: 'eval', payload: `location.href='${target}/msg-eval'` },
        { ...base, type: 'fetch', fetch: `${target}/msg-fetch` },
        { ...base, type: 'upload', endpoint: `${target}/msg-upload`, payload: 'benign' },
        { type: 'fetch-url', url: `${target}/msg-no-protocol` },
        `fetch ${target}/msg-string`,
        ['fetch-url', `${target}/msg-array`],
        { ...base, type: 'frame-ready', url: `${target}/msg-extra-field` },
        { ...base, type: 'processing-complete' }, // valid type, but out of order in `ready`
        { ...base, instance: 'not-this-frame', type: 'file-selected' },
        { ...base, type: 'processing-failed', code: `${target}/msg-code` },
        { ...base, type: 'seal-failed', code: 'not-a-real-code', endpoint: `${target}/msg-seal` },
      ];
      for (const m of messages) window.parent.postMessage(m, '*');
      return messages.length;
    },
    { protocol: PROTOCOL_ID, target: probe.origin },
  );
  await sleep(1000);

  const after = await shellSnapshot(env.page);
  assert.deepEqual(after, before, 'the shell changed in response to rejected messages');
  assert.match(await env.page.textContent('#tech-messages'), new RegExp(`^1 accepted · ${sent} ignored$`));
  const warnings = env.consoleMessages.filter((m) => m.text.includes('[OfflineSeal] Ignored')).length - warningsStart;
  assert.equal(warnings, sent);
  assert.deepEqual(probe.log, [], 'probe server was contacted');
  assert.equal(probe.counts.tcp, 0);
  assert.deepEqual(app.log.slice(appLogStart), [], 'app server was contacted');
  assert.equal(env.context.pages().length, 1, 'a window was opened');
  assert.equal(await env.frame.evaluate(() => window.__fromShell), 0, 'the shell sent the frame a message');
  t.diagnostic(`rejection reasons: ${[...new Set(env.consoleMessages.filter((m) => m.text.includes('Ignored')).map((m) => m.text))].join(' | ')}`);

  // The tool still works normally afterwards.
  await chooseImage(env, syntheticPng({ width: 64, height: 48 }));
  await convertTo(env, 'image/png');
  assert.equal(await env.frame.evaluate(() => window.__fromShell), 0);
  await env.context.close();
});

test('messages not sent by the active sealed frame are ignored, even if well-formed', async () => {
  const env = await readyTool(browser, app);
  const instance = await env.page.textContent('#tech-instance');
  // The shell posting to itself: correct shape and instance id, wrong source and origin.
  await env.page.evaluate(
    ({ protocol, instance }) => {
      window.postMessage({ protocol, instance, type: 'file-selected' }, '*');
    },
    { protocol: PROTOCOL_ID, instance },
  );
  // Another site's window that opens OfflineSeal cannot talk to it either:
  // COOP severs the opener relationship, so there is no window handle to post to.
  const opener = await env.context.newPage();
  await opener.goto(`${probe.origin}/control-page`);
  const [popup] = await Promise.all([
    env.context.waitForEvent('page'),
    opener.evaluate((url) => {
      window.__w = window.open(url);
    }, `${app.origin}/image`),
  ]);
  await popup.waitForSelector('body[data-state="ready"]');
  const openerHandle = await opener.evaluate(() => (window.__w && window.__w.closed === false ? 'has live handle' : 'severed'));
  const popupOpener = await popup.evaluate(() => window.opener === null);
  await sleep(300);
  assert.equal(await env.page.getAttribute('body', 'data-state'), 'ready');
  assert.match(await env.page.textContent('#tech-messages'), /^1 accepted · 1 ignored$/);
  assert.equal(openerHandle, 'severed', 'COOP: opener has no handle to OfflineSeal');
  assert.equal(popupOpener, true, 'COOP: OfflineSeal has no opener');
  await env.context.close();
});
