// OfflineSeal Web frame runtime: the trusted, tool-agnostic layer inside the
// sandboxed, opaque-origin processing frame.
//
// This exact script is shared by every tool, byte for byte, so the frame's CSP
// hash is the same for all of them. A tool cannot add code here. It supplies:
//   - a manifest (JSON in an inert data block), which this runtime validates
//     and renders using a fixed set of UI components;
//   - Worker code (base64 in an inert data block), which runs only in
//     disposable Workers, one per job.
//
// What the runtime does with the user's files: it takes File handles from the
// picker or a drop, checks only their metadata (count, size, type, name), and
// hands them to a fresh Worker. It never reads their bytes and never decodes,
// renders or encodes. It shows preview bitmaps a Worker hands back (via a
// 'bitmaprenderer' canvas), and offers result Blobs for download under names
// and types it controls.
//
// Inlined by the build after tool-schema.js, worker-protocol.js, seal-check.js
// and a preamble defining PROTOCOL_ID.

/* global ToolSchema, WorkerProtocol, SealCheck, PROTOCOL_ID */

// --- 1. Before anything else runs ---------------------------------------------------
// a) Remove WebRTC. It is governed by neither CSP nor the iframe sandbox. This
//    is JavaScript-level hardening, not a browser boundary (see the README).
SealCheck.removeWebRtc(window);

// b) Read the tool's two data blocks, then take them out of the document.
function readDataBlock(id) {
  const node = document.getElementById(id);
  const text = node ? node.textContent : '';
  if (node) node.remove();
  return text;
}
const MANIFEST_TEXT = readDataBlock('offlineseal-manifest');
const WORKER_BYTES = (() => {
  try {
    return Uint8Array.from(atob(readDataBlock('offlineseal-worker').trim()), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
})();

// c) The only way this frame can start a Worker. The CSP allows Workers only
//    from blob: URLs, and Trusted Types requires every script URL to come from
//    a named policy. This policy is created first, Trusted Types forbids a
//    second one with the same name, and it accepts exactly one URL: the blob:
//    URL of this payload's own Worker code.
const WORKER_CODE_URL = WORKER_BYTES ? URL.createObjectURL(new Blob([WORKER_BYTES], { type: 'text/javascript' })) : null;
const workerUrlPolicy = window.trustedTypes
  ? window.trustedTypes.createPolicy('offlineseal-worker-script', {
      createScriptURL(url) {
        if (WORKER_CODE_URL === null || url !== WORKER_CODE_URL) {
          throw new TypeError('OfflineSeal: refusing a Worker URL that is not the pinned tool Worker code');
        }
        return url;
      },
    })
  : null;

const manifest = (() => {
  try {
    return ToolSchema.validateManifest(JSON.parse(MANIFEST_TEXT));
  } catch {
    return null;
  }
})();
const INSTANCE = document.querySelector('meta[name="offlineseal-instance"]')?.content ?? '';

// --- 2. The only channel to the shell: fixed status messages ------------------------------
function post(type, code) {
  const message = { protocol: PROTOCOL_ID, instance: INSTANCE, type };
  if (code) message.code = code;
  // targetOrigin '*': this opaque-origin frame cannot name the shell's origin,
  // and the message holds only fixed status strings, never user data.
  window.parent.postMessage(message, '*');
}

// --- 3. Disposable Workers: one per job -------------------------------------------------
// A job is a self-check (before READY, no user data), an `inspect` of the
// chosen files, or a `run`. Each gets a brand-new Worker that is terminated
// when the job completes, fails, times out or is superseded. There is never
// more than one Worker alive.
const PREVIEW_MAX = { width: 1600, height: 1600 };
const SELF_CHECK_TIMEOUT_MS = 5_000;
let activeJob = null;
let capabilities = null;

function randomId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
}

function spawnWorker(operation) {
  const url = workerUrlPolicy ? workerUrlPolicy.createScriptURL(WORKER_CODE_URL) : WORKER_CODE_URL;
  return new Worker(url, { name: `offlineseal-${operation}` });
}

// Resolves to { ok: true, ...validated response } or { ok: false, code, message }.
// The Worker is always destroyed before this resolves.
function runJob(operation, { files = [], params = null } = {}) {
  cancelActiveJob();
  const id = randomId();
  const worker = spawnWorker(operation);
  const job = { id, worker, settled: false, timer: 0, finish: null };
  activeJob = job;
  const timeout =
    operation === 'self-check' ? SELF_CHECK_TIMEOUT_MS : operation === 'inspect' ? manifest.limits.inspectTimeoutMs : manifest.limits.runTimeoutMs;
  const context = { manifest, capabilities, env: { Blob, ImageBitmap } };

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
      job.finish({ ok: false, code: 'worker-timeout', message: '' });
    }, timeout);

    worker.addEventListener('message', (event) => {
      if (job.settled) return;
      const verdict = WorkerProtocol.validateResponse(event.data, { job: id, operation }, context);
      if (!verdict.ok) {
        console.warn(`[OfflineSeal frame] Ignored worker message: ${verdict.reason}`);
        // A result for this job that fails the manifest checks ends the job:
        // the Worker is not given a second chance to answer.
        const d = event.data;
        if (d && typeof d === 'object' && d.protocol === WorkerProtocol.ID && d.job === id && d.type === 'processing-complete') {
          job.finish({ ok: false, code: 'output-rejected', message: '' });
        }
        return;
      }
      if (verdict.type === 'processing-started') return;
      if (verdict.type === 'processing-failed') return job.finish({ ok: false, code: verdict.code, message: verdict.message });
      job.finish(verdict);
    });
    worker.addEventListener('error', (event) => {
      event.preventDefault();
      job.finish({ ok: false, code: 'worker-crashed', message: '' });
    });
    worker.addEventListener('messageerror', () => job.finish({ ok: false, code: 'worker-crashed', message: '' }));

    worker.postMessage(
      operation === 'self-check'
        ? { protocol: WorkerProtocol.ID, type: 'self-check', job: id }
        : { protocol: WorkerProtocol.ID, type: 'process', job: id, operation, files, params, previewMax: PREVIEW_MAX },
    );
  });
}

