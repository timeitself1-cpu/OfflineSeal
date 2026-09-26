// Benign network-policy probes.
//
// From inside the live sealed frame, try every network channel we know of,
// carrying only the fixed string BENIGN (never file data). Targets are a
// cross-origin probe server and the app server's /__test_should_not_be_reached/
// endpoints. Pass condition: neither server sees a single request, TCP
// connection, WebSocket upgrade or UDP packet from the frame.
//
// Positive controls prove the detectors work: an ordinary page (no OfflineSeal
// policy) *can* reach the probe server over HTTP, TCP and UDP, and the shell
// itself *can* reach its own origin.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { BROWSER, launchBrowser, startApp, startProbe, openTool, readyTool, sealedFrame, waitForShellState, sleep, PROBE_PREFIX, FRAME_INSTRUMENTATION, trackWorkers, setHold, release, workerNamed, allClosed } from '../helpers/harness.mjs';
import { syntheticPng } from '../helpers/synthetic-image.mjs';

const BENIGN = 'offlineseal-benign-probe';

let browser, app, probe, env;
before(async () => {
  browser = await launchBrowser();
  app = await startApp();
  probe = await startProbe();
});
after(async () => {
  await env?.context.close();
  await browser?.close();
  await app?.close();
  await probe?.close();
});

const probeRequestsToApp = () => app.log.filter((e) => e.path.startsWith(PROBE_PREFIX));

