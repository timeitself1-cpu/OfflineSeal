// The sealed frame: a small, trusted UI and bootstrap layer. It runs only
// inside the sandboxed, opaque-origin processing frame. The build inlines it
// after converter-core.js, worker-protocol.js, seal-check.js and a generated
// preamble that defines PROTOCOL_ID and WORKER_SOURCE (the pinned Worker
// code). Together they form the frame's single hash-pinned script.
//
// Division of labour:
//   frame   picks up the File, shows the UI, and runs one disposable Worker per
//           job. It never reads the file's bytes, and never decodes, resizes or
//           encodes. It only displays the preview bitmap the Worker hands back,
//           and offers the result Blob for download.
//   worker  does everything that touches bytes or pixels (image-worker.js).
//
// What this code must never do (enforced by browser policy, and audited by
// test/unit/sealed-audit.test.mjs):
//   - use a network API (the one exception is the data: URL seal check, which
//     never leaves the browser)
//   - send the shell anything except the fixed status messages
//   - listen for messages from anything but its own Workers

/* global SealedCore, WorkerProtocol, SealCheck, PROTOCOL_ID, WORKER_SOURCE */

// --- 1. Before anything else runs --------------------------------------------------
// a) Remove WebRTC. WebRTC traffic (STUN/TURN over UDP) is governed by neither
//    CSP nor the iframe sandbox. In testing, Chromium 141 sent STUN packets
//    from this exact sandbox and CSP. This is JavaScript-level hardening, not
//    a browser-enforced boundary; see the README's threat model.
SealCheck.removeWebRtc(window);

// b) The only way this frame can create a Worker. The frame CSP allows Workers
//    only from blob: URLs (worker-src blob:), and Trusted Types requires every
//    Worker URL to come from a named policy. This policy is created here,
//    first, and Trusted Types forbids a second policy with the same name. It
//    accepts exactly one URL: the blob: URL of the pinned Worker code.
const WORKER_CODE_URL = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: 'text/javascript' }));
const workerUrlPolicy = window.trustedTypes
  ? window.trustedTypes.createPolicy('offlineseal-worker-script', {
      createScriptURL(url) {
        if (url !== WORKER_CODE_URL) throw new TypeError('OfflineSeal: refusing a Worker URL that is not the pinned Worker code');
        return url;
      },
    })
  : null;

const Core = SealedCore;
const INSTANCE = document.querySelector('meta[name="offlineseal-instance"]')?.content ?? '';

// --- 2. The only channel to the shell: fixed status messages ----------------------
function post(type, code) {
  const message = { protocol: PROTOCOL_ID, instance: INSTANCE, type };
  if (code) message.code = code;
  // targetOrigin '*': this opaque-origin frame cannot name the shell's origin,
  // and the message holds only fixed status strings, never user data.
  window.parent.postMessage(message, '*');
}

// --- 3. Disposable Workers: one per job ---------------------------------------------
// A job is a self-check (before READY, no user data), an inspect (decode and
// preview a newly chosen file), or a convert. Each job gets a brand-new Worker
// that is terminated when the job completes, fails, times out, or is
// superseded. There is never more than one Worker alive, so no Worker state can
// reach another job or another file. (Each new file also gets a new frame.)
const JOB_TIMEOUT_MS = { 'self-check': 5_000, inspect: 60_000, convert: 120_000 };
const PREVIEW_MAX = { width: 1600, height: 1600 };
const THUMB_MAX = { width: 128, height: 128 };
let activeJob = null;

function randomId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
}

function spawnWorker(operation) {
  const url = workerUrlPolicy ? workerUrlPolicy.createScriptURL(WORKER_CODE_URL) : WORKER_CODE_URL;
  return new Worker(url, { name: `offlineseal-${operation}` });
}