function destroyWorker(job) {
  try {
    job.worker.postMessage({ protocol: WorkerProtocol.ID, type: 'destroy' });
  } catch {
    /* already gone */
  }
  // terminate() is what actually ends the Worker and discards its memory.
  job.worker.terminate();
  if (activeJob === job) activeJob = null;
}

function cancelActiveJob() {
  if (activeJob && activeJob.finish) activeJob.finish({ ok: false, code: 'superseded', message: '' });
  activeJob = null;
}
window.addEventListener('pagehide', cancelActiveJob);

// --- 4. Elements and state ------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const el = {
  dzTitle: $('dz-title'),
  dzSub: $('dz-sub'),
  choose: $('choose'),
  input: $('file'),
  source: $('source'),
  sourceName: $('source-name'),
  sourceMeta: $('source-meta'),
  preview: $('preview'),
  previewBox: $('preview-box'),
  mainControl: $('main-control'),
  settings: $('settings'),
  controls: $('controls'),
  action: $('action'),
  result: $('result'),
  resultThumb: $('result-thumb'),
  resultSummary: $('result-summary'),
  outputs: $('outputs'),
  notes: $('notes'),
  messages: [$('dz-message'), $('message')],
};

// sealing -> ready -> opening -> loaded <-> processing -> done
// Files are accepted only in `ready`: after the seal checks (frame and Worker)
// have passed, and before this frame has taken any files. The shell creates a
// fresh frame for every new set of files.
let state = 'sealing';
let files = null; // File handles, never read here
const controls = new Map(); // id -> { spec, root, get(), init(v) }
const objectUrls = [];

function setState(next) {
  state = next;
  document.body.dataset.state = next;
  const accepting = next === 'ready';
  el.choose.disabled = !accepting;
  el.input.disabled = !accepting;
  el.action.disabled = next !== 'loaded' && next !== 'done';
}

function showMessage(text) {
  for (const m of el.messages) {
    m.textContent = text;
    m.hidden = !text;
  }
}

function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'text') node.textContent = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k === 'hidden' || k === 'checked' || k === 'disabled') node[k] = v;
    else node.setAttribute(k, v);
  }
  node.append(...children.filter(Boolean));
  return node;
}

