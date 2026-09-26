// The generic vocabulary between the trusted frame runtime and a tool's
// processing Workers. It is the same for every tool. Pure logic, inlined by
// the build into the frame runtime and into every tool Worker (after
// tool-schema.js).
//
//   frame -> worker   self-check · process · cancel · destroy
//   worker -> frame   self-check-passed · processing-started ·
//                     processing-complete · processing-failed
//
// A Worker takes exactly one job (a self-check, or one `process` with operation
// `inspect` or `run`), and the frame then terminates it. There is no generic
// command: nothing names a URL, runs code, or asks the frame to do anything
// but show a validated result.

/* global ToolSchema */

// eslint-disable-next-line no-unused-vars
const WorkerProtocol = (() => {
  'use strict';

  const ID = 'offlineseal.worker.v2';
  const OPERATIONS = Object.freeze(['inspect', 'run']);
  const FAILURE_CODES = Object.freeze(['worker-seal-failed', 'too-large', 'unsupported-input', 'invalid-input', 'tool-failed', 'output-invalid']);

  const isPlainObject = (v) => {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
    const proto = Object.getPrototypeOf(v);
    return proto === null || Object.getPrototypeOf(proto) === null;
  };
  const hasExactly = (obj, keys) => {
    const own = Object.keys(obj);
    return own.length === keys.length && keys.every((k) => own.includes(k));
  };
  const isJobId = (v) => typeof v === 'string' && /^[0-9a-f]{32}$/.test(v);
  const isDim = (n) => Number.isInteger(n) && n >= 1 && n <= ToolSchema.CAPS.maxPreviewDimension;
  const ok = (fields) => Object.assign({ ok: true }, fields);
  const reject = (reason) => ({ ok: false, reason });
  const guard = (fn) => {
    try {
      return fn();
    } catch (e) {
      return reject(e instanceof ToolSchema.SchemaError ? e.message : 'invalid');
    }
  };

  // --- frame -> worker (checked by the Worker host) --------------------------------------
  // env = { File }, manifest = the tool's validated manifest.
  function validateRequest(data, env, manifest) {
    if (!isPlainObject(data)) return reject('not a plain object');
    if (data.protocol !== ID) return reject('wrong protocol');
    switch (data.type) {
      case 'destroy':
        return hasExactly(data, ['protocol', 'type']) ? ok({ type: 'destroy' }) : reject('unexpected fields');
      case 'self-check':
      case 'cancel':
        if (!hasExactly(data, ['protocol', 'type', 'job'])) return reject('unexpected fields');
        return isJobId(data.job) ? ok({ type: data.type, job: data.job }) : reject('bad job id');
      case 'process':
        break;
      default:
        return reject('unknown message type');
    }
    if (!hasExactly(data, ['protocol', 'type', 'job', 'operation', 'files', 'params', 'previewMax'])) return reject('unexpected fields');
    if (!isJobId(data.job)) return reject('bad job id');
    if (!OPERATIONS.includes(data.operation)) return reject('unknown operation');
    const files = data.files;
    const input = manifest.input;
    if (!Array.isArray(files) || files.length < input.minFiles || files.length > input.maxFiles) return reject('bad file count');
    if (!(env && typeof env.File === 'function' && files.every((f) => f instanceof env.File))) return reject('files are not Files');
    const pm = data.previewMax;
    if (!isPlainObject(pm) || !hasExactly(pm, ['width', 'height']) || !isDim(pm.width) || !isDim(pm.height)) return reject('bad preview size');
    if (data.operation === 'inspect') {
      if (data.params !== null) return reject('inspect takes no params');
      return ok({ type: 'process', job: data.job, operation: 'inspect', files, params: null, previewMax: pm });
    }
    return guard(() => ok({ type: 'process', job: data.job, operation: 'run', files, params: ToolSchema.validateParams(manifest, data.params), previewMax: pm }));
  }

  // --- worker -> frame (checked by the frame runtime) --------------------------------------
  // expected = { job, operation } where operation is 'self-check', 'inspect' or 'run'.
  // context = { manifest, capabilities, env: { Blob, ImageBitmap } }.
  function validateResponse(data, expected, context) {
    if (!isPlainObject(data)) return reject('not a plain object');
    if (data.protocol !== ID) return reject('wrong protocol');
    if (!expected || data.job !== expected.job) return reject('wrong job');
    const isSelfCheck = expected.operation === 'self-check';
    switch (data.type) {
      case 'processing-started':
        if (isSelfCheck) return reject('not expected for a self-check');
        return hasExactly(data, ['protocol', 'type', 'job']) ? ok({ type: data.type }) : reject('unexpected fields');
      case 'processing-failed':
        if (!hasExactly(data, ['protocol', 'type', 'job', 'code', 'message'])) return reject('unexpected fields');
        if (!FAILURE_CODES.includes(data.code)) return reject('unknown code');
        if (typeof data.message !== 'string' || data.message.length > ToolSchema.CAPS.maxMessageLength || /[\u0000-\u0008\u000b-\u001f\u007f]/.test(data.message)) {
          return reject('bad message');
        }
        return ok({ type: data.type, code: data.code, message: data.message });
      case 'self-check-passed':
        if (!isSelfCheck) return reject('not expected for a job');
        if (!hasExactly(data, ['protocol', 'type', 'job', 'capabilities'])) return reject('unexpected fields');
        return guard(() => ok({ type: data.type, capabilities: ToolSchema.validateCapabilities(context.manifest, data.capabilities) }));
      case 'processing-complete':
        break;
      default:
        return reject('unknown message type');
    }
    if (isSelfCheck || data.operation !== expected.operation) return reject('wrong operation');
    if (!hasExactly(data, ['protocol', 'type', 'job', 'operation', 'result'])) return reject('unexpected fields');
    return guard(() =>
      ok({
        type: data.type,
        result:
          data.operation === 'inspect'
            ? ToolSchema.validateInspectResult(context.manifest, data.result, context.env, context.capabilities)
            : ToolSchema.validateRunResult(context.manifest, data.result, context.env),
      }),
    );
  }

  return Object.freeze({ ID, OPERATIONS, FAILURE_CODES, validateRequest, validateResponse });
})();