// Runs one job in a fresh Worker. Resolves to { ok: true, ...validated response }
// or { ok: false, code }. The Worker is always destroyed before this resolves.
function runJob(operation, body, { onStarted } = {}) {
  cancelActiveJob();
  const id = randomId();
  const worker = spawnWorker(operation);
  const job = { id, worker, operation, settled: false, timer: 0, finish: null };
  activeJob = job;

  return new Promise((resolve) => {
    job.finish = (result) => {
      if (job.settled) return;
      job.settled = true;
      clearTimeout(job.timer);
      destroyWorker(job);
      resolve(result);
    };
    job.timer = setTimeout(() => {
      worker.postMessage({ protocol: WorkerProtocol.ID, type: 'cancel', job: id });
      job.finish({ ok: false, code: 'worker-timeout' });
    }, JOB_TIMEOUT_MS[operation]);

    worker.addEventListener('message', (event) => {
      if (job.settled) return;
      const verdict = WorkerProtocol.validateResponse(event.data, { Blob, ImageBitmap }, { job: id, operation });
      if (!verdict.ok) {
        // Unknown or malformed: dropped, never acted on. A Worker that never
        // sends a valid answer runs into the timeout.
        console.warn(`[OfflineSeal frame] Ignored worker message: ${verdict.reason}`);
        return;
      }
      if (verdict.type === 'processing-started') {
        if (onStarted) onStarted();
        return;
      }
      if (verdict.type === 'processing-failed') return job.finish({ ok: false, code: verdict.code });
      job.finish(verdict);
    });
    // An uncaught error inside the Worker, or a message that cannot be
    // deserialised, ends the job (fail closed).
    worker.addEventListener('error', (event) => {
      event.preventDefault();
      job.finish({ ok: false, code: 'worker-crashed' });
    });
    worker.addEventListener('messageerror', () => job.finish({ ok: false, code: 'worker-crashed' }));

    const request = { protocol: WorkerProtocol.ID, type: operation === 'self-check' ? 'self-check' : 'process-image', job: id, ...body };
    worker.postMessage(request);
  });
}

function destroyWorker(job) {
  try {
    job.worker.postMessage({ protocol: WorkerProtocol.ID, type: 'destroy' });
  } catch {
    /* already gone */
  }
  // terminate() is what actually ends the Worker and discards its memory. The
  // destroy message only asks it to close itself as well.
  job.worker.terminate();
  if (activeJob === job) activeJob = null;
}

function cancelActiveJob() {
  if (activeJob && activeJob.finish) activeJob.finish({ ok: false, code: 'superseded' });
  activeJob = null;
}

// Closing or navigating the frame's document terminates its Workers too. This
// makes the intent explicit.
window.addEventListener('pagehide', cancelActiveJob);

// --- 4. Elements -------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const el = {
  dropzone: $('dropzone'),
  dzTitle: $('dz-title'),
  dzSub: $('dz-sub'),
  choose: $('choose'),
  input: $('file'),
  preview: $('preview'),
  previewBox: $('preview-box'),
  sourceName: $('source-name'),
  sourceMeta: $('source-meta'),
  settings: $('settings'),
  formats: $('formats'),
  qualityRow: $('quality-row'),
  quality: $('quality'),
  qualityValue: $('quality-value'),
  width: $('width'),
  height: $('height'),
  keepAspect: $('keep-aspect'),
  scales: $('scales'),
  convert: $('convert'),
  result: $('result'),
  resultThumb: $('result-thumb'),
  resultMeta: $('result-meta'),
  resultNote: $('result-note'),
  formatHint: $('format-hint'),
  download: $('download'),
  messages: [$('dz-message'), $('message')],
};

// --- 5. State ----------------------------------------------------------------------
// sealing -> ready -> opening -> loaded <-> processing -> done
// The file input and drop target accept a file only in `ready`: after the
// seal checks (frame and Worker) have passed, and before this frame has taken
// any file. The shell creates a fresh frame for every new image.
let state = 'sealing';
// The File handle (never read here), plus facts the Worker reported about it.
let source = null; // { file, info: { type, width, height } }
let supportedOutputs = [];
let resultUrl = null;

function setState(next) {
  state = next;
  document.body.dataset.state = next;
  const accepting = next === 'ready';
  el.choose.disabled = !accepting;
  el.input.disabled = !accepting;
  el.convert.disabled = next !== 'loaded' && next !== 'done';
}

// The same message goes to the drop zone and to the settings panel; only the
// one in the currently visible section is seen.
function showMessage(text) {
  for (const m of el.messages) {
    m.textContent = text;
    m.hidden = !text;
  }
}

// Show a bitmap produced by a Worker. The 'bitmaprenderer' context takes
// ownership of the bitmap for display. The frame draws nothing and reads no
// pixels.
function showBitmap(box, bitmap, label) {
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.setAttribute('aria-label', label);
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.style.width = `${Math.max(1, Math.round(bitmap.width / dpr))}px`;
  canvas.style.aspectRatio = `${bitmap.width} / ${bitmap.height}`;
  canvas.getContext('bitmaprenderer').transferFromImageBitmap(bitmap);
  box.replaceChildren(canvas);
}

