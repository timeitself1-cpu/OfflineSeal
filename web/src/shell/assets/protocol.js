// The complete vocabulary the sealed processing frame may use to talk to the
// OfflineSeal Web shell, and the checks the shell applies to every message.
//
// Design rules:
//  - Messages flow in one direction only: frame -> shell. The shell never sends
//    anything to the frame, so the frame has no inbound message surface.
//  - Every message is status only. None carries file bytes, file names, URLs,
//    sizes or free text. Two message types carry a `code`, taken from a fixed
//    list.
//  - Nothing here can make the shell fetch, open, navigate, upload or run
//    anything. An unknown or malformed message is dropped and counted.

export const PROTOCOL_ID = 'offlineseal.web.v1';

export const SEAL_FAILURE_CODES = Object.freeze([
  'manifest-invalid',
  'not-framed',
  'not-opaque-origin',
  'parent-reachable',
  'csp-not-enforced',
  'webrtc-available',
  'missing-capability',
  'worker-check-failed',
]);

export const PROCESSING_FAILURE_CODES = Object.freeze([
  'too-large',
  'unsupported-input',
  'invalid-input',
  'tool-failed',
  'output-rejected',
  'worker-failed',
]);

// type -> the exact set of keys that type's message must have (no more, no fewer)
// and the list its `code` must come from, if it has one.
export const MESSAGE_TYPES = Object.freeze({
  'frame-ready': Object.freeze({ codes: null }),
  'seal-failed': Object.freeze({ codes: SEAL_FAILURE_CODES }),
  'file-selected': Object.freeze({ codes: null }),
  'processing-started': Object.freeze({ codes: null }),
  'processing-complete': Object.freeze({ codes: null }),
  'processing-failed': Object.freeze({ codes: PROCESSING_FAILURE_CODES }),
});

// Shell lifecycle. The frame's messages can only move the shell along these
// edges. Anything else (e.g. `processing-complete` before a file was selected)
// is out of order and is dropped.
export const TRANSITIONS = Object.freeze({
  sealing: Object.freeze({ 'frame-ready': 'ready', 'seal-failed': 'fatal' }),
  ready: Object.freeze({ 'file-selected': 'file-selected' }),
  'file-selected': Object.freeze({ 'processing-started': 'processing' }),
  processing: Object.freeze({ 'processing-complete': 'complete', 'processing-failed': 'failed' }),
  complete: Object.freeze({ 'processing-started': 'processing' }),
  failed: Object.freeze({ 'processing-started': 'processing' }),
});

// Validate a MessageEvent received by the shell.
//
// expected = { source: <the live iframe's contentWindow>, instance: <id> }
//
// Returns { ok: true, type, code } or { ok: false, reason }. `reason` is fixed text
// written by the shell, never text taken from the message.
export function validateFrameMessage(event, expected) {
  if (!expected || !expected.source) return reject('no active frame');
  if (!event || event.source !== expected.source) return reject('not from the active processing frame');
  // A sandboxed frame without allow-same-origin has an opaque origin, which
  // postMessage reports as the string "null". Anything else means this is not
  // the sealed frame the shell created.
  if (event.origin !== 'null') return reject('sender origin is not opaque');

  const data = event.data;
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return reject('not a plain object');
  const proto = Object.getPrototypeOf(data);
  if (proto !== Object.prototype && proto !== null) return reject('not a plain object');

  const keys = Object.keys(data);
  if (data.protocol !== PROTOCOL_ID) return reject('wrong protocol');
  if (typeof data.instance !== 'string' || data.instance !== expected.instance) return reject('wrong frame instance');
  if (typeof data.type !== 'string' || !Object.hasOwn(MESSAGE_TYPES, data.type)) return reject('unknown message type');

  const spec = MESSAGE_TYPES[data.type];
  const allowedKeys = spec.codes ? ['protocol', 'instance', 'type', 'code'] : ['protocol', 'instance', 'type'];
  if (keys.length !== allowedKeys.length || !allowedKeys.every((k) => keys.includes(k))) {
    return reject('unexpected message fields');
  }
  if (spec.codes && (typeof data.code !== 'string' || !spec.codes.includes(data.code))) {
    return reject('unknown code');
  }
  return { ok: true, type: data.type, code: spec.codes ? data.code : null };
}

// Returns the next state, or null if `type` is not allowed in `state`.
export function nextState(state, type) {
  const edges = Object.hasOwn(TRANSITIONS, state) ? TRANSITIONS[state] : null;
  return edges && Object.hasOwn(edges, type) ? edges[type] : null;
}

function reject(reason) {
  return { ok: false, reason };
}
