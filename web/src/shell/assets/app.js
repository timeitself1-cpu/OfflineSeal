// OfflineSeal Web: outer shell.
//
// The shell is the network-capable part of OfflineSeal Web. It is written so
// that it never touches the user's file:
//   - It has no file input and no drop handler that reads data. The picker and
//     drop target live inside the sealed frame.
//   - It never sends the frame anything, and the frame's messages can only
//     change the status text on this page.
//   - It downloads exactly one thing at runtime: the pinned tool payload, from
//     its own origin, before any file can be chosen.

import { validateFrameMessage, nextState } from './protocol.js';
import { SEALED_RUNTIME, SEALED_TOOLS } from './sealed-manifest.js';

// Which tool this page hosts: set by the build in <meta name="offlineseal-tool">.
const TOOL_ID = document.querySelector('meta[name="offlineseal-tool"]')?.content ?? '';
const TOOL = Object.hasOwn(SEALED_TOOLS, TOOL_ID) ? SEALED_TOOLS[TOOL_ID] : null;

const READY_TIMEOUT_MS = 10_000;

const $ = (id) => document.getElementById(id);
const ui = {
  heading: $('seal-heading'),
  workspaceStatus: $('workspace-status'),
  frameHost: $('frame-host'),
  restart: $('restart'),
  nudge: $('drop-nudge'),
  fatal: $('fatal'),
  fatalText: $('fatal-text'),
  reload: $('reload'),
  tech: {
    integrity: $('tech-integrity'),
    sandbox: $('tech-sandbox'),
    origin: $('tech-origin'),
    frameCsp: $('tech-frame-csp'),
    shellCsp: $('tech-shell-csp'),
    instance: $('tech-instance'),
    messages: $('tech-messages'),
    tool: $('tech-tool'),
    runtime: $('tech-runtime'),
  },
};

const STATE_TEXT = {
  'loading-tool': ['Preparing secure processing area…', 'Downloading the tool…'],
  sealing: ['Preparing secure processing area…', 'Sealing the processing area…'],
  ready: ['Ready for your file', 'Sealed · ready for your files'],
  'file-selected': ['Your files are in the sealed area', 'Sealed · your files are inside'],
  processing: ['Working on this device…', 'Sealed · processing'],
  complete: ['Your result is ready', 'Sealed · result ready to download'],
  failed: ['That did not work', 'Sealed · try other settings'],
  fatal: ['Secure processing area unavailable', 'Closed'],
};

let state = 'loading-tool';
let payload = null; // the integrity-verified tool payload, kept for fresh frames
let active = null; // { iframe, window, instance, loads, timer }
let pendingFrameHtml = null; // the only string the Trusted Types policy will accept
const counters = { accepted: 0, ignored: 0 };

// --- Trusted Types -------------------------------------------------------------
// The page's CSP requires Trusted Types, so iframe.srcdoc only takes values
// produced by this named policy. The policy accepts exactly one string: the
// verified payload for the frame being created at that moment.
const frameHtmlPolicy = window.trustedTypes
  ? window.trustedTypes.createPolicy(SEALED_RUNTIME.trustedTypesPolicy, {
      createHTML(html) {
        if (pendingFrameHtml === null || html !== pendingFrameHtml) {
          throw new TypeError('OfflineSeal: refusing HTML that is not the verified tool payload');
        }
        return html;
      },
    })
  : null; // no Trusted Types support: srcdoc takes the string directly

// --- Lifecycle ---------------------------------------------------------------------

