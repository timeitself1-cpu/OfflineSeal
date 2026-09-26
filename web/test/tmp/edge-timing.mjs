import { launchBrowser, startApp, openTool, waitForShellState, sealedFrame } from '../helpers/harness.mjs';
const b = await launchBrowser(); const app = await startApp();
const env = await openTool(b, app, { initScripts: [`if (window !== window.top) { window.__initAt = { readyState: document.readyState, hasBody: !!document.body, bodyState: document.body && document.body.dataset.state, url: location.href, scripts: document.scripts.length }; }`] });
await waitForShellState(env.page, 'ready');
console.log(process.env.OFFLINESEAL_BROWSER || 'chromium', JSON.stringify(await sealedFrame(env.page).evaluate(() => window.__initAt)));
await b.close(); await app.close();
