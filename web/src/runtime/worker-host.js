// Worker host: the generic part of every tool Worker. The build inlines it
// after tool-schema.js, worker-protocol.js, seal-check.js and a generated
// TOOL_MANIFEST constant, and before the tool's own code.
//
// It speaks the Worker protocol, checks the Worker's seal before any file is
// touched, enforces "one job per Worker", applies the manifest's input limits,
// and checks the tool's result against the manifest before posting it.
//
// This host runs in the same JavaScript realm as the tool's code, so it is a
// convenience and a first line of checks, not a security boundary. The
// boundary is the Worker itself (opaque origin, the frame's CSP, no DOM, no
// storage, terminated after one job), plus the frame runtime, which validates
// every message again on its side.
//
// A tool registers itself with:
//   OfflineSealTool.define({
//     selfCheck() -> { options: { <choiceId>: [values] } }  // optional
//     async inspect(files, ctx) -> { summary, preview?, controls? }
//     async run(files, params, ctx) -> { summary, preview?, outputs: [{ file, name, summary }] }
//   })
// and reports user-facing failures with OfflineSealTool.fail(code, message).

/* global ToolSchema, WorkerProtocol, SealCheck, TOOL_MANIFEST */

SealCheck.removeWebRtc(self);

// eslint-disable-next-line no-unused-vars
const OfflineSealTool = (() => {
  'use strict';

  const manifest = ToolSchema.validateManifest(TOOL_MANIFEST);
  let tool = null;
  let jobTaken = false;
  let currentJob = null;

  class ToolFailure extends Error {
    constructor(code, message) {
      super(message);
      this.code = code;
    }
  }

  function reply(message, transfer = []) {
    self.postMessage({ protocol: WorkerProtocol.ID, ...message }, transfer);
  }

  function failed(job, code, message = '') {
    const safe = WorkerProtocol.FAILURE_CODES.includes(code) ? code : 'tool-failed';
    reply({ type: 'processing-failed', job, code: safe, message: String(message).slice(0, ToolSchema.CAPS.maxMessageLength) });
  }

  async function workerIsSealed() {
    if (self.origin !== 'null') return false;
    if (typeof self.document !== 'undefined') return false;
    if (!SealCheck.removeWebRtc(self)) return false;
    // No persistent storage for an opaque origin: nothing outlives this Worker.
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

  async function selfCheck(job) {
    try {
      if (!(await workerIsSealed()) || !tool) throw new ToolFailure('worker-seal-failed', '');
      const caps = ToolSchema.validateCapabilities(manifest, tool.selfCheck ? await tool.selfCheck() : { options: {} });
      reply({ type: 'self-check-passed', job, capabilities: caps });
    } catch (e) {
      failed(job, e instanceof ToolFailure ? e.code : 'worker-seal-failed', '');
    }
  }

  async function process(request) {
    const { job, operation, files, params, previewMax } = request;
    reply({ type: 'processing-started', job });
    try {
      // Check the seal again for this Worker before reading a single byte.
      if (!(await workerIsSealed())) throw new ToolFailure('worker-seal-failed', '');
      let total = 0;
      for (const f of files) {
        if (f.size > manifest.input.maxBytesPerFile) throw new ToolFailure('too-large', `${f.name} is larger than ${ToolSchema.formatBytes(manifest.input.maxBytesPerFile)}.`);
        total += f.size;
      }
      if (total > manifest.input.maxTotalBytes) throw new ToolFailure('too-large', `Together these files are larger than ${ToolSchema.formatBytes(manifest.input.maxTotalBytes)}.`);

      const ctx = Object.freeze({ previewMax });
      const raw = operation === 'inspect' ? await tool.inspect(files, ctx) : await tool.run(files, params, ctx);
      let result;
      try {
        result =
          operation === 'inspect'
            ? ToolSchema.validateInspectResult(manifest, raw, { Blob, ImageBitmap }, null)
            : ToolSchema.validateRunResult(manifest, raw, { Blob, ImageBitmap });
      } catch {
        throw new ToolFailure('output-invalid', '');
      }
      const transfer = result.preview ? [result.preview] : [];
      const clean = operation === 'inspect' ? raw : { ...raw, outputs: raw.outputs.map((o, i) => ({ ...o, name: result.outputs[i].name })) };
      reply({ type: 'processing-complete', job, operation, result: clean }, transfer);
    } catch (e) {
      if (e instanceof ToolFailure) failed(job, e.code, e.message);
      else failed(job, 'tool-failed', '');
    }
  }

  self.addEventListener('message', (event) => {
    const request = WorkerProtocol.validateRequest(event.data, { File: self.File }, manifest);
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
        else process(request);
    }
  });

  return Object.freeze({
    define(definition) {
      if (tool) throw new Error('OfflineSealTool.define called twice');
      if (!definition || typeof definition.inspect !== 'function' || typeof definition.run !== 'function') {
        throw new Error('A tool must define inspect() and run()');
      }
      tool = Object.freeze({ ...definition });
    },
    fail(code, message) {
      throw new ToolFailure(code, message);
    },
    manifest,
    formatBytes: ToolSchema.formatBytes,
  });
})();
