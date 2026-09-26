// The sealed image converter's DOM glue. It runs only inside the sandboxed,
// opaque-origin processing frame. The build inlines it after converter-core.js
// and a generated line that defines PROTOCOL_ID. All three become the frame's
// single hash-pinned script.
//
// What this code must never do (enforced by browser policy, and audited by
// test/unit/sealed-audit.test.mjs):
//   - use a network API (the one exception is the data: URL self-check below,
//     which never leaves the browser)
//   - send the shell anything except the fixed status messages
//   - listen for messages from anywhere

/* global SealedCore, PROTOCOL_ID */

// --- 1. Remove WebRTC before anything else runs ------------------------------
// WebRTC traffic (STUN/TURN over UDP) is governed by neither CSP nor the iframe
// sandbox in current browsers. In testing, Chromium 141 sent STUN packets from
// this exact sandbox and CSP. The converter never needs WebRTC, so the
// constructors are deleted here, before any other code in this frame runs.
// This is JavaScript-level hardening, not a browser-enforced boundary. It is
// meaningful because this frame cannot load or evaluate any other code:
// script-src is one hash, there is no 'unsafe-eval', and Trusted Types 'none'
// blocks nested srcdoc documents.
for (const name of Object.getOwnPropertyNames(window)) {
  if (/^(webkit|moz)?RTC/.test(name)) {
    try {
      delete window[name];
    } catch {
      /* non-configurable: the seal check below catches it */
    }
  }
}

const Core = SealedCore;
const INSTANCE = document.querySelector('meta[name="offlineseal-instance"]')?.content ?? '';

// --- 2. The only outbound channel: fixed status messages to the shell -------
function post(type, code) {
  const message = { protocol: PROTOCOL_ID, instance: INSTANCE, type };
  if (code) message.code = code;
  // targetOrigin '*': this opaque-origin frame cannot name the shell's origin,
  // and the message holds only fixed status strings, never user data.
  window.parent.postMessage(message, '*');
}

// --- 3. Elements -------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const el = {
  dropzone: $('dropzone'),
  dzTitle: $('dz-title'),
  dzSub: $('dz-sub'),
  choose: $('choose'),
  input: $('file'),
  preview: $('preview'),
  previewCanvas: $('preview-canvas'),
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
  resultCanvas: $('result-canvas'),
  resultMeta: $('result-meta'),
  resultNote: $('result-note'),
  formatHint: $('format-hint'),
  download: $('download'),
  messages: [$('dz-message'), $('message')],
};

// --- 4. State ----------------------------------------------------------------
// sealing -> ready -> loaded <-> processing -> done
// The file input and drop target accept a file only in `ready`: after the
// seal check has passed, and before this frame has taken any file. The shell
// creates a fresh frame for every new image.
let state = 'sealing';
let source = null; // { file, bitmap, type }
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

// --- 5. Seal self-check --------------------------------------------------------
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
  if (Object.getOwnPropertyNames(window).some((n) => /^(webkit|moz)?RTCPeerConnection$/.test(n))) {
    return 'webrtc-available';
  }
  if (!(await connectIsBlocked())) return 'csp-not-enforced';
  if (typeof createImageBitmap !== 'function' || typeof HTMLCanvasElement.prototype.toBlob !== 'function') {
    return 'missing-capability';
  }
  return null;
}

// Confirm that this document's own connect-src 'none' policy is being enforced.
// It tries to fetch a data: URL: if the policy were missing, that request would
// still never touch the network. Two things must both happen: the fetch is
// refused, and the browser reports a violation of a policy that says
// connect-src 'none'. That second part proves it is this frame's own policy,
// not only the one inherited from the shell.
function connectIsBlocked() {
  return new Promise((resolve) => {
    let refused = false;
    let reported = false;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      document.removeEventListener('securitypolicyviolation', onViolation);
      resolve(value);
    };
    const onViolation = (e) => {
      if (e.effectiveDirective === 'connect-src' && /(^|;)\s*connect-src 'none'/.test(e.originalPolicy)) {
        reported = true;
        if (refused) finish(true);
      }
    };
    const timer = setTimeout(() => finish(false), 3000);
    document.addEventListener('securitypolicyviolation', onViolation);
    fetch('data:text/plain,offlineseal-seal-check').then(
      () => finish(false),
      () => {
        refused = true;
        if (reported) finish(true);
      },
    );
  });
}

async function detectEncoders() {
  const canvas = document.createElement('canvas');
  canvas.width = 2;
  canvas.height = 2;
  canvas.getContext('2d').fillRect(0, 0, 1, 1);
  const found = [];
  for (const type of Object.keys(Core.OUTPUT_TYPES)) {
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, type, 0.9));
    // Browsers fall back to PNG for encoders they lack. Only offer a format if
    // the encoder really produced it.
    if (blob && blob.type === type) found.push(type);
  }
  return found;
}

// --- 6. File admission ---------------------------------------------------------
async function admit(file) {
  if (state !== 'ready' || !file) return;
  setState('loaded-pending');
  showMessage('');
  try {
    if (file.size > Core.LIMITS.maxInputBytes) {
      throw userError(`This file is larger than ${Core.formatBytes(Core.LIMITS.maxInputBytes)}.`);
    }
    const head = new Uint8Array(await file.slice(0, 32).arrayBuffer());
    const type = Core.sniffImageType(head);
    if (!type) throw userError('This file is not a supported image. Choose a PNG, JPEG, WebP, GIF, BMP or AVIF image.');
    let bitmap;
    try {
      bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      throw userError(`This ${Core.INPUT_LABELS[type]} image could not be read by your browser.`);
    }
    if (bitmap.width * bitmap.height > Core.LIMITS.maxInputPixels) {
      bitmap.close();
      throw userError('This image has too many pixels to convert safely in the browser.');
    }
    source = { file, bitmap, type };
  } catch (err) {
    setState('ready');
    showMessage(err && err.userMessage ? err.userMessage : 'This file could not be opened.');
    return;
  }

  setState('loaded');
  post('file-selected');
  renderSource();
  configureSettings();
}

