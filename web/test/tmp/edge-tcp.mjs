import { launchBrowser, startApp, startProbe, readyTool, sleep } from '../helpers/harness.mjs';
const b = await launchBrowser(); const app = await startApp(); const probe = await startProbe();
const P = probe.origin;
const probes = {
  preconnect: `(() => { const l = document.createElement('link'); l.rel = 'preconnect'; l.href = '${P}/x'; document.head.append(l); })()`,
  dnsPrefetch: `(() => { const l = document.createElement('link'); l.rel = 'dns-prefetch'; l.href = '${P}/x'; document.head.append(l); })()`,
  prefetch: `(() => { const l = document.createElement('link'); l.rel = 'prefetch'; l.href = '${P}/x'; document.head.append(l); })()`,
  iframeSrc: `(() => { const f = document.createElement('iframe'); f.src = '${P}/x'; document.body.append(f); })()`,
  fetch: `fetch('${P}/x').catch(() => {})`,
  img: `(() => { const i = new Image(); i.src = '${P}/x'; })()`,
  anchorTop: `(() => { const a = document.createElement('a'); a.href = '${P}/x'; a.target = '_top'; document.body.append(a); a.click(); })()`,
  metaRefresh: `(() => { const m = document.createElement('meta'); m.httpEquiv = 'refresh'; m.content = '0;url=${P}/x'; document.head.append(m); })()`,
  selfNav: `location.href = '${P}/x'`,
};
for (const [name, code] of Object.entries(probes)) {
  probe.reset();
  const env = await readyTool(b, app);
  await env.frame.evaluate(code).catch(() => {});
  await sleep(1500);
  console.log((process.env.OFFLINESEAL_BROWSER || 'chromium').padEnd(9), name.padEnd(12), 'http', probe.log.length, 'tcp', probe.counts.tcp, 'shell', await env.page.getAttribute('body', 'data-state'));
  await env.context.close();
}
await b.close(); await app.close(); await probe.close();