test('positive control: an unsealed page can reach the probe server (HTTP, TCP, UDP)', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${probe.origin}/control-page`);
  const result = await page.evaluate(async ({ origin, udpPort, BENIGN }) => {
    await fetch(`${origin}/control-fetch?${BENIGN}`);
    const pc = new RTCPeerConnection({ iceServers: [{ urls: `stun:127.0.0.1:${udpPort}` }] });
    pc.createDataChannel(BENIGN);
    await pc.setLocalDescription(await pc.createOffer());
    await new Promise((r) => setTimeout(r, 2000));
    pc.close();
    return 'done';
  }, { origin: probe.origin, udpPort: probe.udpPort, BENIGN });
  assert.equal(result, 'done');
  assert.ok(probe.log.some((e) => e.url.startsWith('/control-fetch')), 'probe saw the control fetch');
  assert.ok(probe.counts.tcp > 0, 'probe saw TCP connections');
  assert.ok(probe.counts.udp > 0, 'probe saw STUN packets from WebRTC in an unsealed page');
  await context.close();
  probe.reset();
});

test('sealed frame: every benign network probe is blocked', async (t) => {
  env = await readyTool(browser, app);
  const frame = env.frame;
  probe.reset();
  const appLogStart = app.log.length;

  await frame.evaluate(() => {
    window.__violations = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__violations.push(`${e.effectiveDirective} ${e.blockedURI}`));
  });

  const P = probe.origin;
  const S = `${app.origin}${PROBE_PREFIX}`;
  // Each probe returns a short description of what the browser did. Probes
  // that could navigate the frame run separately below, each in a fresh frame,
  // because the shell tears the frame down as soon as it navigates.
  const probes = {
    fetchCrossOrigin: `fetch('${P}/frame-fetch?${BENIGN}').then(() => 'reached', (e) => 'rejected')`,
    fetchSameOrigin: `fetch('${S}frame-fetch?${BENIGN}').then(() => 'reached', (e) => 'rejected')`,
    fetchPost: `fetch('${P}/frame-post', { method: 'POST', body: '${BENIGN}' }).then(() => 'reached', () => 'rejected')`,
    fetchKeepalive: `fetch('${P}/frame-keepalive', { method: 'POST', body: '${BENIGN}', keepalive: true }).then(() => 'reached', () => 'rejected')`,
    xhr: `new Promise((r) => { try { const x = new XMLHttpRequest(); x.open('POST', '${P}/frame-xhr'); x.onload = () => r('reached'); x.onerror = () => r('error'); x.send('${BENIGN}'); } catch (e) { r('threw ' + e.name); } })`,
    sendBeacon: `(() => { try { return 'queued=' + navigator.sendBeacon('${P}/frame-beacon', '${BENIGN}'); } catch (e) { return 'threw ' + e.name; } })()`,
    webSocket: `new Promise((r) => { try { const w = new WebSocket('${probe.wsOrigin}/frame-ws'); w.onopen = () => r('open'); w.onerror = () => r('error'); } catch (e) { r('threw ' + e.name); } })`,
    eventSource: `new Promise((r) => { try { const s = new EventSource('${P}/frame-sse'); s.onopen = () => r('open'); s.onerror = () => { s.close(); r('error'); }; } catch (e) { r('threw ' + e.name); } })`,
    // WebTransport is QUIC over UDP: aimed at the UDP probe port, so any packet that escaped would be counted.
    webTransport: `(async () => { try { const w = new WebTransport('https://127.0.0.1:${probe.udpPort}/frame-wt'); return await w.ready.then(() => 'connected', (e) => 'rejected ' + e.name); } catch (e) { return 'threw ' + e.name; } })()`,
    imageObject: `new Promise((r) => { const i = new Image(); i.onload = () => r('loaded'); i.onerror = () => r('error'); i.src = '${P}/frame-image?${BENIGN}'; })`,
    imageElement: `new Promise((r) => { const i = document.createElement('img'); i.onload = () => r('loaded'); i.onerror = () => r('error'); i.src = '${S}image?${BENIGN}'; document.body.append(i); })`,
    svgImage: `(() => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); const i = document.createElementNS('http://www.w3.org/2000/svg', 'image'); i.setAttribute('href', '${P}/frame-svg-image'); s.append(i); document.body.append(s); return 'inserted'; })()`,
    cssBackground: `(() => { const d = document.createElement('div'); d.style.backgroundImage = 'url(${P}/frame-css-bg)'; document.body.append(d); getComputedStyle(d).backgroundImage; return 'set'; })()`,
    cssImportRule: `(() => { try { document.styleSheets[0].insertRule('@import url(${P}/frame-css-import);', 0); return 'inserted'; } catch (e) { return 'threw ' + e.name; } })()`,
    fontFace: `new FontFace('probe', 'url(${P}/frame-font)').load().then(() => 'loaded', () => 'rejected')`,
    stylesheetLink: `new Promise((r) => { const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = '${S}stylesheet'; l.onload = () => r('loaded'); l.onerror = () => r('error'); document.head.append(l); setTimeout(() => r('no event'), 1000); })`,
    prefetchLinks: `(() => { for (const rel of ['prefetch', 'preload', 'modulepreload', 'preconnect', 'dns-prefetch']) { const l = document.createElement('link'); l.rel = rel; l.as = 'fetch'; l.href = '${P}/frame-link-' + rel; document.head.append(l); } return 'inserted'; })()`,
    scriptSrc: `(() => { try { const s = document.createElement('script'); s.src = '${P}/frame-script'; document.head.append(s); return 'inserted'; } catch (e) { return 'threw ' + e.name; } })()`,
    objectData: `(() => { try { const o = document.createElement('object'); o.data = '${P}/frame-object'; document.body.append(o); return 'inserted'; } catch (e) { return 'threw ' + e.name; } })()`,
    embedSrc: `(() => { try { const e = document.createElement('embed'); e.src = '${P}/frame-embed'; document.body.append(e); return 'inserted'; } catch (e) { return 'threw ' + e.name; } })()`,
    worker: `(() => { try { new Worker('${P}/frame-worker'); return 'constructed'; } catch (e) { return 'threw ' + e.name; } })()`,
    // Worker from a blob: URL the frame did not mint from the pinned Worker
    // code: worker-src allows blob:, but Trusted Types refuses this URL.
    workerForeignBlob: `(() => { try { new Worker(URL.createObjectURL(new Blob(['fetch("${P}/frame-foreign-blob-worker")']))); return 'constructed'; } catch (e) { return 'threw ' + e.name; } })()`,
    sharedWorker: `(() => { try { new SharedWorker('${P}/frame-shared-worker'); return 'constructed'; } catch (e) { return 'threw ' + e.name; } })()`,
    serviceWorker: `(() => { try { return navigator.serviceWorker ? 'available' : 'unavailable'; } catch (e) { return 'threw ' + e.name; } })()`,
    audio: `new Promise((r) => { const a = new Audio(); a.onerror = () => r('error'); a.src = '${P}/frame-audio'; a.load(); setTimeout(() => r('no event'), 1000); })`,
    videoPoster: `(() => { const v = document.createElement('video'); v.poster = '${P}/frame-poster'; document.body.append(v); return 'inserted'; })()`,
    windowOpen: `(() => { const w = window.open('${P}/frame-popup?${BENIGN}'); return w === null ? 'blocked' : 'opened'; })()`,
    topNavigation: `(() => { try { window.top.location.href = '${P}/frame-top?${BENIGN}'; return 'assigned'; } catch (e) { return 'threw ' + e.name; } })()`,
    webRtc: `(async () => { if (typeof RTCPeerConnection === 'undefined' && typeof webkitRTCPeerConnection === 'undefined') return 'unavailable'; return 'available'; })()`,
    webRtcViaNestedFrame: `(() => { try { const f = document.createElement('iframe'); document.body.append(f); const C = f.contentWindow.RTCPeerConnection; if (!C) return 'unavailable'; new C({ iceServers: [{ urls: 'stun:127.0.0.1:${probe.udpPort}' }] }); return 'constructed'; } catch (e) { return 'threw ' + e.name; } })()`,
    nestedSrcdoc: `(() => { try { const f = document.createElement('iframe'); f.srcdoc = '<img src="${P}/frame-nested-srcdoc">'; document.body.append(f); return 'inserted'; } catch (e) { return 'threw ' + e.name; } })()`,
  };

  const results = {};
  for (const [name, code] of Object.entries(probes)) {
    try {
      results[name] = await frame.evaluate(code);
    } catch (e) {
      results[name] = `evaluate failed: ${e.message.split('\n')[0]}`;
    }
  }
  // Give any request the browser might still be scheduling time to arrive.
  await sleep(2500);

  const violations = await frame.evaluate(() => window.__violations);
  t.diagnostic(`probe results: ${JSON.stringify(results)}`);
  t.diagnostic(`CSP violation events in frame: ${violations.length}`);

  // The frame must still be the same sealed document (no probe navigated it).
  assert.equal(await frame.evaluate(() => location.href), 'about:srcdoc');
  assert.equal(env.page.url(), `${app.origin}/image`);
  assert.equal(env.context.pages().length, 1, 'no popup was opened');

  // The pass condition: nothing reached either server.
  assert.deepEqual(probe.log, [], 'cross-origin probe server received requests');
  assert.equal(probe.counts.tcp, 0, 'cross-origin probe server saw TCP connections');
  assert.equal(probe.counts.upgrades, 0, 'cross-origin probe server saw WebSocket upgrades');
  assert.equal(probe.counts.udp, 0, 'probe saw UDP (STUN) packets');
  assert.deepEqual(probeRequestsToApp(), [], 'app server test endpoints were reached');
  assert.deepEqual(app.log.slice(appLogStart), [], 'app server received any request during probing');

  // Channel-specific expectations, so a silent behaviour change is noticed.
  assert.equal(results.fetchCrossOrigin, 'rejected');
  assert.equal(results.fetchSameOrigin, 'rejected');
  assert.equal(results.windowOpen, 'blocked');
  assert.match(results.topNavigation, /threw SecurityError/);
  assert.equal(results.webRtc, 'unavailable');
  assert.match(results.webRtcViaNestedFrame, /threw SecurityError|unavailable/);
  assert.match(results.nestedSrcdoc, /threw TypeError/, 'Trusted Types blocks nested srcdoc');
  assert.match(results.scriptSrc, /threw TypeError/, 'Trusted Types blocks script URLs');
  assert.match(results.worker, /threw/);
  assert.match(results.workerForeignBlob, /threw TypeError/, 'only the pinned Worker code can start');
  assert.ok(violations.some((v) => v.startsWith('connect-src')));
  assert.ok(violations.some((v) => v.startsWith('img-src')));
});

// Probes that submit forms, follow links or navigate a frame. Each runs in its
// own fresh frame.
//
// Known browser difference, pinned exactly: Microsoft Edge 154 opens a TCP
// connection (so also resolves the host name) to the target of a frame
// navigation *before* CSP frame-src blocks it. It does this for a nested
// <iframe src>, meta refresh and self-navigation. No HTTP request is sent.
// Chromium 141 opens no connection. So in Edge, code running in the *frame*
// could signal a chosen host name. Code in the processing Worker cannot: a
// Worker has no DOM and cannot navigate or create frames. The Worker probe
// test below requires zero connections in every browser.
const EDGE_NAVIGATION_PRECONNECT = new Set(['iframeSrc', 'metaRefresh', 'selfNavigation']);
const allowedConnections = (name) => (BROWSER === 'msedge' && EDGE_NAVIGATION_PRECONNECT.has(name) ? 1 : 0);
const navigationProbes = () => ({
    iframeSrc: `(() => { const f = document.createElement('iframe'); f.src = '${probe.origin}/frame-iframe'; document.body.append(f); return 'inserted'; })()`,
    formGet: `(() => { const f = document.createElement('form'); f.action = '${probe.origin}/frame-form-get'; f.method = 'GET'; const i = document.createElement('input'); i.name = 'probe'; i.value = '${BENIGN}'; f.append(i); document.body.append(f); f.submit(); return 'submitted'; })()`,
    formPost: `(() => { const f = document.createElement('form'); f.action = '${app.origin}${PROBE_PREFIX}form'; f.method = 'POST'; document.body.append(f); f.requestSubmit(); return 'submitted'; })()`,
    anchorTargetTop: `(() => { const a = document.createElement('a'); a.href = '${probe.origin}/frame-anchor-top'; a.target = '_top'; document.body.append(a); a.click(); return 'clicked'; })()`,
    anchorTargetBlank: `(() => { const a = document.createElement('a'); a.href = '${probe.origin}/frame-anchor-blank'; a.target = '_blank'; document.body.append(a); a.click(); return 'clicked'; })()`,
    metaRefresh: `(() => { const m = document.createElement('meta'); m.httpEquiv = 'refresh'; m.content = '0;url=${probe.origin}/frame-meta-refresh'; document.head.append(m); return 'inserted'; })()`,
});

test('sealed frame: form, link and refresh probes are blocked', async (t) => {
  for (const [name, code] of Object.entries(navigationProbes())) {
    probe.reset();
    const envProbe = await readyTool(browser, app);
    const appLogStart = app.log.length;
    let result;
    try {
      result = await envProbe.frame.evaluate(code);
    } catch (e) {
      result = `evaluate failed: ${e.message.split('\n')[0]}`;
    }
    await sleep(1500);
    const shellState = await envProbe.page.getAttribute('body', 'data-state');
    t.diagnostic(`${name}: ${result}; shell state afterwards: ${shellState}`);
    assert.deepEqual(probe.log, [], `${name}: probe server received requests`);
    assert.equal(probe.counts.upgrades, 0, `${name}: WebSocket upgrade`);
    assert.ok(probe.counts.tcp <= allowedConnections(name), `${name}: probe server saw ${probe.counts.tcp} TCP connections`);
    if (probe.counts.tcp) t.diagnostic(`${name}: ${probe.counts.tcp} connection-only TCP open (known ${BROWSER} behaviour, no HTTP request)`);
    assert.deepEqual(app.log.slice(appLogStart), [], `${name}: app server received requests`);
    assert.equal(envProbe.context.pages().length, 1, `${name}: no popup`);
    assert.equal(envProbe.page.url(), `${app.origin}/image`, `${name}: tab not navigated`);
    // Either the browser refused outright (frame untouched), or the frame's
    // navigation was blocked and the shell shut the frame down (fail closed).
    assert.ok(['ready', 'fatal'].includes(shellState), `${name}: shell state ${shellState}`);
    await envProbe.context.close();
  }
});

test('sealed frame cannot navigate itself to exfiltrate, and the shell shuts it down', async () => {
  probe.reset();
  const envNav = await readyTool(browser, app);
  const appLogStart = app.log.length;
  const frame = envNav.frame;
  // Cross-origin, then same-origin: both must be blocked by the shell's
  // frame-src 'none', which governs navigations of the child frame.
  await frame.evaluate((url) => { location.href = url; }, `${probe.origin}/frame-self-navigation?${BENIGN}`).catch(() => {});
  await waitForShellState(envNav.page, 'fatal');
  assert.match(await envNav.page.textContent('#fatal-text'), /tried to navigate away/);
  assert.equal(await envNav.page.locator('#frame-host iframe').count(), 0, 'frame removed');
  await sleep(1000);
  assert.deepEqual(probe.log, [], 'no HTTP request reached the target');
  assert.ok(probe.counts.tcp <= allowedConnections('selfNavigation'), `${probe.counts.tcp} TCP connections`);
  assert.deepEqual(app.log.slice(appLogStart), []);
  await envNav.context.close();

  const envSame = await readyTool(browser, app);
  const start2 = app.log.length;
  await envSame.frame.evaluate((url) => { location.href = url; }, `${app.origin}${PROBE_PREFIX}self-navigation?${BENIGN}`).catch(() => {});
  await waitForShellState(envSame.page, 'fatal');
  await sleep(1000);
  assert.deepEqual(app.log.slice(start2), [], 'same-origin self-navigation was not sent either');
  await envSame.context.close();
});

test('outer page stays online, but that grants the frame nothing', async () => {
  const envOnline = await readyTool(browser, app);
  // The shell can reach its own origin: it is online.
  const status = await envOnline.page.evaluate((path) => fetch(path).then((r) => r.status), `${PROBE_PREFIX}shell-positive-control`);
  assert.equal(status, 200);
  assert.ok(app.log.some((e) => e.path === `${PROBE_PREFIX}shell-positive-control`));
  // The same request from the frame, at the same moment, is refused.
  const before = app.log.length;
  const fromFrame = await sealedFrame(envOnline.page).evaluate((url) => fetch(url).then(() => 'reached', () => 'rejected'), `${app.origin}${PROBE_PREFIX}frame-while-shell-online`);
  await sleep(500);
  assert.equal(fromFrame, 'rejected');
  assert.deepEqual(app.log.slice(before), []);
  // There is no relay: the shell's code is ES modules and adds no globals
  // compared with the script-free landing page on the same origin, so there is
  // nothing the frame could call. (The frame cannot reach the shell's realm
  // anyway; the message vocabulary is covered by messages.test.mjs.)
  const landing = await envOnline.context.newPage();
  await landing.goto(`${app.origin}/`);
  const baseline = new Set(await landing.evaluate(() => Object.getOwnPropertyNames(window)));
  await landing.close();
  const added = await envOnline.page.evaluate(() => Object.getOwnPropertyNames(window));
  // '0' is the index of the sealed frame's WindowProxy.
  assert.deepEqual(added.filter((k) => !baseline.has(k) && k !== '__offlinesealAudit' && k !== '0'), []);
  await envOnline.context.close();
});

test('processing Worker: every benign network probe is blocked, while it holds the file', async (t) => {
  probe.reset();
  let track;
  const envW = await openTool(browser, app, { initScripts: [FRAME_INSTRUMENTATION], beforeGoto: (page) => { track = trackWorkers(page); } });
  await waitForShellState(envW.page, 'ready');
  const frame = sealedFrame(envW.page);
  await setHold(frame, true);
  await frame.setInputFiles('#file', { name: 'probe.png', mimeType: 'image/png', buffer: syntheticPng({ width: 64, height: 48 }) });
  const live = await workerNamed(track, 'offlineseal-inspect');
  const appLogStart = app.log.length;

  const P = probe.origin;
  const S = `${app.origin}${PROBE_PREFIX}`;
  const results = await live.worker.evaluate(
    async ({ P, S, ws, udpPort, BENIGN }) => {
      const out = {};
      const attempt = async (name, fn) => {
        try {
          out[name] = await fn();
        } catch (e) {
          out[name] = 'threw ' + e.name;
        }
      };
      self.__violations = [];
      self.addEventListener('securitypolicyviolation', (e) => self.__violations.push(e.effectiveDirective));
      await attempt('fetchCrossOrigin', () => fetch(`${P}/worker-fetch?${BENIGN}`).then(() => 'reached', () => 'rejected'));
      await attempt('fetchSameOrigin', () => fetch(`${S}worker-fetch?${BENIGN}`).then(() => 'reached', () => 'rejected'));
      await attempt('fetchPost', () => fetch(`${P}/worker-post`, { method: 'POST', body: BENIGN }).then(() => 'reached', () => 'rejected'));
      await attempt('fetchKeepalive', () => fetch(`${P}/worker-keepalive`, { method: 'POST', body: BENIGN, keepalive: true }).then(() => 'reached', () => 'rejected'));
      await attempt('xhr', () => new Promise((r) => { const x = new XMLHttpRequest(); x.open('POST', `${P}/worker-xhr`); x.onload = () => r('reached'); x.onerror = () => r('error'); x.send(BENIGN); }));
      await attempt('webSocket', () => new Promise((r) => { const w = new WebSocket(`${ws}/worker-ws`); w.onopen = () => r('open'); w.onerror = () => r('error'); }));
      await attempt('eventSource', () => new Promise((r) => { const e = new EventSource(`${P}/worker-sse`); e.onopen = () => r('open'); e.onerror = () => { e.close(); r('error'); }; }));
      await attempt('webTransport', async () => { const w = new WebTransport(`https://127.0.0.1:${udpPort}/worker-wt`); return w.ready.then(() => 'connected', (e) => 'rejected ' + e.name); });
      await attempt('importScripts', () => { importScripts(`${P}/worker-import`); return 'imported'; });
      await attempt('nestedWorkerUrl', () => { new Worker(`${P}/worker-nested`); return 'constructed'; });
      await attempt('nestedWorkerBlob', () => { new Worker(URL.createObjectURL(new Blob(['postMessage(1)']))); return 'constructed'; });
      await attempt('eval', () => String(eval('1 + 1')));
      await attempt('newFunction', () => String(new Function('return 2')()));
      await attempt('dynamicImport', () => import(`${P}/worker-module.js`).then(() => 'imported', (e) => 'rejected ' + e.name));
      await attempt('fontFace', () => (self.FontFace ? new FontFace('p', `url(${P}/worker-font)`).load().then(() => 'loaded', () => 'rejected') : 'unavailable'));
      await attempt('webRtc', () => (typeof RTCPeerConnection === 'undefined' && typeof webkitRTCPeerConnection === 'undefined' ? 'unavailable' : 'available'));
      await attempt('sendBeacon', () => (self.navigator.sendBeacon ? 'available' : 'unavailable'));
      await attempt('indexedDB', () => { indexedDB.open('probe'); return 'opened'; });
      await attempt('caches', () => typeof caches);
      await new Promise((r) => setTimeout(r, 1500));
      out.violations = [...new Set(self.__violations)].sort();
      return out;
    },
    { P, S, ws: probe.wsOrigin, udpPort: probe.udpPort, BENIGN },
  );
  await sleep(1000);
  t.diagnostic(`worker probe results: ${JSON.stringify(results)}`);

  assert.deepEqual(probe.log, [], 'probe server received requests from the Worker');
  assert.equal(probe.counts.tcp, 0);
  assert.equal(probe.counts.upgrades, 0);
  assert.equal(probe.counts.udp, 0);
  assert.deepEqual(app.log.slice(appLogStart), [], 'app server received requests from the Worker');
  for (const k of ['fetchCrossOrigin', 'fetchSameOrigin', 'fetchPost', 'fetchKeepalive']) assert.equal(results[k], 'rejected', k);
  assert.equal(results.xhr, 'error');
  assert.equal(results.webSocket, 'error');
  assert.equal(results.eventSource, 'error');
  assert.match(results.importScripts, /threw TypeError/, 'Trusted Types blocks importScripts');
  assert.match(results.nestedWorkerUrl, /threw TypeError/);
  assert.match(results.nestedWorkerBlob, /threw TypeError/, 'only the frame\'s policy can mint a Worker URL');
  assert.match(results.eval, /threw EvalError/);
  assert.match(results.newFunction, /threw EvalError/);
  assert.equal(results.webRtc, 'unavailable', 'no RTCPeerConnection in a Worker');
  assert.equal(results.sendBeacon, 'unavailable');
  assert.equal(results.indexedDB, 'threw SecurityError');
  assert.equal(results.caches, 'undefined');
  assert.ok(results.violations.includes('connect-src'));

  await release(frame);
  await waitForShellState(envW.page, 'file-selected');
  await allClosed(track);
  await envW.context.close();
});