async function loadTool() {
  setStep('tool', 'active');
  if (!TOOL) return fatal('This page does not name a known tool.', 'tool');
  let text;
  try {
    // The browser checks the downloaded bytes against the pinned SHA-384
    // (Subresource Integrity). A tool that does not match is never used.
    const response = await fetch(new URL(TOOL.path, import.meta.url), {
      integrity: TOOL.integrity,
      credentials: 'omit',
      mode: 'same-origin',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      cache: 'no-cache',
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    text = await response.text();
  } catch {
    return fatal('The tool could not be downloaded, or it did not match its pinned fingerprint.', 'tool');
  }
  if (text.split(SEALED_RUNTIME.instancePlaceholder).length !== 2) {
    return fatal('The tool payload has an unexpected structure.', 'tool');
  }
  payload = text;
  ui.tech.integrity.textContent = TOOL.integrity;
  ui.tech.tool.textContent = `${TOOL.name} ${TOOL.version}`;
  ui.tech.runtime.textContent = SEALED_RUNTIME.runtimeScriptHash;
  ui.tech.frameCsp.textContent = extractFrameCsp(payload) ?? '(missing)';
  setStep('tool', 'done');
  createFrame();
}

function createFrame() {
  destroyFrame();
  const instance = randomId();
  const html = payload.replace(SEALED_RUNTIME.instancePlaceholder, instance);

  const iframe = document.createElement('iframe');
  // Order matters: a frame's sandbox flags are fixed when its document is
  // created. So they are set before srcdoc is assigned and before the iframe is
  // attached to the page. Otherwise the first document could load unsandboxed.
  iframe.setAttribute('sandbox', SEALED_RUNTIME.sandbox.join(' '));
  iframe.setAttribute('referrerpolicy', 'no-referrer');
  iframe.setAttribute('title', 'Private processing area');
  // Belt and braces: until the frame reports that its seal checks passed, the
  // user cannot interact with it at all. The frame also keeps its own picker
  // disabled until then.
  iframe.setAttribute('inert', '');
  iframe.className = 'sealed-frame';

  pendingFrameHtml = html;
  try {
    iframe.srcdoc = frameHtmlPolicy ? frameHtmlPolicy.createHTML(html) : html;
  } finally {
    pendingFrameHtml = null;
  }

  const record = { iframe, window: null, instance, loads: 0, timer: 0 };
  iframe.addEventListener('load', () => onFrameLoad(record));
  ui.frameHost.replaceChildren(iframe);
  record.window = iframe.contentWindow;

  if (!sandboxIsExact(iframe)) return fatal('The processing frame is not sandboxed as required.', 'area');

  active = record;
  ui.tech.sandbox.textContent = iframe.getAttribute('sandbox');
  ui.tech.instance.textContent = instance;
  ui.tech.origin.textContent = 'waiting for the frame…';
  setStep('network', 'active');
  setStep('area', 'pending');
  setState('sealing');

  record.timer = setTimeout(() => {
    if (active === record && state === 'sealing') {
      fatal('The processing area did not finish its security checks in time.', 'network');
    }
  }, READY_TIMEOUT_MS);
}

function destroyFrame() {
  if (!active) return;
  clearTimeout(active.timer);
  // Removing the iframe discards its document, including the image and any
  // result the frame created.
  active.iframe.remove();
  active = null;
}

// The frame's srcdoc document fires one load event. A later one means the frame
// navigated somewhere else. Its policy should have blocked that, but either
// way this frame is no longer the one we sealed, so it is shut down.
function onFrameLoad(record) {
  record.loads += 1;
  if (record.loads > 1 && active === record) {
    fatal('The processing area tried to navigate away and was shut down.', 'area');
  }
}

// --- Messages from the sealed frame -------------------------------------------------
window.addEventListener('message', (event) => {
  const verdict = validateFrameMessage(event, active ? { source: active.window, instance: active.instance } : null);
  if (!verdict.ok) return ignore(verdict.reason);
  const next = nextState(state, verdict.type);
  if (!next) return ignore(`"${verdict.type}" is not expected while ${state}`);
  counters.accepted += 1;
  updateCounters();

  switch (verdict.type) {
    case 'frame-ready':
      if (!sandboxIsExact(active.iframe)) return fatal('The processing frame is not sandboxed as required.', 'area');
      clearTimeout(active.timer);
      active.iframe.removeAttribute('inert');
      ui.tech.origin.textContent = 'null (opaque origin, unique to this frame)';
      setStep('network', 'done');
      setStep('area', 'done');
      return setState(next);
    case 'seal-failed':
      return fatal(`The processing area failed a security check (${verdict.code}).`, 'network');
    case 'file-selected':
      ui.restart.hidden = false;
      return setState(next);
    default:
      // processing-started / processing-complete / processing-failed: status text only.
      return setState(next);
  }
});

function ignore(reason) {
  counters.ignored += 1;
  updateCounters();
  console.warn(`[OfflineSeal] Ignored message: ${reason}`);
}

// --- Files dropped on the page, outside the frame ------------------------------------
// A file dropped on the page itself must neither reach the page nor be opened by
// the browser in this tab. The handlers only cancel the default action and set
// the drop effect; they never read the dropped files or items.
let nudgeTimer = 0;
for (const type of ['dragenter', 'dragover']) {
  window.addEventListener(type, (event) => {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'none';
    showNudge();
  });
}
window.addEventListener('drop', (event) => {
  event.preventDefault();
  showNudge();
});
function showNudge() {
  if (state !== 'ready') return;
  ui.nudge.hidden = false;
  clearTimeout(nudgeTimer);
  nudgeTimer = setTimeout(() => {
    ui.nudge.hidden = true;
  }, 2500);
}

// --- UI --------------------------------------------------------------------------
ui.restart.addEventListener('click', () => {
  ui.restart.hidden = true;
  createFrame();
});
ui.reload.addEventListener('click', () => location.reload());

function setState(next) {
  state = next;
  document.body.dataset.state = next;
  const [heading, status] = STATE_TEXT[next];
  ui.heading.textContent = heading;
  ui.workspaceStatus.textContent = status;
}

function setStep(step, status) {
  const item = document.querySelector(`.checklist [data-step="${step}"]`);
  if (item) item.dataset.status = status;
}

function fatal(message, failedStep) {
  destroyFrame();
  ui.frameHost.replaceChildren();
  if (failedStep) setStep(failedStep, 'failed');
  for (const item of document.querySelectorAll('.checklist [data-status="active"]')) item.dataset.status = 'pending';
  ui.restart.hidden = true;
  ui.fatalText.textContent = message;
  ui.fatal.hidden = false;
  setState('fatal');
}

function updateCounters() {
  ui.tech.messages.textContent = `${counters.accepted} accepted · ${counters.ignored} ignored`;
}

function sandboxIsExact(iframe) {
  const live = [...iframe.sandbox].sort().join(' ');
  return live === [...SEALED_RUNTIME.sandbox].sort().join(' ') && iframe.hasAttribute('sandbox');
}

function extractFrameCsp(html) {
  const match = /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/.exec(html);
  return match ? match[1] : null;
}

function randomId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

ui.tech.shellCsp.textContent =
  document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content ?? '(missing)';
setState('loading-tool');
loadTool();
