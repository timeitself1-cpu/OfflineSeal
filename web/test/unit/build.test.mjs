// Checks the built, deployable output (web/dist), which is what a host serves.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { build, PAYLOAD_PATH } from '../../build.mjs';
import { INSTANCE_PLACEHOLDER, sealedFrameCsp, shellCsp, siteHeaders } from '../../src/policy.mjs';

// Builds into a private directory. web/dist is left alone, because the browser
// tests serve it and may be running at the same time (build() starts by
// removing its output directory).
let info;
let DIST;
before(async () => {
  DIST = await mkdtemp(join(tmpdir(), 'offlineseal-build-test-'));
  info = await build({ outDir: DIST, quiet: true });
});

const read = (p) => readFile(join(DIST, p), 'utf8');
const sha = (alg, s) => createHash(alg).update(s, 'utf8').digest('base64');

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else out.push(full);
  }
  return out;
}

test('payload integrity in the manifest matches the payload bytes', async () => {
  const payload = await read(PAYLOAD_PATH);
  assert.equal(info.integrity, `sha384-${sha('sha384', payload)}`);
  const manifest = await read('assets/sealed-manifest.js');
  assert.ok(manifest.includes(info.integrity));
  assert.ok(manifest.includes('"allow-scripts","allow-downloads"'));
});

test('payload is one self-contained document with a pinned script and style', async () => {
  const payload = await read(PAYLOAD_PATH);
  const scripts = [...payload.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
  const styles = [...payload.matchAll(/<style\b([^>]*)>([\s\S]*?)<\/style>/g)];
  assert.equal(scripts.length, 1, 'exactly one script');
  assert.equal(styles.length, 1, 'exactly one style block');
  assert.equal(scripts[0][1], '', 'script has no src or other attributes');
  assert.equal(sha('sha256', scripts[0][2]), info.scriptHash);
  assert.equal(sha('sha256', styles[0][2]), info.styleHash);
  assert.equal(payload.split(INSTANCE_PLACEHOLDER).length, 2, 'one instance placeholder');
  // In the markup (script and style bodies removed): no attribute that loads
  // anything, and no inline handlers or style attributes. The CSP would block
  // them anyway; the point is that none are needed.
  const markup = payload.replace(/<script>[\s\S]*?<\/script>/, '<script></script>').replace(/<style>[\s\S]*?<\/style>/, '<style></style>');
  assert.doesNotMatch(markup, /\s(src|href|srcset|action|formaction|poster|data|background|ping)\s*=/i);
  assert.doesNotMatch(markup, /\son[a-z]+\s*=/i);
  assert.doesNotMatch(markup, /\sstyle\s*=/i);
});

test('payload meta CSP is the policy module output, and appears first', async () => {
  const payload = await read(PAYLOAD_PATH);
  const expected = sealedFrameCsp({ scriptHash: info.scriptHash, styleHash: info.styleHash });
  assert.equal(info.sealedCsp, expected);
  const metaIndex = payload.indexOf(`<meta http-equiv="Content-Security-Policy" content="${expected}">`);
  assert.ok(metaIndex > 0);
  assert.ok(metaIndex < payload.indexOf('<style'), 'CSP precedes the style');
  assert.ok(metaIndex < payload.indexOf('<script'), 'CSP precedes the script');
});

test('shell pages carry the meta CSP before any resource', async () => {
  const meta = shellCsp({ scriptHash: info.scriptHash, styleHash: info.styleHash }, { forHeader: false });
  for (const page of ['index.html', 'image.html']) {
    const html = await read(page);
    const i = html.indexOf(`<meta http-equiv="Content-Security-Policy" content="${meta}">`);
    assert.ok(i > 0, page);
    assert.ok(i < html.indexOf('<link'), `${page}: CSP precedes stylesheets`);
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/, `${page}: no inline scripts`);
    assert.doesNotMatch(html, /type="file"/, `${page}: the shell has no file input`);
  }
});

test('header files are generated from the policy module and agree', async () => {
  const hashes = { scriptHash: info.scriptHash, styleHash: info.styleHash };
  const json = JSON.parse(await read('headers.json'));
  assert.deepEqual(json, siteHeaders(hashes));
  const netlify = await read('_headers');
  for (const [name, value] of Object.entries(json[0].headers)) assert.ok(netlify.includes(`  ${name}: ${value}\n`), name);
  const nginx = await read('nginx-security-headers.conf');
  assert.ok(nginx.includes(`add_header Content-Security-Policy "${json[0].headers['Content-Security-Policy']}" always;`));
});

test('no external resources, analytics or third-party code anywhere in the build', async () => {
  const ALLOWED_LINK = 'https://github.com/timeitself1-cpu/OfflineSeal#offlineseal-desktop';
  const TRACKERS = /google-analytics|googletagmanager|gtag\(|segment\.(io|com)|mixpanel|hotjar|plausible\.io|sentry\.io|datadoghq|newrelic|fonts\.googleapis|fonts\.gstatic|unpkg\.com|jsdelivr|cdnjs|cloudflareinsights|sendBeacon/i;
  for (const file of await walk(DIST)) {
    const rel = relative(DIST, file);
    if (/\.(json|conf)$|_headers$/.test(rel)) continue; // host config, not served content
    const text = await readFile(file, 'utf8');
    const withoutDesktopLink = text.split(ALLOWED_LINK).join('');
    const urls = withoutDesktopLink.match(/(https?:)?\/\/[a-z0-9.-]+\.[a-z]{2,}[^\s"'<>)]*/gi) || [];
    // The SVG namespace is an identifier, not a request.
    const real = urls.filter((u) => u !== 'http://www.w3.org/2000/svg');
    assert.deepEqual(real, [], `${rel} references external URLs`);
    assert.doesNotMatch(text, TRACKERS, `${rel} mentions a tracker/CDN`);
    assert.doesNotMatch(text, /@import|@font-face|url\(\s*['"]?(https?:|\/\/)/i, `${rel} loads CSS resources`);
  }
  // The Desktop link is a plain link in the shell only, never in the sealed payload.
  assert.ok(!(await read(PAYLOAD_PATH)).includes('github.com'));
});

test('build is deterministic', async () => {
  const other = await mkdtemp(join(tmpdir(), 'offlineseal-build-'));
  const again = await build({ outDir: other, quiet: true });
  assert.deepEqual(again, info);
  assert.equal(await readFile(join(other, PAYLOAD_PATH), 'utf8'), await read(PAYLOAD_PATH));
});
