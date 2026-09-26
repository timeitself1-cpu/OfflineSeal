// Checks the built, deployable output (web/dist), which is what a host serves.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { build } from '../../build.mjs';
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

const tools = () => Object.entries(info.tools);
const workerSource = (payload) => Buffer.from(/<script type="text\/plain" id="offlineseal-worker">([^<]*)<\/script>/.exec(payload)[1], 'base64').toString('utf8');
const manifestBlock = (payload) => JSON.parse(/<script type="application\/json" id="offlineseal-manifest">([^<]*)<\/script>/.exec(payload)[1]);

test('every tool payload matches its pinned integrity, and the registry lists it', async () => {
  assert.ok(tools().length >= 2);
  const registry = await read('assets/sealed-manifest.js');
  assert.ok(registry.includes('"allow-scripts","allow-downloads"'));
  assert.ok(registry.includes(`sha256-${info.runtimeScriptHash}`));
  for (const [id, t] of tools()) {
    const payload = await read(t.payloadPath);
    assert.equal(t.integrity, `sha384-${sha('sha384', payload)}`, id);
    assert.ok(registry.includes(t.integrity), id);
    assert.equal(manifestBlock(payload).id, id);
    assert.equal(createHash('sha256').update(workerSource(payload), 'utf8').digest('hex'), t.workerSourceSha256);
  }
});

test('each payload: one pinned runtime script, one style, two inert data blocks', async () => {
  for (const [id, t] of tools()) {
    const payload = await read(t.payloadPath);
    const scripts = [...payload.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
    const executable = scripts.filter(([, attrs]) => attrs === '');
    const styles = [...payload.matchAll(/<style\b([^>]*)>([\s\S]*?)<\/style>/g)];
    assert.equal(scripts.length, 3, `${id}: runtime + manifest + worker blocks`);
    assert.equal(executable.length, 1, `${id}: exactly one executable script`);
    assert.equal(styles.length, 1, `${id}: exactly one style block`);
    assert.equal(sha('sha256', executable[0][2]), info.runtimeScriptHash, id);
    assert.equal(sha('sha256', styles[0][2]), info.runtimeStyleHash, id);
    assert.equal(payload.split(INSTANCE_PLACEHOLDER).length, 2, `${id}: one instance placeholder`);
    assert.doesNotMatch(payload, /\{\{[A-Z0-9_]+\}\}/, `${id}: every placeholder filled`);
    const markup = payload.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '<script></script>').replace(/<style>[\s\S]*?<\/style>/, '<style></style>');
    assert.doesNotMatch(markup, /\s(src|href|srcset|action|formaction|poster|data|background|ping)\s*=/i, id);
    assert.doesNotMatch(markup, /\son[a-z]+\s*=/i, id);
    assert.doesNotMatch(markup, /\sstyle\s*=/i, id);
  }
});

test('payload meta CSP is the policy module output, and appears first', async () => {
  const expected = sealedFrameCsp({ scriptHash: info.runtimeScriptHash, styleHash: info.runtimeStyleHash });
  assert.equal(info.sealedCsp, expected);
  for (const [id, t] of tools()) {
    const payload = await read(t.payloadPath);
    const metaIndex = payload.indexOf(`<meta http-equiv="Content-Security-Policy" content="${expected}">`);
    assert.ok(metaIndex > 0, id);
    assert.ok(metaIndex < payload.indexOf('<style'), `${id}: CSP precedes the style`);
    assert.ok(metaIndex < payload.indexOf('<script'), `${id}: CSP precedes any script`);
  }
});

test('shell pages carry the meta CSP before any resource, and name their tool', async () => {
  const meta = shellCsp({ scriptHash: info.runtimeScriptHash, styleHash: info.runtimeStyleHash }, { forHeader: false });
  const pages = ['index.html', ...tools().map(([, t]) => `${t.path}.html`)];
  for (const page of pages) {
    const html = await read(page);
    const i = html.indexOf(`<meta http-equiv="Content-Security-Policy" content="${meta}">`);
    assert.ok(i > 0, page);
    assert.ok(i < html.indexOf('<link'), `${page}: CSP precedes stylesheets`);
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/, `${page}: no inline scripts`);
    assert.doesNotMatch(html, /type="file"/, `${page}: the shell has no file input`);
    assert.doesNotMatch(html, /\{\{[A-Z0-9_]+\}\}/, `${page}: every placeholder filled`);
  }
  for (const [id, t] of tools()) assert.ok((await read(`${t.path}.html`)).includes(`<meta name="offlineseal-tool" content="${id}">`));
  const landing = await read('index.html');
  for (const [, t] of tools()) assert.ok(landing.includes(`href="${t.path}"`));
});

test('header files are generated from the policy module and agree', async () => {
  const hashes = { scriptHash: info.runtimeScriptHash, styleHash: info.runtimeStyleHash };
  const json = JSON.parse(await read('headers.json'));
  assert.deepEqual(json, siteHeaders(hashes));
  const netlify = await read('_headers');
  for (const [name, value] of Object.entries(json[0].headers)) assert.ok(netlify.includes(`  ${name}: ${value}\n`), name);
  const nginx = await read('nginx-security-headers.conf');
  assert.ok(nginx.includes(`add_header Content-Security-Policy "${json[0].headers['Content-Security-Policy']}" always;`));
});

test('no external resources, analytics or third-party code anywhere, including decoded Worker code', async () => {
  const ALLOWED_LINK = 'https://github.com/timeitself1-cpu/OfflineSeal#offlineseal-desktop';
  const TRACKERS = /google-analytics|googletagmanager|gtag\(|segment\.(io|com)|mixpanel|hotjar|plausible\.io|sentry\.io|datadoghq|newrelic|fonts\.googleapis|fonts\.gstatic|unpkg\.com|jsdelivr|cdnjs|cloudflareinsights|sendBeacon/i;
  const check = (rel, text) => {
    const withoutDesktopLink = text.split(ALLOWED_LINK).join('');
    const urls = withoutDesktopLink.match(/(https?:)?\/\/[a-z0-9.-]+\.[a-z]{2,}[^\s"'<>)]*/gi) || [];
    // The SVG namespace is an identifier, not a request.
    const real = urls.filter((u) => u !== 'http://www.w3.org/2000/svg');
    assert.deepEqual(real, [], `${rel} references external URLs`);
    assert.doesNotMatch(text, TRACKERS, `${rel} mentions a tracker/CDN`);
    assert.doesNotMatch(text, /@import|@font-face|url\(\s*['"]?(https?:|\/\/)/i, `${rel} loads CSS resources`);
  };
  for (const file of await walk(DIST)) {
    const rel = relative(DIST, file);
    if (/\.(json|conf)$|_headers$/.test(rel)) continue; // host config, not served content
    const text = await readFile(file, 'utf8');
    check(rel, text);
    if (rel.endsWith('.sealed.txt')) {
      check(`${rel} (decoded Worker code)`, workerSource(text));
      assert.ok(!text.includes('github.com'), 'the Desktop link is only in the shell');
    }
  }
});

test('build is deterministic', async () => {
  const other = await mkdtemp(join(tmpdir(), 'offlineseal-build-'));
  const again = await build({ outDir: other, quiet: true });
  assert.deepEqual(again, info);
  for (const [, t] of tools()) assert.equal(await readFile(join(other, t.payloadPath), 'utf8'), await read(t.payloadPath));
});
