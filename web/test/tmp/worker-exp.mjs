import http from 'node:http'; import dgram from 'node:dgram'; import crypto from 'node:crypto'; import { chromium } from 'playwright';
import { syntheticPng } from '../helpers/synthetic-image.mjs';
const channel = process.argv[2];
const probeLog = []; let tcp = 0;
const probe = http.createServer((q, r) => { probeLog.push(q.url); r.end('x'); }); probe.on('connection', () => tcp++);
await new Promise(r => probe.listen(0, '127.0.0.1', r)); const P = `http://127.0.0.1:${probe.address().port}`;
const h = s => "'sha256-" + crypto.createHash('sha256').update(s).digest('base64') + "'";
const workerSrc = `
self.addEventListener('securitypolicyviolation', (e) => { self.__v = (self.__v||[]).concat(e.effectiveDirective); });
self.onmessage = async (e) => {
  if (e.data.type === 'probe') {
    const out = { origin: self.origin, rtc: typeof RTCPeerConnection, dc: typeof RTCDataChannel, idb: (()=>{try{indexedDB.open('x');return 'ok'}catch(err){return err.name}})(), caches: typeof caches };
    out.fetchData = await fetch('data:,x').then(()=>'ok',()=>'refused');
    out.fetchNet = await fetch('${P}/w-fetch').then(()=>'ok',()=>'refused');
    out.ws = await new Promise(r => { try { const w = new WebSocket('ws://127.0.0.1:${probe.address().port}/w-ws'); w.onerror=()=>r('error'); w.onopen=()=>r('open'); } catch (err) { r('threw '+err.name) } });
    out.xhr = await new Promise(r => { try { const x = new XMLHttpRequest(); x.open('GET','${P}/w-xhr'); x.onload=()=>r('ok'); x.onerror=()=>r('error'); x.send(); } catch(err){ r('threw '+err.name) } });
    out.importScripts = (()=>{ try { importScripts('${P}/w-import'); return 'ok' } catch (err) { return 'threw '+err.name } })();
    out.nestedWorker = (()=>{ try { new Worker('${P}/w-nested'); return 'made' } catch (err) { return 'threw '+err.name } })();
    out.eval = (()=>{ try { return eval('1+1') } catch (err) { return 'threw '+err.name } })();
    out.es = await new Promise(r => { try { const s = new EventSource('${P}/w-es'); s.onerror=()=>{s.close(); r('error')} } catch(err){ r('threw '+err.name) } });
    await new Promise(r => setTimeout(r, 300));
    out.violations = self.__v || [];
    postMessage(out);
  } else if (e.data.type === 'convert') {
    const bmp = await createImageBitmap(e.data.file);
    const c = new OffscreenCanvas(bmp.width, bmp.height); c.getContext('2d').drawImage(bmp, 0, 0);
    const blob = await c.convertToBlob({ type: 'image/webp', quality: 0.8 });
    const preview = await createImageBitmap(bmp, { resizeWidth: 20, resizeHeight: 15, resizeQuality: 'high' });
    postMessage({ blob, preview }, [preview]);
  }
};`;
const frameJs = `
const W = ${JSON.stringify(workerSrc)};
const url = URL.createObjectURL(new Blob([W], { type: 'text/javascript' }));
const pol = trustedTypes.createPolicy('offlineseal-worker-script', { createScriptURL: (u) => { if (u !== url) throw new TypeError('no'); return u; } });
window.__spawn = () => new Worker(pol.createScriptURL(url));
window.__url = url;
`;
const csp = `default-src 'none'; script-src ${h(frameJs)}; style-src 'none'; img-src 'none'; connect-src 'none'; worker-src blob:; frame-src 'none'; child-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; require-trusted-types-for 'script'; trusted-types offlineseal-worker-script`;
const srcdoc = `<!doctype html><meta http-equiv="Content-Security-Policy" content="${csp}"><body><input type=file id=f><script>${frameJs}</script>`;
const appJs = `const p = trustedTypes.createPolicy('offlineseal-sealed-frame',{createHTML:s=>s}); const f=document.createElement('iframe'); f.sandbox='allow-scripts allow-downloads'; f.srcdoc=p.createHTML(${JSON.stringify(srcdoc)}); document.body.append(f);`;
const pcsp = `default-src 'none'; script-src 'self' ${h(frameJs)}; connect-src 'self'; worker-src blob:; frame-src 'none'; child-src 'none'; require-trusted-types-for 'script'; trusted-types offlineseal-sealed-frame offlineseal-worker-script; frame-ancestors 'none'`;
const s = http.createServer((q, r) => { if (q.url === '/a.js') { r.setHeader('content-type','text/javascript'); return r.end(appJs);} r.setHeader('content-type','text/html'); r.setHeader('content-security-policy', pcsp); r.end('<body><script src=/a.js></script>'); });
await new Promise(r => s.listen(0, '127.0.0.1', r));
const b = await chromium.launch(channel ? { channel } : {}); console.log('browser', channel || 'chromium', b.version());
const pg = await (await b.newContext({acceptDownloads:true})).newPage();
pg.on('console', m => { if (!/Refused|violates|Fetch API/.test(m.text())) console.log('console', m.text().slice(0,200)); });
const workerEvents = [];
pg.on('worker', w => { workerEvents.push('created ' + w.url().slice(0, 20)); w.on('close', () => workerEvents.push('closed')); });
await pg.goto(`http://127.0.0.1:${s.address().port}/`); await pg.waitForTimeout(300);
const fr = pg.frames()[1];
// TT check: foreign blob URL refused
console.log('foreign worker url:', await fr.evaluate(() => { try { new Worker(URL.createObjectURL(new Blob(['1']))); return 'made'; } catch (e) { return 'threw ' + e.name; } }));
const res = await fr.evaluate(() => new Promise(r => { const w = __spawn(); w.onmessage = e => { r(e.data); w.terminate(); }; w.onerror = e => r('error ' + e.message); w.postMessage({ type: 'probe' }); }));
console.log('worker probe', JSON.stringify(res));
await fr.setInputFiles('#f', { name: 'x.png', mimeType: 'image/png', buffer: syntheticPng({ width: 64, height: 48 }) });
const conv = await fr.evaluate(() => new Promise(r => { const w = __spawn(); w.onmessage = async e => { w.terminate(); await new Promise(z => setTimeout(z, 300)); const { blob, preview } = e.data; const c = document.createElement('canvas'); c.getContext('bitmaprenderer').transferFromImageBitmap(preview); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = 'o.webp'; a.id = 'dl'; a.textContent = 'dl'; document.body.append(a); r({ type: blob.type, size: blob.size, cw: c.width, ch: c.height, headAfterTerminate: new Uint8Array(await blob.slice(0, 4).arrayBuffer()).join(',') }); }; w.postMessage({ type: 'convert', file: document.getElementById('f').files[0] }); }));
console.log('convert after terminate', JSON.stringify(conv));
const [d] = await Promise.all([pg.waitForEvent('download'), fr.click('#dl')]);
console.log('download', d.suggestedFilename(), (await import('node:fs')).statSync(await d.path()).size);
await pg.waitForTimeout(300);
console.log('worker events', workerEvents, 'probe http', probeLog, 'tcp', tcp);
// playwright evaluate inside a live worker
const live = await fr.evaluate(() => { window.__live = __spawn(); return 1; });
await pg.waitForTimeout(200);
const ws = pg.workers(); console.log('page.workers()', ws.length, ws.length ? await ws[ws.length-1].evaluate(() => [self.origin, typeof self.onmessage]) : '');
await b.close(); s.close(); probe.close();