function userError(message) {
  const err = new Error(message);
  err.userMessage = message;
  return err;
}

// --- 7. Rendering ----------------------------------------------------------------
function drawFitted(canvas, bitmap) {
  const box = canvas.parentElement.getBoundingClientRect();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const maxW = Math.max(1, Math.floor(box.width));
  const maxH = Math.max(1, Math.floor(box.height));
  const scale = Math.min(1, maxW / bitmap.width, maxH / bitmap.height);
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
}

function renderSource() {
  const { file, bitmap, type } = source;
  el.sourceName.textContent = file.name || 'Image';
  el.sourceMeta.textContent = `${Core.INPUT_LABELS[type]} · ${bitmap.width} × ${bitmap.height} · ${Core.formatBytes(file.size)}`;
  el.preview.hidden = false;
  el.settings.hidden = false;
  drawFitted(el.previewCanvas, bitmap);
}

function configureSettings() {
  el.formats.replaceChildren();
  const initial = Core.defaultOutputType(source.type, supportedOutputs);
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
  setSize(Core.scaleSize(source.bitmap.width, source.bitmap.height, 100));
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
    const s = Core.scaleSize(source.bitmap.width, source.bitmap.height, Number(b.dataset.scale));
    b.setAttribute('aria-pressed', String(s.width === width && s.height === height));
  }
}

function onSizeInput(changed) {
  const size = Core.fitSize({
    sourceWidth: source.bitmap.width,
    sourceHeight: source.bitmap.height,
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

// --- 8. Conversion -------------------------------------------------------------
async function convert() {
  if (state !== 'loaded' && state !== 'done') return;
  invalidateResult();
  const type = selectedType();
  const info = Core.OUTPUT_TYPES[type];
  const target = Core.fitSize({
    sourceWidth: source.bitmap.width,
    sourceHeight: source.bitmap.height,
    width: Number(el.width.value),
    height: Number(el.height.value),
    keepAspect: false,
  });
  setState('processing');
  showMessage('');
  post('processing-started');

  let failure = 'encode-failed';
  try {
    const canvas = render(source.bitmap, target, !info.alpha);
    const quality = info.lossy ? Number(el.quality.value) / 100 : undefined;
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, type, quality));
    if (!blob) throw new Error('encoder returned nothing');
    failure = 'output-type-unsupported';
    if (blob.type !== type) throw new Error('encoder fell back to another format');

    // Decode our own output before offering it, and check it is the format
    // and size we promised (fail closed).
    failure = 'output-verification-failed';
    const check = new Uint8Array(await blob.slice(0, 32).arrayBuffer());
    if (Core.sniffImageType(check) !== type) throw new Error('output signature mismatch');
    const decoded = await createImageBitmap(blob);
    if (decoded.width !== target.width || decoded.height !== target.height) throw new Error('output size mismatch');

    resultUrl = URL.createObjectURL(blob);
    el.download.href = resultUrl;
    el.download.download = Core.outputFileName(source.file.name, type);
    el.download.textContent = `Download ${info.label}`;
    el.resultMeta.textContent = `${info.label} · ${target.width} × ${target.height} · ${Core.formatBytes(blob.size)}`;
    el.resultNote.textContent = Core.sizeChange(source.file.size, blob.size);
    el.result.hidden = false;
    drawFitted(el.resultCanvas, decoded);
    decoded.close();
    el.result.scrollIntoView({ block: 'nearest' });
    setState('done');
    post('processing-complete');
  } catch {
    setState('loaded');
    showMessage('That conversion did not work. Try another format or a smaller size.');
    post('processing-failed', failure);
  }
}

function render(bitmap, target, flattenOnWhite) {
  let current = bitmap;
  let canvas = null;
  for (const step of Core.downscaleSteps(bitmap.width, bitmap.height, target.width, target.height)) {
    canvas = document.createElement('canvas');
    canvas.width = step.width;
    canvas.height = step.height;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(current, 0, 0, step.width, step.height);
    current = canvas;
  }
  if (flattenOnWhite) {
    const ctx = canvas.getContext('2d');
    ctx.globalCompositeOperation = 'destination-over';
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  return canvas;
}

// --- 9. Events -----------------------------------------------------------------
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
  setSize(Core.scaleSize(source.bitmap.width, source.bitmap.height, Number(button.dataset.scale)));
  invalidateResult();
});
el.convert.addEventListener('click', convert);

let resizeTimer = 0;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (source) drawFitted(el.previewCanvas, source.bitmap);
  }, 100);
});

// --- 10. Start: seal first, then open for a file --------------------------------
setState('sealing');
(async () => {
  const failure = await verifySeal();
  if (failure) {
    el.dzTitle.textContent = 'Processing area unavailable';
    el.dzSub.textContent = 'The security checks did not pass, so no file can be added here.';
    post('seal-failed', failure);
    return;
  }
  supportedOutputs = await detectEncoders();
  if (supportedOutputs.length === 0) {
    post('seal-failed', 'missing-capability');
    return;
  }
  el.dzTitle.textContent = 'Drop image here';
  el.dzSub.textContent = 'PNG, JPEG, WebP, GIF, BMP or AVIF · stays on this device';
  setState('ready');
  post('frame-ready');
})();