// Show a bitmap produced by a Worker. 'bitmaprenderer' takes ownership of the
// bitmap for display. The runtime draws nothing and reads no pixels.
function showBitmap(box, bitmap, label) {
  const canvas = h('canvas', { 'aria-label': label });
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.style.width = `${Math.max(1, Math.round(bitmap.width / dpr))}px`;
  canvas.style.aspectRatio = `${bitmap.width} / ${bitmap.height}`;
  canvas.getContext('bitmaprenderer').transferFromImageBitmap(bitmap);
  box.replaceChildren(canvas);
}

// --- 5. Seal self-check -------------------------------------------------------------------
async function verifySeal() {
  if (!manifest || !WORKER_CODE_URL) return 'manifest-invalid';
  if (window.parent === window) return 'not-framed';
  // An opaque origin serialises as "null": the sandbox is in effect without
  // allow-same-origin.
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
  // A throwaway Worker proves that Workers start only as intended, are sealed
  // (opaque origin, connect-src 'none', no storage), and reports what the tool
  // can do. It never sees user data.
  let check;
  try {
    check = await runJob('self-check');
  } catch {
    return 'worker-check-failed';
  }
  if (!check.ok) return 'worker-check-failed';
  capabilities = check.capabilities;
  return null;
}

// --- 6. File intake: metadata checks, then straight to a Worker ---------------------------
const INTAKE_ERRORS = {
  'too-large': 'This is too large to process here.',
  'unsupported-input': 'This file type is not supported by this tool.',
  'invalid-input': 'This file could not be read.',
};

function intakeProblem(list) {
  const input = manifest.input;
  if (list.length < input.minFiles) return `Choose at least ${input.minFiles} files.`;
  if (list.length > input.maxFiles) return input.maxFiles === 1 ? 'Choose one file at a time.' : `Choose at most ${input.maxFiles} files.`;
  let total = 0;
  for (const f of list) {
    const name = f.name.toLowerCase();
    const typeOk = input.accept.includes(f.type) || input.extensions.some((ext) => name.endsWith(ext));
    if (!typeOk) return `${f.name} is not a supported file type.`;
    if (f.size > input.maxBytesPerFile) return `${f.name} is larger than ${ToolSchema.formatBytes(input.maxBytesPerFile)}.`;
    total += f.size;
  }
  if (total > input.maxTotalBytes) return `Together these files are larger than ${ToolSchema.formatBytes(input.maxTotalBytes)}.`;
  return null;
}

async function admit(list) {
  if (state !== 'ready') return;
  const chosen = Array.from(list || []);
  if (chosen.length === 0) return;
  showMessage('');
  const problem = intakeProblem(chosen);
  if (problem) return showMessage(problem);
  setState('opening');
  const result = await runJob('inspect', { files: chosen });
  if (!result.ok) {
    setState('ready');
    showMessage(result.message || INTAKE_ERRORS[result.code] || 'These files could not be opened.');
    return;
  }
  files = chosen;
  setState('loaded');
  post('file-selected');
  renderSource(result.result);
  renderControls(result.result.controls);
}

function renderSource(result) {
  el.sourceName.textContent = files.length === 1 ? files[0].name || 'File' : `${files.length} files`;
  el.sourceMeta.textContent = result.summary.join(' · ');
  el.source.hidden = false;
  el.settings.hidden = false;
  if (result.preview) {
    el.preview.hidden = false;
    showBitmap(el.previewBox, result.preview, 'Preview of your file');
  }
  el.notes.replaceChildren(...(manifest.notes || []).map((n) => h('p', { text: n })));
}

// --- 7. Controls: a fixed component vocabulary, rendered from the manifest ----------------
function currentChoice(id) {
  const c = controls.get(id);
  return c ? c.get() : undefined;
}

function syncVisibility() {
  for (const { spec, root } of controls.values()) {
    if (spec.showWhen) root.hidden = !spec.showWhen.in.includes(currentChoice(spec.showWhen.control));
  }
}

function changed() {
  syncVisibility();
  invalidateResult();
}

