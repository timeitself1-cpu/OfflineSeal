// The image-processing Worker. Everything that touches the private file's
// bytes or pixels happens here: sniffing, decoding, resizing, encoding, and
// checking the output.
//
// The frame builds this Worker from the pinned code embedded in its own
// hash-pinned script (a blob: URL that the frame's Trusted Types policy
// accepts, and no other). The Worker:
//   - has an opaque origin, and inherits the frame's CSP: connect-src 'none',
//     no eval, and no importScripts or nested Workers (Trusted Types)
//   - has no DOM, no iframes, no navigation, and no RTCPeerConnection
//   - has no persistent storage (IndexedDB and Cache are unavailable to an
//     opaque origin)
//   - takes exactly one job, then the frame terminates it
//
// Inlined by the build after converter-core.js, worker-protocol.js and
// seal-check.js.

/* global SealedCore, WorkerProtocol, SealCheck */

// Defence in depth: some browsers expose RTCDataChannel and similar in Workers.
SealCheck.removeWebRtc(self);

const Core = SealedCore;
const Protocol = WorkerProtocol;

// One job per Worker. After it, this global holds nothing the frame will ever
// use again: the frame terminates the Worker and starts a new one for the
// next job.
let jobTaken = false;
let currentJob = null;

function reply(message, transfer = []) {
  self.postMessage({ protocol: Protocol.ID, ...message }, transfer);
}

self.addEventListener('message', (event) => {
  const request = Protocol.validateRequest(event.data, { File: self.File });
  // Unknown or malformed requests are dropped without a reply.
  if (!request.ok) return;
  switch (request.type) {
    case 'destroy':
      self.close();
      return;
    case 'cancel':
      if (request.job === currentJob) self.close();
      return;
    default:
      if (jobTaken) return; // a second job for the same Worker is refused
      jobTaken = true;
      currentJob = request.job;
      if (request.type === 'self-check') selfCheck(request.job);
      else processImage(request);
  }
});

// --- self-check (no user data) ------------------------------------------------
// Run once before READY. Proves this Worker is sealed the way the frame
// expects, and reports which encoders exist.
async function selfCheck(job) {
  const sealed = await workerIsSealed();
  const capable = typeof OffscreenCanvas === 'function' && typeof createImageBitmap === 'function';
  if (!sealed || !capable) {
    reply({ type: 'processing-failed', job, code: 'worker-seal-failed' });
    return;
  }
  const encoders = [];
  const canvas = new OffscreenCanvas(2, 2);
  canvas.getContext('2d').fillRect(0, 0, 1, 1);
  for (const type of Protocol.OUTPUT_TYPES) {
    try {
      const blob = await canvas.convertToBlob({ type });
      // Browsers fall back to PNG for encoders they lack.
      if (blob.type === type) encoders.push(type);
    } catch {
      /* not supported */
    }
  }
  reply({ type: 'self-check-passed', job, encoders });
}

async function workerIsSealed() {
  if (self.origin !== 'null') return false;
  if (typeof self.document !== 'undefined') return false;
  if (!SealCheck.removeWebRtc(self)) return false;
  // No persistent storage for an opaque origin, so nothing outlives this Worker.
  try {
    if (typeof indexedDB !== 'undefined') {
      indexedDB.open('offlineseal-seal-check');
      return false;
    }
  } catch {
    /* expected: SecurityError */
  }
  return SealCheck.connectIsBlocked(self);
}

// --- the image job ----------------------------------------------------------------
async function processImage(request) {
  const { job, operation, file, previewMax } = request;
  reply({ type: 'processing-started', job });
  let code = 'worker-seal-failed';
  try {
    // Check the seal again for this Worker before reading a single byte.
    if (!(await workerIsSealed())) throw new Error('seal');

    code = 'too-large';
    if (file.size > Core.LIMITS.maxInputBytes) throw new Error(code);
    code = 'not-an-image';
    const type = Core.sniffImageType(new Uint8Array(await file.slice(0, 32).arrayBuffer()));
    if (!type) throw new Error(code);
    code = 'decode-failed';
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    code = 'too-many-pixels';
    if (bitmap.width * bitmap.height > Core.LIMITS.maxInputPixels) throw new Error(code);
    code = 'decode-failed';

    if (operation === 'inspect') {
      const preview = await makePreview(bitmap, previewMax);
      const info = { type, width: bitmap.width, height: bitmap.height };
      bitmap.close();
      reply({ type: 'processing-complete', job, operation, info, preview }, [preview]);
      return;
    }

    const out = request.output;
    const spec = Core.OUTPUT_TYPES[out.type];
    code = 'encode-failed';
    const canvas = render(bitmap, out, !spec.alpha);
    bitmap.close();
    const blob = await canvas.convertToBlob(spec.lossy && out.quality !== null ? { type: out.type, quality: out.quality } : { type: out.type });

    code = 'output-type-unsupported';
    if (blob.type !== out.type) throw new Error(code);
    // Decode our own output before offering it, and check it is the format
    // and size we promised (fail closed).
    code = 'output-verification-failed';
    if (Core.sniffImageType(new Uint8Array(await blob.slice(0, 32).arrayBuffer())) !== out.type) throw new Error(code);
    const decoded = await createImageBitmap(blob);
    if (decoded.width !== out.width || decoded.height !== out.height) throw new Error(code);
    const preview = await makePreview(decoded, previewMax);
    decoded.close();
    const info = { type: out.type, width: out.width, height: out.height, size: blob.size };
    reply({ type: 'processing-complete', job, operation, info, output: blob, preview }, [preview]);
  } catch {
    reply({ type: 'processing-failed', job, code });
  }
}

// A display-sized copy for the frame to show. It is not the image data the
// user downloads, and the frame never reads its pixels.
function makePreview(bitmap, max) {
  const scale = Math.min(1, max.width / bitmap.width, max.height / bitmap.height);
  return createImageBitmap(bitmap, {
    resizeWidth: Math.max(1, Math.round(bitmap.width * scale)),
    resizeHeight: Math.max(1, Math.round(bitmap.height * scale)),
    resizeQuality: 'high',
  });
}

function render(bitmap, target, flattenOnWhite) {
  let current = bitmap;
  let canvas = null;
  for (const step of Core.downscaleSteps(bitmap.width, bitmap.height, target.width, target.height)) {
    canvas = new OffscreenCanvas(step.width, step.height);
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
