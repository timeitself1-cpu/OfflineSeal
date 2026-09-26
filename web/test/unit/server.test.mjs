import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { build } from '../../build.mjs';
import { startServer } from '../../server/serve.mjs';

let server;
before(async () => {
  await build({ quiet: true });
  server = await startServer();
});
after(() => server.close());

// Raw request so paths are sent exactly as written (fetch would normalise ../).
function get(path) {
  return new Promise((resolve, reject) => {
    const { hostname, port } = new URL(server.origin);
    const req = http.request({ hostname, port, path, method: 'GET' }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('clean URLs: /image serves the image tool, / serves the landing page', async () => {
  const image = await get('/image');
  assert.equal(image.status, 200);
  assert.match(image.headers['content-type'], /^text\/html/);
  assert.match(image.body, /<title>Image Converter/);
  assert.match((await get('/')).body, /<title>OfflineSeal Web<\/title>/);
});

test('security headers are sent on pages and assets', async () => {
  for (const path of ['/image', '/', '/assets/app.js', '/assets/sealed/image-converter.sealed.txt', '/nope']) {
    const res = await get(path);
    assert.match(res.headers['content-security-policy'], /default-src 'none'/, path);
    assert.match(res.headers['content-security-policy'], /frame-ancestors 'none'/, path);
    assert.equal(res.headers['x-content-type-options'], 'nosniff', path);
    assert.equal(res.headers['referrer-policy'], 'no-referrer', path);
    assert.equal(res.headers['cross-origin-opener-policy'], 'same-origin', path);
    assert.equal(res.headers['cross-origin-resource-policy'], 'same-origin', path);
    assert.ok(res.headers['permissions-policy'].includes('camera=()'), path);
  }
});

test('the sealed payload is served as inert text, never as a page', async () => {
  const res = await get('/assets/sealed/image-converter.sealed.txt');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /^text\/plain/);
});

test('no path traversal and no host config files served', async () => {
  for (const path of ['/../package.json', '/..%2fpackage.json', '/%2e%2e/build.mjs', '/headers.json', '/_headers', '/build-info.json', '/nginx-security-headers.conf']) {
    assert.equal((await get(path)).status, 404, path);
  }
});

test('the production server has no test endpoints', async () => {
  assert.equal((await get('/__test_should_not_be_reached/fetch')).status, 404);
});
