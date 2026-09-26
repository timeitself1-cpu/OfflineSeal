import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SEALED_FRAME_SANDBOX,
  FORBIDDEN_SANDBOX_TOKENS,
  sealedFrameCsp,
  shellCsp,
  parseCsp,
  permissionsPolicy,
  siteHeaders,
} from '../../src/policy.mjs';

const hashes = { scriptHash: 'AAAA', styleHash: 'BBBB' };

// Any of these in a source list would open a network path or weaken script
// integrity.
const BROAD = /^(\*|https?:|wss?:|data:|blob:|filesystem:|'unsafe-inline'|'unsafe-eval'|'unsafe-hashes'|'wasm-unsafe-eval'|'strict-dynamic'|'inline-speculation-rules')$/i;
const isKeywordOrHash = (v) => /^'(none|self|sha256-[A-Za-z0-9+/=]+|script)'$/.test(v);
// The single deliberate exception: blob: Workers (the frame's processing
// Workers). It is allowed in worker-src and nowhere else.
const allowedException = (directive, value) => directive === 'worker-src' && value === 'blob:';

test('sandbox is exactly allow-scripts + allow-downloads', () => {
  assert.deepEqual([...SEALED_FRAME_SANDBOX].sort(), ['allow-downloads', 'allow-scripts']);
  for (const t of FORBIDDEN_SANDBOX_TOKENS) assert.ok(!SEALED_FRAME_SANDBOX.includes(t), t);
});

test('sealed frame CSP denies every network-capable fetch directive', () => {
  const csp = parseCsp(sealedFrameCsp(hashes));
  for (const d of ['default-src', 'connect-src', 'form-action', 'object-src', 'frame-src', 'child-src', 'base-uri', 'font-src', 'manifest-src', 'media-src', 'img-src']) {
    assert.deepEqual(csp.get(d), ["'none'"], d);
  }
  assert.deepEqual(csp.get('worker-src'), ['blob:'], 'Workers only from blob: URLs');
  assert.deepEqual(csp.get('script-src'), ["'sha256-AAAA'"]);
  assert.deepEqual(csp.get('style-src'), ["'sha256-BBBB'"]);
  assert.deepEqual(csp.get('require-trusted-types-for'), ["'script'"]);
  assert.deepEqual(csp.get('trusted-types'), ['offlineseal-worker-script'], 'one policy name: the Worker URL policy');
});

test('no CSP contains broad or host-based allowances', () => {
  for (const policy of [sealedFrameCsp(hashes), shellCsp(hashes), shellCsp(hashes, { forHeader: false })]) {
    for (const [name, values] of parseCsp(policy)) {
      for (const v of values) {
        if (allowedException(name, v)) continue;
        assert.ok(!BROAD.test(v), `${name} ${v}`);
        if (name !== 'trusted-types') assert.ok(isKeywordOrHash(v), `${name} contains a non-keyword source ${v}`);
      }
    }
  }
});

test('shell CSP: same-origin only, frame navigation blocked, not embeddable', () => {
  const header = parseCsp(shellCsp(hashes));
  assert.deepEqual(header.get('default-src'), ["'none'"]);
  assert.deepEqual(header.get('connect-src'), ["'self'"]);
  assert.deepEqual(header.get('frame-src'), ["'none'"]);
  assert.deepEqual(header.get('form-action'), ["'none'"]);
  assert.deepEqual(header.get('object-src'), ["'none'"]);
  assert.deepEqual(header.get('base-uri'), ["'none'"]);
  assert.deepEqual(header.get('frame-ancestors'), ["'none'"]);
  assert.deepEqual(header.get('worker-src'), ['blob:'], 'inherited by the frame, whose Workers are blob: Workers');
  assert.deepEqual(header.get('trusted-types'), ['offlineseal-sealed-frame', 'offlineseal-worker-script']);
  // The inherited policy must admit the sealed frame's one script and style.
  assert.ok(header.get('script-src').includes("'sha256-AAAA'"));
  assert.ok(header.get('style-src').includes("'sha256-BBBB'"));
  // frame-ancestors is invalid in <meta>, so the meta copy omits it.
  const meta = parseCsp(shellCsp(hashes, { forHeader: false }));
  assert.equal(meta.has('frame-ancestors'), false);
  header.delete('frame-ancestors');
  assert.deepEqual([...meta], [...header]);
});

test('permissions policy disables sensitive capabilities', () => {
  const pp = permissionsPolicy();
  for (const f of ['camera', 'microphone', 'geolocation', 'payment', 'usb', 'serial', 'hid', 'clipboard-read', 'clipboard-write', 'display-capture']) {
    assert.match(pp, new RegExp(`(^|, )${f}=\\(\\)`), f);
  }
  assert.doesNotMatch(pp, /=\((?!\))/, 'no feature may be granted to any origin');
});

test('site headers include the full security header set', () => {
  const [site] = siteHeaders(hashes);
  assert.equal(site.pattern, '/*');
  for (const h of [
    'Content-Security-Policy',
    'Permissions-Policy',
    'Referrer-Policy',
    'X-Content-Type-Options',
    'X-Frame-Options',
    'Cross-Origin-Opener-Policy',
    'Cross-Origin-Resource-Policy',
  ]) {
    assert.ok(site.headers[h], h);
  }
  assert.equal(site.headers['Referrer-Policy'], 'no-referrer');
  assert.equal(site.headers['X-Content-Type-Options'], 'nosniff');
  assert.equal(site.headers['Cross-Origin-Opener-Policy'], 'same-origin');
  assert.equal(site.headers['Cross-Origin-Resource-Policy'], 'same-origin');
});
