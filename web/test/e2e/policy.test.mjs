// Runtime policy verification: reads the policies from the live browser (the
// rendered DOM, the enforced response headers, what the frame reports about
// itself). Checking source constants alone would not show what is enforced.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { parseCsp, FORBIDDEN_SANDBOX_TOKENS } from '../../src/policy.mjs';
import { launchBrowser, startApp, startProbe, readyTool } from '../helpers/harness.mjs';

let browser, app, probe, env;
before(async () => {
  browser = await launchBrowser();
  app = await startApp();
  probe = await startProbe();
  env = await readyTool(browser, app);
});
after(async () => {
  await env?.context.close();
  await browser?.close();
  await app?.close();
  await probe?.close();
});

const BROAD = /^(\*|https?:|wss?:|data:|blob:|filesystem:|'unsafe-inline'|'unsafe-eval'|'unsafe-hashes'|'wasm-unsafe-eval'|'strict-dynamic')$/i;

test('live iframe sandbox: allow-scripts + allow-downloads only', async () => {
  const live = await env.page.$eval('#frame-host iframe', (f) => ({
    attr: f.getAttribute('sandbox'),
    tokens: [...f.sandbox],
    hasSrc: f.hasAttribute('src'),
    srcdocLength: f.srcdoc.length,
    count: document.querySelectorAll('iframe').length,
  }));
  assert.equal(live.count, 1);
  assert.equal(live.hasSrc, false, 'frame is srcdoc-only');
  assert.ok(live.srcdocLength > 1000);
  assert.deepEqual(live.tokens.sort(), ['allow-downloads', 'allow-scripts']);
  for (const t of FORBIDDEN_SANDBOX_TOKENS) assert.ok(!live.tokens.includes(t), t);
});

test('frame has an opaque origin and cannot reach the shell', async () => {
  const facts = await env.frame.evaluate(() => {
    const probe = (fn) => {
      try {
        fn();
        return 'reachable';
      } catch (e) {
        return e.name;
      }
    };
    return {
      origin: self.origin,
      url: location.href,
      parentDocument: probe(() => window.parent.document.title),
      parentLocation: probe(() => window.parent.location.href),
      topLocationWrite: probe(() => {
        window.top.location.href = 'about:blank#nope';
      }),
      cookie: probe(() => document.cookie),
      localStorage: probe(() => window.localStorage.length),
      rtc: typeof window.RTCPeerConnection,
      webkitRtc: typeof window.webkitRTCPeerConnection,
    };
  });
  assert.equal(facts.origin, 'null');
  assert.equal(facts.url, 'about:srcdoc');
  assert.equal(facts.parentDocument, 'SecurityError');
  assert.equal(facts.parentLocation, 'SecurityError');
  assert.equal(facts.topLocationWrite, 'SecurityError', 'sandbox blocks top navigation');
  assert.equal(facts.cookie, 'SecurityError');
  assert.equal(facts.localStorage, 'SecurityError');
  assert.equal(facts.rtc, 'undefined');
  assert.equal(facts.webkitRtc, 'undefined');
  assert.equal(env.page.url(), `${app.origin}/image`);
});

