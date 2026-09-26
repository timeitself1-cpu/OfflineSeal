// The complete vocabulary between the sealed frame and its processing Workers,
// and the checks both sides apply. Pure logic: no DOM, no network. The build
// inlines this file into both the frame script and the Worker script. The unit
// tests load it with node:vm.
//
//   frame -> worker   self-check · process-image · cancel · destroy
//   worker -> frame   self-check-passed · processing-started ·
//                     processing-complete · processing-failed
//
// A Worker takes exactly one job (a self-check or one process-image) and is
// then terminated by the frame. Nothing here names a URL, runs code, or asks
// the other side to do anything but the one image job.
//
// `env` passes in the calling realm's File / Blob / ImageBitmap constructors,
// so instanceof checks use the right realm (and so tests can supply shims).

// eslint-disable-next-line no-unused-vars
const WorkerProtocol = (() => {
  'use strict';

  const ID = 'offlineseal.worker.v1';

  const INPUT_TYPES = Object.freeze(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp', 'image/avif']);
  const OUTPUT_TYPES = Object.freeze(['image/jpeg', 'image/png', 'image/webp']);
  const OPERATIONS = Object.freeze(['inspect', 'convert']);
  const FAILURE_CODES = Object.freeze([
    'worker-seal-failed',
    'too-large',
    'not-an-image',
    'decode-failed',
    'too-many-pixels',
    'encode-failed',
    'output-type-unsupported',
    'output-verification-failed',
  ]);
  const MAX_DIMENSION = 16_384;

  const isPlainObject = (v) => {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
    const proto = Object.getPrototypeOf(v);
    // Structured-cloned objects get the receiving realm's Object.prototype. Its
    // constructor is named "Object" but it is not this realm's Object.prototype
    // when the tests evaluate the protocol in a separate vm context.
    return proto === null || Object.getPrototypeOf(proto) === null;
  };
  const hasExactly = (obj, keys) => {
    const own = Object.keys(obj);
    return own.length === keys.length && keys.every((k) => own.includes(k));
  };
  const isDimension = (n) => Number.isInteger(n) && n >= 1 && n <= MAX_DIMENSION;
  const isSize = (v) => isPlainObject(v) && hasExactly(v, ['width', 'height']) && isDimension(v.width) && isDimension(v.height);
  const isJobId = (v) => typeof v === 'string' && /^[0-9a-f]{32}$/.test(v);

  const ok = (fields) => Object.assign({ ok: true }, fields);
  const reject = (reason) => ({ ok: false, reason });

  // --- frame -> worker ---------------------------------------------------------
  function validateRequest(data, env) {
    if (!isPlainObject(data)) return reject('not a plain object');
    if (data.protocol !== ID) return reject('wrong protocol');
    switch (data.type) {
      case 'destroy':
        return hasExactly(data, ['protocol', 'type']) ? ok({ type: 'destroy' }) : reject('unexpected fields');
      case 'self-check':
      case 'cancel':
        if (!hasExactly(data, ['protocol', 'type', 'job'])) return reject('unexpected fields');
        return isJobId(data.job) ? ok({ type: data.type, job: data.job }) : reject('bad job id');
      case 'process-image':
        break;
      default:
        return reject('unknown message type');
    }
    if (!isJobId(data.job)) return reject('bad job id');
    if (!(env && typeof env.File === 'function' && data.file instanceof env.File)) return reject('file is not a File');
    if (!isSize(data.previewMax)) return reject('bad preview size');
    if (data.operation === 'inspect') {
      if (!hasExactly(data, ['protocol', 'type', 'job', 'operation', 'file', 'previewMax'])) return reject('unexpected fields');
      return ok({ type: 'process-image', job: data.job, operation: 'inspect', file: data.file, previewMax: data.previewMax });
    }
    if (data.operation === 'convert') {
      if (!hasExactly(data, ['protocol', 'type', 'job', 'operation', 'file', 'previewMax', 'output'])) return reject('unexpected fields');
      const out = data.output;
      if (!isPlainObject(out) || !hasExactly(out, ['type', 'quality', 'width', 'height'])) return reject('bad output spec');
      if (!OUTPUT_TYPES.includes(out.type)) return reject('bad output type');
      if (!isDimension(out.width) || !isDimension(out.height)) return reject('bad output size');
      if (!(out.quality === null || (typeof out.quality === 'number' && out.quality >= 0.1 && out.quality <= 1))) {
        return reject('bad quality');
      }
      return ok({ type: 'process-image', job: data.job, operation: 'convert', file: data.file, previewMax: data.previewMax, output: out });
    }
    return reject('unknown operation');
  }

  // --- worker -> frame ---------------------------------------------------------
  // expected = { job, operation } for the job this Worker was created for.
  // operation is 'self-check', 'inspect' or 'convert'.
  function validateResponse(data, env, expected) {
    if (!isPlainObject(data)) return reject('not a plain object');
    if (data.protocol !== ID) return reject('wrong protocol');
    if (!expected || data.job !== expected.job) return reject('wrong job');
    const isSelfCheck = expected.operation === 'self-check';
    switch (data.type) {
      case 'processing-started':
        if (isSelfCheck) return reject('not expected for a self-check');
        return hasExactly(data, ['protocol', 'type', 'job']) ? ok({ type: data.type }) : reject('unexpected fields');
      case 'processing-failed':
        if (!hasExactly(data, ['protocol', 'type', 'job', 'code'])) return reject('unexpected fields');
        return FAILURE_CODES.includes(data.code) ? ok({ type: data.type, code: data.code }) : reject('unknown code');
      case 'self-check-passed': {
        if (!isSelfCheck) return reject('not expected for an image job');
        if (!hasExactly(data, ['protocol', 'type', 'job', 'encoders'])) return reject('unexpected fields');
        const enc = data.encoders;
        if (!Array.isArray(enc) || enc.length > OUTPUT_TYPES.length || new Set(enc).size !== enc.length || !enc.every((t) => OUTPUT_TYPES.includes(t))) {
          return reject('bad encoder list');
        }
        return ok({ type: data.type, encoders: enc.slice() });
      }
      case 'processing-complete':
        break;
      default:
        return reject('unknown message type');
    }
    if (isSelfCheck || data.operation !== expected.operation) return reject('wrong operation');
    if (!(env && data.preview instanceof env.ImageBitmap)) return reject('preview is not an ImageBitmap');
    const info = data.info;
    if (!isPlainObject(info)) return reject('bad info');
    if (data.operation === 'inspect') {
      if (!hasExactly(data, ['protocol', 'type', 'job', 'operation', 'info', 'preview'])) return reject('unexpected fields');
      if (!hasExactly(info, ['type', 'width', 'height']) || !INPUT_TYPES.includes(info.type)) return reject('bad info');
      if (!Number.isInteger(info.width) || !Number.isInteger(info.height) || info.width < 1 || info.height < 1) return reject('bad info');
      return ok({ type: data.type, operation: 'inspect', info, preview: data.preview });
    }
    if (!hasExactly(data, ['protocol', 'type', 'job', 'operation', 'info', 'output', 'preview'])) return reject('unexpected fields');
    if (!hasExactly(info, ['type', 'width', 'height', 'size']) || !OUTPUT_TYPES.includes(info.type)) return reject('bad info');
    if (!isDimension(info.width) || !isDimension(info.height) || !Number.isInteger(info.size)) return reject('bad info');
    if (!(data.output instanceof env.Blob) || data.output.type !== info.type || data.output.size !== info.size) {
      return reject('output does not match info');
    }
    return ok({ type: data.type, operation: 'convert', info, output: data.output, preview: data.preview });
  }

  return Object.freeze({ ID, INPUT_TYPES, OUTPUT_TYPES, OPERATIONS, FAILURE_CODES, validateRequest, validateResponse });
})();