// --- 6. Seal self-check --------------------------------------------------------------
// Runs before any file is accepted. If a check fails, the frame never becomes
// ready and the shell shows that the processing area is unavailable (fail
// closed).
async function verifySeal() {
  if (window.parent === window) return 'not-framed';
  // An opaque origin serialises as "null". It means the sandbox is in effect
  // without allow-same-origin.
  if (self.origin !== 'null') return 'not-opaque-origin';
  try {
    void window.parent.document;
    return 'parent-reachable';
  } catch {
    /* expected: the shell is cross-origin to this frame */
  }
  if (!SealCheck.removeWebRtc(window)) return 'webrtc-available';
  if (!(await SealCheck.connectIsBlocked(document))) return 'csp-not-enforced';
  if (typeof Worker !== 'function') return 'missing-capability';
  // A throwaway Worker proves that Workers can be created only as intended,
  // are sealed (opaque origin, connect-src 'none', no storage), and can encode.
  // It never sees user data and is terminated right after.
  let check;
  try {
    check = await runJob('self-check', {});
  } catch {
    return 'worker-check-failed';
  }
  if (!check.ok) return 'worker-check-failed';
  supportedOutputs = check.encoders;
  if (supportedOutputs.length === 0) return 'missing-capability';
  return null;
}

// --- 7. File admission: straight to a Worker ----------------------------------------------
const INSPECT_ERRORS = {
  'too-large': `This file is larger than ${Core.formatBytes(Core.LIMITS.maxInputBytes)}.`,
  'not-an-image': 'This file is not a supported image. Choose a PNG, JPEG, WebP, GIF, BMP or AVIF image.',
  'decode-failed': 'This image could not be read by your browser.',
  'too-many-pixels': 'This image has too many pixels to convert safely in the browser.',
};

async function admit(file) {
  if (state !== 'ready' || !file) return;
  setState('opening');
  showMessage('');
  // The File goes straight to a fresh Worker. The frame never reads it.
  const result = await runJob('inspect', { operation: 'inspect', file, previewMax: PREVIEW_MAX });
  if (!result.ok) {
    setState('ready');
    showMessage(INSPECT_ERRORS[result.code] || 'This file could not be opened.');
    return;
  }
  source = { file, info: result.info };
  setState('loaded');
  post('file-selected');
  el.sourceName.textContent = file.name || 'Image';
  el.sourceMeta.textContent = `${Core.INPUT_LABELS[result.info.type]} · ${result.info.width} × ${result.info.height} · ${Core.formatBytes(file.size)}`;
  el.preview.hidden = false;
  el.settings.hidden = false;
  showBitmap(el.previewBox, result.preview, 'Preview of your image');
  configureSettings();
}

// --- 8. Settings ---------------------------------------------------------------------
function configureSettings() {
  el.formats.replaceChildren();
  const initial = Core.defaultOutputType(source.info.type, supportedOutputs);
  for (const type of supportedOutputs) {
    const info = Core.OUTPUT_TYPES[type];
    const label = document.createElement('label');
    label.className = 'segment';
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'format';
    radio.value = type;
    radio.checked = type === initial;
    const span = document.createElement('span');
    span.textContent = info.label;
    label.append(radio, span);
    el.formats.append(label);
  }
  setSize(Core.scaleSize(source.info.width, source.info.height, 100));
  syncQualityVisibility();
  invalidateResult();
}

function selectedType() {
  const checked = el.formats.querySelector('input[name="format"]:checked');
  return checked ? checked.value : supportedOutputs[0];
}

function syncQualityVisibility() {
  const info = Core.OUTPUT_TYPES[selectedType()];
  el.qualityRow.hidden = !info || !info.lossy;
  el.qualityValue.textContent = `${el.quality.value}%`;
  el.formatHint.textContent = info && !info.alpha ? 'Transparent areas become white in JPEG.' : '';
  el.formatHint.hidden = !el.formatHint.textContent;
}

function setSize({ width, height }) {
  el.width.value = String(width);
  el.height.value = String(height);
  for (const b of el.scales.querySelectorAll('button')) {
    const s = Core.scaleSize(source.info.width, source.info.height, Number(b.dataset.scale));
    b.setAttribute('aria-pressed', String(s.width === width && s.height === height));
  }
}

function onSizeInput(changed) {
  const size = Core.fitSize({
    sourceWidth: source.info.width,
    sourceHeight: source.info.height,
    width: Number(el.width.value),
    height: Number(el.height.value),
    keepAspect: el.keepAspect.checked,
    changed,
  });
  setSize(size);
  invalidateResult();
}

function invalidateResult() {
  if (resultUrl) URL.revokeObjectURL(resultUrl);
  resultUrl = null;
  el.download.removeAttribute('href');
  el.result.hidden = true;
  if (state === 'done') setState('loaded');
}