test('frame CSP as enforced in the live document', async () => {
  const policy = await env.frame.evaluate(() => document.querySelector('meta[http-equiv="Content-Security-Policy"]').content);
  const csp = parseCsp(policy);
  for (const d of ['default-src', 'connect-src', 'form-action', 'object-src', 'frame-src', 'child-src', 'worker-src', 'base-uri', 'font-src', 'manifest-src', 'media-src', 'img-src']) {
    assert.deepEqual(csp.get(d), ["'none'"], d);
  }
  assert.equal(csp.get('script-src').length, 1);
  assert.match(csp.get('script-src')[0], /^'sha256-/);
  assert.match(csp.get('style-src')[0], /^'sha256-/);
  for (const [, values] of csp) for (const v of values) assert.doesNotMatch(v, BROAD);
  // The shell's "Technical details" shows the same policy that is enforced.
  assert.equal(await env.page.textContent('#tech-frame-csp'), policy);
  // The policy is live: a blocked data: fetch raises a violation event of *this* policy.
  const violation = await env.frame.evaluate(
    () =>
      new Promise((resolve) => {
        document.addEventListener('securitypolicyviolation', (e) => {
          if (/connect-src 'none'/.test(e.originalPolicy)) resolve(e.effectiveDirective);
        });
        fetch('data:,runtime-check').catch(() => {});
      }),
  );
  assert.equal(violation, 'connect-src');
});

test('frame CSP + Trusted Types block injected scripts and HTML-string sinks', async () => {
  const results = await env.frame.evaluate(() => {
    const out = {};
    const s = document.createElement('script');
    try {
      s.textContent = 'window.__injected = 1';
      document.body.append(s);
      out.inline = window.__injected === 1 ? 'ran' : 'blocked';
    } catch (e) {
      out.inline = e.name;
    }
    try {
      document.body.insertAdjacentHTML('beforeend', '<b>x</b>');
      out.html = 'allowed';
    } catch (e) {
      out.html = e.name;
    }
    return out;
  });
  assert.notEqual(results.inline, 'ran');
  assert.equal(results.html, 'TypeError', 'Trusted Types blocks HTML string sinks');
});

test('shell response headers as sent to the browser', async () => {
  const headers = env.response.headers();
  const csp = parseCsp(headers['content-security-policy']);
  assert.deepEqual(csp.get('default-src'), ["'none'"]);
  assert.deepEqual(csp.get('connect-src'), ["'self'"]);
  assert.deepEqual(csp.get('frame-src'), ["'none'"]);
  assert.deepEqual(csp.get('form-action'), ["'none'"]);
  assert.deepEqual(csp.get('object-src'), ["'none'"]);
  assert.deepEqual(csp.get('frame-ancestors'), ["'none'"]);
  for (const [name, values] of csp) for (const v of values) assert.doesNotMatch(v, BROAD, name);
  assert.equal(headers['referrer-policy'], 'no-referrer');
  assert.equal(headers['x-content-type-options'], 'nosniff');
  assert.equal(headers['x-frame-options'], 'DENY');
  assert.equal(headers['cross-origin-opener-policy'], 'same-origin');
  assert.equal(headers['cross-origin-resource-policy'], 'same-origin');
  assert.match(headers['permissions-policy'], /camera=\(\)/);
  // The meta copy in the page matches the header, minus frame-ancestors.
  const meta = parseCsp(await env.page.$eval('meta[http-equiv="Content-Security-Policy"]', (m) => m.content));
  csp.delete('frame-ancestors');
  assert.deepEqual([...meta], [...csp]);
});

test('Permissions-Policy: every listed feature is recognised and disabled, in shell and frame', async () => {
  const unrecognised = env.consoleMessages.filter((m) => /Permissions-Policy|Unrecognized feature/i.test(m.text));
  assert.deepEqual(unrecognised, []);
  const header = env.response.headers()['permissions-policy'];
  const features = header.split(',').map((f) => f.trim().replace(/=\(\)$/, ''));
  const shellAllowed = await env.page.evaluate(() => document.featurePolicy.allowedFeatures());
  const frameAllowed = await env.frame.evaluate(() => document.featurePolicy.allowedFeatures());
  for (const f of features) {
    assert.ok(!shellAllowed.includes(f), `shell allows ${f}`);
    assert.ok(!frameAllowed.includes(f), `frame allows ${f}`);
  }
  for (const f of ['camera', 'microphone', 'geolocation', 'payment', 'usb', 'serial', 'hid', 'clipboard-read', 'clipboard-write']) {
    assert.ok(features.includes(f), f);
  }
});

test('frame-ancestors: another site cannot embed OfflineSeal Web', async () => {
  const page = await env.context.newPage();
  const blocked = [];
  page.on('console', (m) => /frame-ancestors|X-Frame-Options/i.test(m.text()) && blocked.push(m.text()));
  await page.goto(`${probe.origin}/control-page`);
  await page.evaluate((src) => {
    const f = document.createElement('iframe');
    f.src = src;
    document.body.append(f);
  }, `${app.origin}/image`);
  await page.waitForTimeout(1000);
  const child = page.frames().find((f) => f !== page.mainFrame());
  // Chromium replaces a refused frame with an error document.
  assert.ok(!child || child.url() !== `${app.origin}/image` || blocked.length > 0);
  assert.ok(blocked.length > 0, 'browser reported the frame-ancestors refusal');
  await page.close();
});