function renderControls(inits) {
  el.controls.replaceChildren();
  el.mainControl.replaceChildren();
  controls.clear();
  for (const spec of manifest.controls) {
    const control = BUILDERS[spec.type](spec, inits[spec.id]);
    controls.set(spec.id, control);
    (spec.type === 'itemList' ? el.mainControl : el.controls).append(control.root);
  }
  el.mainControl.hidden = el.mainControl.childElementCount === 0;
  el.action.textContent = manifest.action.label;
  syncVisibility();
  invalidateResult();
}

const labelFor = (spec) => h('span', { class: 'label', id: `label-${spec.id}`, text: spec.label });

const BUILDERS = {
  choice(spec, init) {
    const allowed = capabilities && capabilities.options[spec.id] ? capabilities.options[spec.id] : spec.options.map((o) => o.value);
    const options = spec.options.filter((o) => allowed.includes(o.value));
    let value = init ? init.value : allowed.includes(spec.default) ? spec.default : options[0].value;
    const group = h('div', { class: 'segmented', role: 'radiogroup', 'aria-labelledby': `label-${spec.id}` });
    for (const o of options) {
      const radio = h('input', { type: 'radio', name: `control-${spec.id}`, value: o.value, checked: o.value === value });
      radio.addEventListener('change', () => {
        value = o.value;
        changed();
      });
      group.append(h('label', { class: 'segment' }, radio, h('span', { text: o.label })));
    }
    const root = h('div', { class: 'field', dataset: { control: spec.id } }, labelFor(spec), group);
    return { spec, root, get: () => value };
  },

  range(spec, init) {
    let value = init ? init.value : spec.default;
    const out = h('output', { text: `${value}${spec.unit}` });
    const slider = h('input', { type: 'range', id: `control-${spec.id}`, min: String(spec.min), max: String(spec.max), step: String(spec.step), value: String(value) });
    slider.addEventListener('input', () => {
      value = Number(slider.value);
      out.textContent = `${value}${spec.unit}`;
      invalidateResult();
    });
    const label = h('label', { class: 'label', for: `control-${spec.id}` }, document.createTextNode(spec.label + ' '), out);
    return { spec, root: h('div', { class: 'field', dataset: { control: spec.id } }, label, slider), get: () => value };
  },

  dimensions(spec, init) {
    const base = init.base;
    const limits = { maxDimension: spec.maxDimension, maxArea: spec.maxArea };
    let value = ToolSchema.scaleSize(base, 100, limits);
    const width = h('input', { type: 'number', min: '1', max: String(spec.maxDimension), inputmode: 'numeric', 'aria-label': 'Width', dataset: { dim: 'width' } });
    const height = h('input', { type: 'number', min: '1', max: String(spec.maxDimension), inputmode: 'numeric', 'aria-label': 'Height', dataset: { dim: 'height' } });
    const lock = h('input', { type: 'checkbox', checked: true, dataset: { lock: '' } });
    const presets = h('div', { class: 'scales', role: 'group', 'aria-label': 'Quick resize' });
    const set = (v) => {
      value = v;
      width.value = String(v.width);
      height.value = String(v.height);
      for (const b of presets.children) {
        const s = ToolSchema.scaleSize(base, Number(b.dataset.scale), limits);
        b.setAttribute('aria-pressed', String(s.width === v.width && s.height === v.height));
      }
    };
    for (const p of spec.presets) {
      const b = h('button', { type: 'button', dataset: { scale: String(p) }, text: `${p}%` });
      b.addEventListener('click', () => {
        set(ToolSchema.scaleSize(base, p, limits));
        invalidateResult();
      });
      presets.append(b);
    }
    const onInput = (which) => {
      set(ToolSchema.fitSize({ base, width: Number(width.value), height: Number(height.value), keepAspect: lock.checked, changed: which, ...limits }));
      invalidateResult();
    };
    width.addEventListener('change', () => onInput('width'));
    height.addEventListener('change', () => onInput('height'));
    lock.addEventListener('change', () => onInput('width'));
    set(value);
    const label = h('span', { class: 'label' }, document.createTextNode(spec.label + ' '), h('small', { text: spec.unit }));
    const root = h(
      'div',
      { class: 'field', dataset: { control: spec.id } },
      label,
      h('div', { class: 'dims' }, width, h('span', { 'aria-hidden': 'true', text: '×' }), height),
      h('label', { class: 'check' }, lock, document.createTextNode(' ' + spec.lockLabel)),
      presets,
    );
    return { spec, root, get: () => ({ width: value.width, height: value.height }) };
  },

  text(spec, init) {
    const field = h('input', { type: 'text', id: `control-${spec.id}`, maxlength: String(spec.maxLength), placeholder: spec.placeholder, spellcheck: 'false', autocomplete: 'off' });
    field.value = init ? init.value : spec.default;
    field.addEventListener('input', () => {
      // Keep only characters the manifest's pattern allows.
      const clean = [...field.value].filter((ch) => ToolSchema.textPatternAllows(spec.pattern, ch)).join('').substring(0, spec.maxLength);
      if (clean !== field.value) field.value = clean;
      invalidateResult();
    });
    const root = h('div', { class: 'field', dataset: { control: spec.id } }, h('label', { class: 'label', for: `control-${spec.id}`, text: spec.label }), field);
    return { spec, root, get: () => field.value };
  },

  hint(spec) {
    return { spec, root: h('p', { class: 'hint', dataset: { control: spec.id }, text: spec.text }), get: () => undefined };
  },

  itemList(spec, init) {
    // Items are plain data from the Worker's inspect result: key, label,
    // detail, rotation. The runtime owns the order and the edits.
    const items = init.items.map((it) => ({ ...it, removed: false }));
    const list = h('ol', { class: 'items' });
    const count = h('span', { class: 'count' });
    const render = (focus) => {
      let position = 0;
      list.replaceChildren(
        ...items.map((it, index) => {
          if (!it.removed) position += 1;
          const ops = h('span', { class: 'item-ops' });
          const button = (op, text, label, disabled = false) => h('button', { type: 'button', dataset: { op }, 'aria-label': `${label} ${it.label}`, title: label, text, disabled });
          if (spec.reorder) ops.append(button('up', '↑', 'Move up', index === 0), button('down', '↓', 'Move down', index === items.length - 1));
          if (spec.rotate) ops.append(button('rotate-left', '⟲', 'Rotate left'), button('rotate-right', '⟳', 'Rotate right'));
          if (spec.remove) ops.append(button('remove', it.removed ? 'Restore' : 'Remove', it.removed ? 'Restore' : 'Remove'));
          return h(
            'li',
            { class: it.removed ? 'item removed' : 'item', dataset: { key: it.key } },
            h('span', { class: 'pos', text: it.removed ? '–' : String(position) }),
            h('span', { class: 'item-text' }, h('strong', { text: it.label }), h('small', { text: it.detail })),
            h('span', { class: 'rot', text: it.rotation ? `↻ ${it.rotation}°` : '', hidden: !it.rotation }),
            ops,
          );
        }),
      );
      const kept = items.filter((it) => !it.removed).length;
      count.textContent = `${kept} of ${items.length} ${spec.itemNoun}${items.length === 1 ? '' : 's'}`;
      if (focus) list.querySelector(`li[data-key="${focus.key}"] button[data-op="${focus.op}"]`)?.focus();
    };
    list.addEventListener('click', (e) => {
      const button = e.target.closest('button[data-op]');
      if (!button) return;
      const index = items.findIndex((it) => it.key === button.closest('li').dataset.key);
      if (index < 0) return;
      const it = items[index];
      switch (button.dataset.op) {
        case 'up':
          if (index > 0) [items[index - 1], items[index]] = [items[index], items[index - 1]];
          break;
        case 'down':
          if (index < items.length - 1) [items[index + 1], items[index]] = [items[index], items[index + 1]];
          break;
        case 'rotate-left':
          it.rotation = (it.rotation + 270) % 360;
          break;
        case 'rotate-right':
          it.rotation = (it.rotation + 90) % 360;
          break;
        case 'remove':
          it.removed = !it.removed;
          break;
      }
      render({ key: it.key, op: button.dataset.op });
      invalidateResult();
    });
    render();
    const root = h('div', { class: 'item-list', dataset: { control: spec.id } }, h('div', { class: 'list-head' }, labelFor(spec), count), list);
    return { spec, root, get: () => items.filter((it) => !it.removed).map((it) => ({ key: it.key, rotation: it.rotation })) };
  },
};