// --- 9. Conversion: in a fresh Worker ----------------------------------------------------
// Worker failure codes the shell's protocol knows. Anything else (a crash, a
// timeout, a failed per-job seal check) is reported as 'worker-failed'.
const SHELL_FAILURE_CODES = ['decode-failed', 'encode-failed', 'output-type-unsupported', 'output-verification-failed', 'too-large'];

async function convert() {
  if (state !== 'loaded' && state !== 'done') return;
  invalidateResult();
  const type = selectedType();
  const spec = Core.OUTPUT_TYPES[type];
  const target = Core.fitSize({
    sourceWidth: source.info.width,
    sourceHeight: source.info.height,
    width: Number(el.width.value),
    height: Number(el.height.value),
    keepAspect: false,
  });
  setState('processing');
  showMessage('');
  post('processing-started');

  const result = await runJob('convert', {
    operation: 'convert',
    file: source.file,
    previewMax: THUMB_MAX,
    output: { type, quality: spec.lossy ? Number(el.quality.value) / 100 : null, width: target.width, height: target.height },
  });
  if (!result.ok) {
    setState('loaded');
    showMessage('That conversion did not work. Try another format or a smaller size.');
    post('processing-failed', SHELL_FAILURE_CODES.includes(result.code) ? result.code : 'worker-failed');
    return;
  }

  // The frame holds the result Blob only to offer it for download. It never
  // reads the Blob's bytes.
  resultUrl = URL.createObjectURL(result.output);
  el.download.href = resultUrl;
  el.download.download = Core.outputFileName(source.file.name, type);
  el.download.textContent = `Download ${spec.label}`;
  el.resultMeta.textContent = `${spec.label} · ${result.info.width} × ${result.info.height} · ${Core.formatBytes(result.info.size)}`;
  el.resultNote.textContent = Core.sizeChange(source.file.size, result.info.size);
  el.result.hidden = false;
  showBitmap(el.resultThumb, result.preview, 'Preview of the converted image');
  el.result.scrollIntoView({ block: 'nearest' });
  setState('done');
  post('processing-complete');
}

// --- 10. Events ----------------------------------------------------------------------
el.input.accept = Core.ACCEPT_ATTRIBUTE;
el.choose.addEventListener('click', () => {
  if (state === 'ready') el.input.click();
});
el.input.addEventListener('change', () => {
  const file = el.input.files && el.input.files[0];
  el.input.value = '';
  admit(file);
});

// The whole frame is the drop target. Always cancel the browser's default
// action, which would navigate this frame to the dropped file. Only take the
// file in the `ready` state.
for (const type of ['dragenter', 'dragover']) {
  document.addEventListener(type, (e) => {
    e.preventDefault();
    const accepting = state === 'ready';
    if (e.dataTransfer) e.dataTransfer.dropEffect = accepting ? 'copy' : 'none';
    document.body.classList.toggle('dragging', accepting);
  });
}
document.addEventListener('dragleave', (e) => {
  if (!e.relatedTarget) document.body.classList.remove('dragging');
});
document.addEventListener('drop', (e) => {
  e.preventDefault();
  document.body.classList.remove('dragging');
  if (state !== 'ready') return;
  const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  admit(file);
});

el.formats.addEventListener('change', () => {
  syncQualityVisibility();
  invalidateResult();
});
el.quality.addEventListener('input', () => {
  el.qualityValue.textContent = `${el.quality.value}%`;
  invalidateResult();
});
el.width.addEventListener('change', () => onSizeInput('width'));
el.height.addEventListener('change', () => onSizeInput('height'));
el.keepAspect.addEventListener('change', () => onSizeInput('width'));
el.scales.addEventListener('click', (e) => {
  const button = e.target.closest('button[data-scale]');
  if (!button || !source) return;
  setSize(Core.scaleSize(source.info.width, source.info.height, Number(button.dataset.scale)));
  invalidateResult();
});
el.convert.addEventListener('click', convert);

// --- 11. Start: seal first, then open for a file --------------------------------------
setState('sealing');
(async () => {
  const failure = await verifySeal();
  if (failure) {
    el.dzTitle.textContent = 'Processing area unavailable';
    el.dzSub.textContent = 'The security checks did not pass, so no file can be added here.';
    post('seal-failed', failure);
    return;
  }
  el.dzTitle.textContent = 'Drop image here';
  el.dzSub.textContent = 'PNG, JPEG, WebP, GIF, BMP or AVIF · stays on this device';
  setState('ready');
  post('frame-ready');
})();
