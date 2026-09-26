import { launchBrowser, startApp, openTool, waitForShellState, sealedFrame, sleep } from '../helpers/harness.mjs';
const b = await launchBrowser(); const app = await startApp();
const env = await openTool(b, app, { initScripts: [`if (window !== window.top) { window.__initRan = true; }`, `if (window === window.top) { window.__topInit = true; }`] });
await waitForShellState(env.page, 'ready');
const fr = sealedFrame(env.page);
console.log(process.env.OFFLINESEAL_BROWSER || 'chromium', 'top init:', await env.page.evaluate(() => window.__topInit), 'frame init:', await fr.evaluate(() => window.__initRan));
console.log('shell audit present:', await env.page.evaluate(() => !!window.__offlinesealAudit));
await b.close(); await app.close();