function collectParams() {
  const params = {};
  for (const [id, c] of controls) if (c.spec.type !== 'hint') params[id] = c.get();
  return params;
}

function invalidateResult() {
  for (const url of objectUrls.splice(0)) URL.revokeObjectURL(url);
  el.outputs.replaceChildren();
  el.resultThumb.replaceChildren();
  el.resultSummary.replaceChildren();
  el.result.hidden = true;
  if (state === 'done') setState('loaded');
}

// --- 8. Run: in a fresh Worker ---------------------------------------------------------
const SHELL_FAILURE_CODES = { 'too-large': 'too-large', 'unsupported-input': 'unsupported-input', 'invalid-input': 'invalid-input', 'tool-failed': 'tool-failed', 'output-invalid': 'output-rejected', 'output-rejected': 'output-rejected' };

async function run() {
  if (state !== 'loaded' && state !== 'done') return;
  invalidateResult();
  showMessage('');
  const params = collectParams();
  const list = manifest.controls.find((c) => c.type === 'itemList');
  if (list && params[list.id].length < list.minItems) return showMessage(`Keep at least ${list.minItems} ${list.itemNoun}.`);
  try {
    ToolSchema.validateParams(manifest, params);
  } catch {
    return showMessage('Some settings are not valid.');
  }
  setState('processing');
  post('processing-started');
  const outcome = await runJob('run', { files, params });
  if (!outcome.ok) {
    setState('loaded');
    showMessage(outcome.message || 'That did not work. Try other settings.');
    post('processing-failed', SHELL_FAILURE_CODES[outcome.code] || 'worker-failed');
    return;
  }
  renderResult(outcome.result);
  setState('done');
  post('processing-complete');
}

