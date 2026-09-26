// Shared browser-test plumbing: launches Chromium, serves the built site with
// request logging, and runs a separate cross-origin "probe" server that counts
// HTTP requests, raw TCP connections, WebSocket upgrades and UDP packets.

import http from 'node:http';
import dgram from 'node:dgram';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';

import { startServer, PROBE_PREFIX } from '../../server/serve.mjs';

export { PROBE_PREFIX };

export async function launchBrowser() {
  return chromium.launch();
}

export async function startApp(options = {}) {
  return startServer({ observe: true, ...options });
}

// A second origin (different port) that the sealed frame should never reach.
export async function startProbe() {
  const log = [];
  const counts = { tcp: 0, upgrades: 0, udp: 0 };
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    log.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('latin1') });
    res.writeHead(200, {
      'content-type': req.url.startsWith('/control-page') ? 'text/html' : 'text/plain',
      'access-control-allow-origin': '*',
    });
    res.end(req.url.startsWith('/control-page') ? '<!doctype html><title>control</title>' : 'reached');
  });
  server.on('connection', () => {
    counts.tcp += 1;
  });
  server.on('upgrade', (req, socket) => {
    counts.upgrades += 1;
    log.push({ method: 'UPGRADE', url: req.url, headers: req.headers, body: '' });
    socket.destroy();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));

  const udp = dgram.createSocket('udp4');
  const udpPackets = [];
  udp.on('message', (msg) => {
    counts.udp += 1;
    udpPackets.push(msg.toString('latin1'));
  });
  await new Promise((r) => udp.bind(0, '127.0.0.1', r));

  const port = server.address().port;
  return {
    origin: `http://127.0.0.1:${port}`,
    wsOrigin: `ws://127.0.0.1:${port}`,
    udpPort: udp.address().port,
    log,
    counts,
    udpPackets,
    reset() {
      log.length = 0;
      udpPackets.length = 0;
      counts.tcp = 0;
      counts.upgrades = 0;
      counts.udp = 0;
    },
    close: () =>
      new Promise((r) => {
        udp.close();
        server.closeAllConnections?.();
        server.close(r);
      }),
  };
}

// Instrumentation for the *shell* realm only (never the sealed frame). Counts
// every way the shell's JavaScript could get at file contents, and keeps a
// structural description of every message that reaches the page. Installed
// before any page script runs.
export const SHELL_AUDIT_SCRIPT = `(() => {
  if (window !== window.top) return;
  const audit = {
    messages: [],
    binaryInMessages: 0,
    blobReads: 0,
    fileReaderReads: 0,
    objectUrlsCreated: 0,
    dataTransferReads: 0,
    fileInputReads: 0,
  };
  Object.defineProperty(window, '__offlinesealAudit', { value: audit });

  const BINARY = [Blob, ArrayBuffer, DataView, MessagePort, typeof SharedArrayBuffer === 'function' ? SharedArrayBuffer : null].filter(Boolean);
  const describe = (value, out, depth) => {
    if (depth > 6) return;
    if (typeof value === 'string') { out.strings.push(value); return; }
    if (value === null || typeof value !== 'object') return;
    if (BINARY.some((C) => value instanceof C) || ArrayBuffer.isView(value)) { out.binary += 1; return; }
    for (const key of Object.keys(value)) { out.strings.push(key); describe(value[key], out, depth + 1); }
  };
  window.addEventListener('message', (event) => {
    const out = { strings: [], binary: 0 };
    describe(event.data, out, 0);
    audit.messages.push({ origin: event.origin, strings: out.strings, binary: out.binary });
    audit.binaryInMessages += out.binary;
  }, true);

  const count = (target, name, key) => {
    const original = target[name];
    if (typeof original !== 'function') return;
    target[name] = function (...args) { audit[key] += 1; return original.apply(this, args); };
  };
  for (const m of ['arrayBuffer', 'text', 'stream', 'bytes']) count(Blob.prototype, m, 'blobReads');
  for (const m of ['readAsArrayBuffer', 'readAsBinaryString', 'readAsDataURL', 'readAsText']) count(FileReader.prototype, m, 'fileReaderReads');
  count(URL, 'createObjectURL', 'objectUrlsCreated');
  count(DataTransfer.prototype, 'getData', 'dataTransferReads');
  const wrapGetter = (proto, prop, key) => {
    const d = Object.getOwnPropertyDescriptor(proto, prop);
    Object.defineProperty(proto, prop, { ...d, get() { audit[key] += 1; return d.get.call(this); } });
  };
  wrapGetter(DataTransfer.prototype, 'files', 'dataTransferReads');
  wrapGetter(DataTransfer.prototype, 'items', 'dataTransferReads');
  wrapGetter(HTMLInputElement.prototype, 'files', 'fileInputReads');
})();`;

