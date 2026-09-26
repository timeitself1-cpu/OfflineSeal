// The platform boundary, tested with a deliberately hostile tool.
//
// test/fixtures/tools/hostile is built only here, into a private site next to
// the real tools, and never into web/dist. Its Worker code plays a malicious or
// broken third-party tool. Holding the user's file, it tries to reach the
// network, to hand back forbidden results, to bypass the runtime's own Worker
// host, to hang and to crash. Pass condition: the runtime contains every
// attempt, nothing reaches any server, and nothing forbidden is offered for
// download.
//
// Also: the frame runtime that the browser executes is identical for every
// tool (checked live in the browser, not just in the build output).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from '../../build.mjs';
import { startServer } from '../../server/serve.mjs';
import { launchBrowser, startProbe, openTool, waitForShellState, sealedFrame, selectChoice, sleep, trackWorkers, allClosed } from '../helpers/harness.mjs';

const HOSTILE = fileURLToPath(new URL('../fixtures/tools/hostile/', import.meta.url));
let browser, site, probe, info;
before(async () => {
  browser = await launchBrowser();
  probe = await startProbe();
  const root = await mkdtemp(join(tmpdir(), 'offlineseal-platform-'));
  info = await build({ outDir: root, quiet: true, extraToolDirs: [HOSTILE] });
  site = await startServer({ root, observe: true });
});
after(async () => {
  await browser?.close();
  await site?.close();
  await probe?.close();
});

async function hostile(attack, variant = 'none') {
  let track;
  const env = await openTool(browser, site, { path: 'hostile', beforeGoto: (page) => { track = trackWorkers(page); } });
  env.track = track;
  await waitForShellState(env.page, 'ready');
  env.frame = sealedFrame(env.page);
  // The "private file": a secret the tool will try to exfiltrate, plus where to send it.
  await env.frame.setInputFiles('#file', { name: 'secret.txt', mimeType: 'text/plain', buffer: Buffer.from(`PROBE=${probe.origin}\nTOP-SECRET-HOSTILE-MARKER`) });
  await waitForShellState(env.page, 'file-selected');
  await selectChoice(env, 'attack', attack);
  await selectChoice(env, 'variant', variant);
  env.startedAt = Date.now();
  env.siteLogAtAttack = site.log.length;
  await env.frame.click('#action');
  return env;
}
const outcome = async (env) => {
  await env.page.waitForSelector('body[data-state="complete"], body[data-state="failed"]', { timeout: 10_000 });
  return env.page.getAttribute('body', 'data-state');
};
const shellCodes = async (env) => (await env.page.evaluate(() => window.__offlinesealAudit)).messages.flatMap((m) => m.strings);
const offered = (env) => env.frame.$$eval('#outputs a', (as) => as.map((a) => ({ name: a.getAttribute('download'), href: a.href })));

test('the frame runtime executed in the browser is byte-identical for every tool', async () => {
  const hashes = new Set();
  for (const path of ['image', 'pdf', 'hostile']) {
    const env = await openTool(browser, site, { path });
    await waitForShellState(env.page, 'ready');
    const code = await sealedFrame(env.page).evaluate(() => [...document.scripts].map((s) => [s.type, s.textContent]));
    assert.equal(code.length, 1, `${path}: only the runtime script remains (data blocks are consumed)`);
    assert.equal(code[0][0], '', `${path}: a classic script`);
    hashes.add(createHash('sha256').update(code[0][1], 'utf8').digest('base64'));
    await env.context.close();
  }
  assert.deepEqual([...hashes], [info.runtimeScriptHash], 'one runtime, pinned by the CSP, for all tools');
});

test('network: a tool holding the file cannot reach any server by any Worker channel', async () => {
  probe.reset();
  const env = await hostile('network');
  assert.equal(await outcome(env), 'complete');
  const summary = await env.frame.textContent('#result-summary');
  for (const channel of ['fetch', 'post', 'xhr', 'websocket', 'eventsource', 'importScripts', 'worker', 'eval']) {
    assert.match(summary, new RegExp(`${channel}: (refused|threw)`), channel);
  }
  assert.doesNotMatch(summary, /REACHED/);
  await sleep(1000);
  assert.deepEqual(probe.log, [], 'probe server received requests');
  assert.equal(probe.counts.tcp + probe.counts.udp + probe.counts.upgrades, 0);
  assert.deepEqual(site.log.slice(env.siteLogAtAttack), [], 'the site itself received nothing during the attack');
  await env.context.close();
});

for (const [attack, variant, why] of [
  ['html-output', 'none', 'an HTML download (would run with network access when opened)'],
  ['undeclared', 'none', 'an output type the manifest does not declare'],
  ['too-many', 'none', 'more outputs than the manifest allows'],
  ['fake-blob', 'none', 'an output that is not a Blob'],
  ['rename', 'long-summary', 'oversized text'],
  ['rename', 'bypass-host', 'bypassing the Worker host to swap in an HTML file'],
]) {
  test(`results: ${why} is rejected and nothing is offered`, async () => {
    const env = await hostile(attack, variant);
    assert.equal(await outcome(env), 'failed');
    assert.deepEqual(await offered(env), []);
    const codes = await shellCodes(env);
    assert.ok(codes.includes('output-rejected'), `shell told: ${codes.filter((c) => /-/.test(c)).join(',')}`);
    assert.ok(!codes.some((c) => c.includes('SECRET')));
    await allClosed(env.track);
    await env.context.close();
  });
}

test('results: the runtime, not the tool, names downloads', async () => {
  const env = await hostile('rename');
  assert.equal(await outcome(env), 'complete');
  const links = await offered(env);
  assert.equal(links.length, 1);
  assert.equal(links[0].name, 'evil.png', 'path and extension stripped; extension forced from the declared type');
  assert.match(links[0].href, /^blob:null\//);
  await env.context.close();
});

test('messages: junk posted outside the protocol is ignored; the valid result still arrives', async () => {
  const env = await hostile('rename', 'post-junk');
  assert.equal(await outcome(env), 'complete');
  assert.ok(env.consoleMessages.filter((m) => m.text.includes('Ignored worker message')).length >= 3);
  assert.equal((await offered(env)).length, 1);
  await env.context.close();
});

test('a hanging tool is cancelled at its manifest timeout, and its Worker terminated', async () => {
  const env = await hostile('hang');
  assert.equal(await outcome(env), 'failed');
  const elapsed = Date.now() - env.startedAt;
  assert.ok(elapsed >= 1900 && elapsed < 6000, `timed out after ${elapsed} ms (manifest: 2000 ms)`);
  assert.ok((await shellCodes(env)).includes('worker-failed'));
  await allClosed(env.track);
  await env.context.close();
});

test('a crashing tool fails cleanly, and its Worker is terminated', async () => {
  const env = await hostile('crash');
  assert.equal(await outcome(env), 'failed');
  assert.ok(Date.now() - env.startedAt < 1900, 'failed on the crash, not at the timeout');
  assert.ok((await shellCodes(env)).includes('worker-failed'));
  await allClosed(env.track);
  await env.context.close();
});
