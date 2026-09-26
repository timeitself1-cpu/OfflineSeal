// Captures screenshots of the finished flow at common desktop widths, plus a
// network log of a real conversion, into web/docs/.
//
//   npm run evidence
//
// Uses the same built site and server as the tests. The network log comes
// from the browser itself (every request from every frame) and from the
// server's own request log.

import { mkdir, writeFile } from 'node:fs/promises';
import zlib from 'node:zlib';

import { build } from '../build.mjs';
import { launchBrowser, startApp, openTool, waitForShellState, sealedFrame, downloadResult, sleep } from '../test/helpers/harness.mjs';

const OUT = new URL('../docs/', import.meta.url);
const SHOTS = new URL('screenshots/', OUT);
await mkdir(SHOTS, { recursive: true });
await build({ quiet: true });

// A synthetic "photo" (sky, sun, hills) so screenshots look like real use.
function landscapePng(width, height) {
  const crcTable = new Int32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c;
  });
  const crc = (b) => {
    let c = -1;
    for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
  const chunk = (t, d) => {
    const l = Buffer.alloc(4);
    l.writeUInt32BE(d.length);
    const td = Buffer.concat([Buffer.from(t), d]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([l, td, c]);
  };
  const raw = Buffer.alloc((width * 3 + 1) * height);
  const mix = (a, b, t) => Math.round(a + (b - a) * t);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = y * (width * 3 + 1) + 1 + x * 3;
      const v = y / height;
      let rgb = [mix(255, 120, v * 1.4), mix(170, 150, v), mix(110, 210, v)]; // dusk sky
      const sx = x - width * 0.68;
      const sy = y - height * 0.42;
      if (sx * sx + sy * sy < (height * 0.09) ** 2) rgb = [255, 236, 190]; // sun
      const hill1 = height * (0.62 + 0.06 * Math.sin(x / width * 5.2 + 0.6));
      const hill2 = height * (0.74 + 0.05 * Math.sin(x / width * 8.1 + 2.1));
      if (y > hill1) rgb = [mix(62, 30, (y - hill1) / height * 3), mix(96, 60, (y - hill1) / height * 3), mix(110, 80, (y - hill1) / height * 3)];
      if (y > hill2) rgb = [mix(28, 12, (y - hill2) / height * 3), mix(58, 34, (y - hill2) / height * 3), mix(58, 40, (y - hill2) / height * 3)];
      raw[o] = Math.max(0, Math.min(255, rgb[0]));
      raw[o + 1] = Math.max(0, Math.min(255, rgb[1]));
      raw[o + 2] = Math.max(0, Math.min(255, rgb[2]));
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const photo = landscapePng(1600, 1067);
const browser = await launchBrowser();
const app = await startApp();
const slowApp = await startApp({ delays: { '/assets/sealed/image-converter.sealed.txt': 4000 } });
const shot = (page, name) => page.screenshot({ path: new URL(`${name}.png`, SHOTS).pathname, fullPage: true });

// 1. Preparing (the tool download is held back so the state is visible).
{
  const env = await openTool(browser, slowApp, { viewport: { width: 1440, height: 900 }, audit: false });
  await sleep(700);
  await shot(env.page, '01-preparing-1440');
  await env.context.close();
}

// 2. The full flow at 1440 wide, with the network log.
const requests = [];
let phase = 'load';
{
  const env = await openTool(browser, app, {
    viewport: { width: 1440, height: 900 },
    audit: false,
    beforeGoto: (page) => {
      page.on('request', (r) =>
        requests.push({
          phase,
          method: r.method(),
          path: new URL(r.url()).pathname,
          resourceType: r.resourceType(),
          initiator: r.frame() === page.mainFrame() ? 'shell' : 'sealed frame',
        }),
      );
    },
  });
  await waitForShellState(env.page, 'ready');
  const serverAtReady = app.log.length;
  phase = 'processing';
  await sleep(400); // let the frame's fade-in from its pre-ready (inert) look finish
  await shot(env.page, '02-ready-1440');
  const frame = sealedFrame(env.page);
  await frame.setInputFiles('#file', { name: 'lake-at-dusk.png', mimeType: 'image/png', buffer: photo });
  await waitForShellState(env.page, 'file-selected');
  await sleep(200);
  await shot(env.page, '03-image-loaded-1440');
  await frame.check('#formats input[value="image/webp"]');
  await frame.click('#scales button[data-scale="50"]');
  await frame.click('#convert');
  await waitForShellState(env.page, 'complete');
  await sleep(200);
  await shot(env.page, '04-converted-1440');
  const dl = await downloadResult({ ...env, frame });
  await sleep(500);
  const serverDuringProcessing = app.log.slice(serverAtReady).map((e) => `${e.method} ${e.path}`);
  await env.page.click('.info summary');
  await env.page.screenshot({ path: new URL('05-info-1440.png', SHOTS).pathname });
  await env.page.click('.info summary');
  await env.page.click('#tech summary');
  await shot(env.page, '06-technical-details-1440');

  const evidence = {
    note: 'Captured by web/scripts/capture-evidence.mjs in headless Chromium. "processing" starts when the shell shows READY and covers choosing a 1600x1067 PNG, converting to WebP at 50%, and downloading the result.',
    browser: `Chromium ${browser.version()}`,
    download: { suggestedFilename: dl.name },
    browserRequests: {
      load: requests.filter((r) => r.phase === 'load'),
      processing: requests.filter((r) => r.phase === 'processing'),
    },
    serverRequestsDuringProcessing: serverDuringProcessing,
  };
  await writeFile(new URL('network-evidence.json', OUT), JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify(evidence, null, 2));
  await env.context.close();
}

// 3. Ready state at common desktop widths.
for (const [w, h] of [[1024, 768], [1280, 800], [1920, 1080]]) {
  const env = await openTool(browser, app, { viewport: { width: w, height: h }, audit: false });
  await waitForShellState(env.page, 'ready');
  await sleep(400);
  await shot(env.page, `07-ready-${w}`);
  await env.context.close();
}

// 4. Converted state at 1024 (narrowest common desktop) and dark mode.
for (const [name, opts] of [['08-converted-1024', { width: 1024, height: 768 }], ['09-converted-dark-1280', { width: 1280, height: 800, dark: true }]]) {
  const context = await browser.newContext({ viewport: { width: opts.width, height: opts.height }, colorScheme: opts.dark ? 'dark' : 'light', acceptDownloads: true });
  const page = await context.newPage();
  await page.goto(`${app.origin}/image`);
  await waitForShellState(page, 'ready');
  const frame = sealedFrame(page);
  await frame.setInputFiles('#file', { name: 'lake-at-dusk.png', mimeType: 'image/png', buffer: photo });
  await waitForShellState(page, 'file-selected');
  await frame.click('#convert');
  await waitForShellState(page, 'complete');
  await sleep(200);
  await shot(page, name);
  await context.close();
}

// 5. Narrow window (not a target, but it should not break).
{
  const env = await openTool(browser, app, { viewport: { width: 400, height: 860 }, audit: false });
  await waitForShellState(env.page, 'ready');
  await sleep(400);
  await shot(env.page, '10-ready-narrow-400');
  await env.context.close();
}

// 6. Landing page and fail-closed state.
{
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await page.goto(`${app.origin}/`);
  await shot(page, '11-landing-1280');
  await page.route('**/image-converter.sealed.txt', async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, body: (await response.text()).replace('connect-src', 'connect-src-x') });
  });
  await page.goto(`${app.origin}/image`);
  await waitForShellState(page, 'fatal');
  await shot(page, '12-tampered-tool-refused-1280');
  await context.close();
}

await browser.close();
await app.close();
await slowApp.close();
console.log(`screenshots written to ${SHOTS.pathname}`);