function renderResult(result) {
  el.resultSummary.replaceChildren(...result.summary.map((line, i) => h(i === 0 ? 'strong' : 'span', { text: line })));
  if (result.preview) showBitmap(el.resultThumb, result.preview, 'Preview of the result');
  el.resultThumb.hidden = !result.preview;
  const single = result.outputs.length === 1;
  el.outputs.replaceChildren(
    ...result.outputs.map((o, i) => {
      // The Blob is offered for download only. The runtime never reads it.
      const url = URL.createObjectURL(o.file);
      objectUrls.push(url);
      const typeLabel = manifest.outputs.types.find((t) => t.type === o.file.type).label;
      const link = h('a', { class: single ? 'primary wide download' : 'download', href: url, download: o.name, dataset: { output: String(i) }, text: single ? `Download ${typeLabel}` : 'Download' });
      return h('li', { class: single ? 'output single' : 'output' }, h('span', { class: 'output-text' }, h('strong', { text: o.name }), h('small', { text: o.summary })), link);
    }),
  );
  el.result.hidden = false;
  el.result.scrollIntoView({ block: 'nearest' });
}

// --- 9. Events -------------------------------------------------------------------------
el.choose.addEventListener('click', () => {
  if (state === 'ready') el.input.click();
});
el.input.addEventListener('change', () => {
  const chosen = Array.from(el.input.files || []);
  el.input.value = '';
  admit(chosen);
});
// The whole frame is the drop target. Always cancel the browser's default
// action, which would navigate this frame to the dropped file. Only take files
// in the `ready` state.
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
  admit(e.dataTransfer && e.dataTransfer.files);
});
el.action.addEventListener('click', run);

// --- 10. Start: seal first, then open for files --------------------------------------------
setState('sealing');
(async () => {
  const failure = await verifySeal();
  if (failure) {
    el.dzTitle.textContent = 'Processing area unavailable';
    el.dzSub.textContent = 'The security checks did not pass, so no file can be added here.';
    post('seal-failed', failure);
    return;
  }
  const input = manifest.input;
  el.dzTitle.textContent = input.dropTitle;
  el.dzSub.textContent = input.dropSubtitle;
  el.choose.textContent = input.chooseLabel;
  el.input.accept = [...input.accept, ...input.extensions].join(',');
  el.input.multiple = input.maxFiles > 1;
  setState('ready');
  post('frame-ready');
})();