export async function openTool(browser, app, { viewport = { width: 1280, height: 900 }, audit = true, initScripts = [], beforeGoto } = {}) {
  const context = await browser.newContext({ acceptDownloads: true, viewport });
  if (audit) await context.addInitScript(SHELL_AUDIT_SCRIPT);
  for (const script of initScripts) await context.addInitScript(script);
  const page = await context.newPage();
  const consoleMessages = [];
  const pageErrors = [];
  page.on('console', (m) => consoleMessages.push({ type: m.type(), text: m.text() }));
  page.on('pageerror', (e) => pageErrors.push(e.message));
  if (beforeGoto) await beforeGoto(page, context);
  const response = await page.goto(`${app.origin}/image`);
  return { context, page, response, consoleMessages, pageErrors };
}

export async function waitForShellState(page, state, timeout = 10_000) {
  await page.waitForSelector(`body[data-state="${state}"]`, { timeout });
}

export function sealedFrame(page) {
  const frames = page.frames().filter((f) => f !== page.mainFrame());
  if (frames.length !== 1) throw new Error(`expected exactly one sealed frame, found ${frames.length}`);
  return frames[0];
}

// Frame documents have no 'unsafe-eval', so Playwright's waitForFunction
// cannot run inside them. This polls with frame.evaluate instead.
export async function pollFrame(frame, fn, arg, { timeout = 10_000, interval = 50 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await frame.evaluate(fn, arg);
    if (value) return value;
    if (Date.now() > deadline) throw new Error('pollFrame timed out');
    await new Promise((r) => setTimeout(r, interval));
  }
}

export async function readyTool(browser, app, options) {
  const env = await openTool(browser, app, options);
  await waitForShellState(env.page, 'ready');
  env.frame = sealedFrame(env.page);
  return env;
}

export async function chooseImage(env, buffer, name = 'synthetic-test-image.png') {
  await env.frame.setInputFiles('#file', { name, mimeType: 'image/png', buffer });
}

export async function convertTo(env, type) {
  await env.frame.check(`#formats input[value="${type}"]`);
  await env.frame.click('#convert');
  await waitForShellState(env.page, 'complete');
}

export async function downloadResult(env) {
  const [download] = await Promise.all([env.page.waitForEvent('download'), env.frame.click('#download')]);
  const dir = await mkdtemp(join(tmpdir(), 'offlineseal-dl-'));
  const path = join(dir, download.suggestedFilename());
  await download.saveAs(path);
  return { download, path, name: download.suggestedFilename() };
}

// Decode bytes in a separate, ordinary page (no OfflineSeal code involved).
// Checks that an output is a real, decodable image.
export async function decodeInCleanPage(context, buffer, samplePoints = []) {
  const page = await context.newPage();
  try {
    return await page.evaluate(
      async ({ b64, samplePoints }) => {
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const bitmap = await createImageBitmap(new Blob([bytes]));
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(bitmap, 0, 0);
        const samples = samplePoints.map(([x, y]) => Array.from(ctx.getImageData(x, y, 1, 1).data));
        return { width: bitmap.width, height: bitmap.height, samples };
      },
      { b64: buffer.toString('base64'), samplePoints },
    );
  } finally {
    await page.close();
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
