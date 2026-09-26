// The OfflineSeal Web tool contract: the manifest format, and every check the
// trusted runtime applies to what a tool declares or returns.
//
// A tool is exactly two things:
//   1. a manifest (declarative JSON): what files it accepts, which controls
//      to show, and which output types it may produce;
//   2. Worker code: the only place the tool's logic runs.
// A tool never gets DOM access, never ships HTML or CSS, and never adds code to
// the trusted frame. The frame renders the manifest's controls from a fixed
// component vocabulary, hands the files to a fresh Worker per job, and accepts
// only results that pass the checks below.
//
// Pure logic: no DOM and no network. The build inlines this file into the
// frame runtime and into every tool's Worker, and also uses it to validate
// manifests at build time. The unit tests load it with node:vm.
//
// `env` passes in the calling realm's Blob / ImageBitmap constructors.

// eslint-disable-next-line no-unused-vars
const ToolSchema = (() => {
  'use strict';

  const MANIFEST_VERSION = 'offlineseal.tool.v1';

  // Output types the runtime will ever offer as a download, with the file
  // extension the runtime forces. Deliberately inert formats only: no HTML,
  // SVG, XML or scripts. A downloaded HTML file opened later from disk would
  // have network access, so it could leak whatever the tool put in it.
  const OUTPUT_TYPES = Object.freeze({
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'application/pdf': 'pdf',
  });

  // Hard caps, whatever a manifest asks for.
  const CAPS = Object.freeze({
    maxFiles: 50,
    maxBytesPerFile: 512 * 1024 * 1024,
    maxTotalBytes: 1024 * 1024 * 1024,
    maxOutputs: 1000,
    maxControls: 16,
    maxOptions: 8,
    minTimeoutMs: 1_000,
    maxTimeoutMs: 600_000,
    maxSummaryLines: 8,
    maxSummaryLength: 200,
    maxMessageLength: 300,
    maxPreviewDimension: 4096,
    maxItems: 10_000,
    maxDimension: 65_535,
  });

  const CONTROL_TYPES = Object.freeze(['choice', 'range', 'dimensions', 'text', 'hint', 'itemList']);
  const ROTATIONS = Object.freeze([0, 90, 180, 270]);

  class SchemaError extends Error {}
  const fail = (msg) => {
    throw new SchemaError(msg);
  };

  const isPlainObject = (v) => {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
    const proto = Object.getPrototypeOf(v);
    return proto === null || Object.getPrototypeOf(proto) === null;
  };
  const keysExactly = (obj, required, optional = []) => {
    if (!isPlainObject(obj)) return false;
    const keys = Object.keys(obj);
    return required.every((k) => keys.includes(k)) && keys.every((k) => required.includes(k) || optional.includes(k));
  };
  const isText = (v, max, { allowEmpty = false } = {}) =>
    typeof v === 'string' && v.length <= max && (allowEmpty || v.length > 0) && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v);
  const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
  const isNum = (v, lo, hi) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
  const ID = /^[a-z][a-z0-9-]{0,31}$/;
  const ITEM_KEY = /^[A-Za-z0-9:_-]{1,64}$/;
  const deepFreeze = (v) => {
    if (v && typeof v === 'object') {
      for (const k of Object.keys(v)) deepFreeze(v[k]);
      Object.freeze(v);
    }
    return v;
  };

  // --- manifest ---------------------------------------------------------------------
  function validateManifest(m) {
    if (!keysExactly(m, ['manifest', 'id', 'version', 'name', 'shell', 'input', 'outputs', 'controls', 'action', 'limits'], ['notes'])) {
      fail('manifest: unexpected or missing top-level fields');
    }
    if (m.manifest !== MANIFEST_VERSION) fail('manifest: unsupported manifest version');
    if (!/^[a-z][a-z0-9-]{1,39}$/.test(m.id)) fail('manifest: bad id');
    if (!/^\d+\.\d+\.\d+$/.test(m.version)) fail('manifest: bad version');
    if (!isText(m.name, 60)) fail('manifest: bad name');

    const s = m.shell;
    if (!keysExactly(s, ['path', 'title', 'lede', 'restartLabel'])) fail('shell: bad fields');
    if (!ID.test(s.path) || s.path === 'assets' || s.path === 'index') fail('shell: bad path');
    for (const k of ['title', 'restartLabel']) if (!isText(s[k], 60)) fail(`shell: bad ${k}`);
    if (!isText(s.lede, 160)) fail('shell: bad lede');

    const i = m.input;
    if (!keysExactly(i, ['accept', 'extensions', 'minFiles', 'maxFiles', 'maxBytesPerFile', 'maxTotalBytes', 'dropTitle', 'dropSubtitle', 'chooseLabel'])) {
      fail('input: bad fields');
    }
    if (!Array.isArray(i.accept) || i.accept.length === 0 || i.accept.length > 16 || !i.accept.every((t) => /^[a-z]+\/[a-z0-9.+-]+$/.test(t))) {
      fail('input: bad accept list');
    }
    if (!Array.isArray(i.extensions) || i.extensions.length > 16 || !i.extensions.every((e) => /^\.[a-z0-9]{1,5}$/.test(e))) {
      fail('input: bad extensions');
    }
    if (!isInt(i.minFiles, 1, CAPS.maxFiles) || !isInt(i.maxFiles, i.minFiles, CAPS.maxFiles)) fail('input: bad file counts');
    if (!isInt(i.maxBytesPerFile, 1, CAPS.maxBytesPerFile) || !isInt(i.maxTotalBytes, i.maxBytesPerFile, CAPS.maxTotalBytes)) {
      fail('input: bad byte limits');
    }
    for (const k of ['dropTitle', 'chooseLabel']) if (!isText(i[k], 40)) fail(`input: bad ${k}`);
    if (!isText(i.dropSubtitle, 120)) fail('input: bad dropSubtitle');

    const o = m.outputs;
    if (!keysExactly(o, ['types', 'maxFiles'])) fail('outputs: bad fields');
    if (!Array.isArray(o.types) || o.types.length === 0) fail('outputs: no types');
    const seen = new Set();
    for (const t of o.types) {
      if (!keysExactly(t, ['type', 'label']) || !Object.hasOwn(OUTPUT_TYPES, t.type) || !isText(t.label, 12) || seen.has(t.type)) {
        fail('outputs: type not allowed by the runtime');
      }
      seen.add(t.type);
    }
    if (!isInt(o.maxFiles, 1, CAPS.maxOutputs)) fail('outputs: bad maxFiles');

    if (!Array.isArray(m.controls) || m.controls.length > CAPS.maxControls) fail('controls: bad list');
    const ids = new Set();
    let mainPlacements = 0;
    for (const c of m.controls) {
      validateControl(c);
      if (ids.has(c.id)) fail(`controls: duplicate id ${c.id}`);
      ids.add(c.id);
      if (c.type === 'itemList') mainPlacements += 1;
    }
    if (mainPlacements > 1) fail('controls: at most one itemList');
    for (const c of m.controls) {
      if (!c.showWhen) continue;
      const target = m.controls.find((x) => x.id === c.showWhen.control);
      if (!target || target.type !== 'choice' || target === c) fail(`controls: ${c.id}: showWhen must name another choice`);
      if (!c.showWhen.in.every((v) => target.options.some((opt) => opt.value === v))) fail(`controls: ${c.id}: showWhen values`);
    }

    if (!keysExactly(m.action, ['label']) || !isText(m.action.label, 30)) fail('action: bad');
    const l = m.limits;
    if (!keysExactly(l, ['inspectTimeoutMs', 'runTimeoutMs'])) fail('limits: bad fields');
    for (const k of ['inspectTimeoutMs', 'runTimeoutMs']) if (!isInt(l[k], CAPS.minTimeoutMs, CAPS.maxTimeoutMs)) fail(`limits: bad ${k}`);
    if (m.notes !== undefined && (!Array.isArray(m.notes) || m.notes.length > 4 || !m.notes.every((n) => isText(n, 200)))) {
      fail('notes: bad');
    }
    return deepFreeze(JSON.parse(JSON.stringify(m)));
  }

  function validateControl(c) {
    if (!isPlainObject(c) || !CONTROL_TYPES.includes(c.type)) fail('controls: unknown control type');
    if (!ID.test(c.id)) fail('controls: bad id');
    const common = ['type', 'id'];
    const opt = ['showWhen'];
    if (c.showWhen !== undefined) {
      const w = c.showWhen;
      if (!keysExactly(w, ['control', 'in']) || !ID.test(w.control) || !Array.isArray(w.in) || w.in.length === 0 || w.in.length > CAPS.maxOptions) {
        fail(`controls: ${c.id}: bad showWhen`);
      }
    }
    switch (c.type) {
      case 'choice':
        if (!keysExactly(c, [...common, 'label', 'options', 'default'], [...opt, 'capability'])) fail(`controls: ${c.id}: bad fields`);
        if (!Array.isArray(c.options) || c.options.length < 2 || c.options.length > CAPS.maxOptions) fail(`controls: ${c.id}: bad options`);
        for (const o of c.options) {
          if (!keysExactly(o, ['value', 'label']) || !/^[a-z0-9/.+-]{1,40}$/.test(o.value) || !isText(o.label, 20)) fail(`controls: ${c.id}: bad option`);
        }
        if (new Set(c.options.map((o) => o.value)).size !== c.options.length) fail(`controls: ${c.id}: duplicate option`);
        if (!c.options.some((o) => o.value === c.default)) fail(`controls: ${c.id}: bad default`);
        if (c.capability !== undefined && c.capability !== true) fail(`controls: ${c.id}: bad capability flag`);
        break;
      case 'range':
        if (!keysExactly(c, [...common, 'label', 'min', 'max', 'step', 'default', 'unit'], opt)) fail(`controls: ${c.id}: bad fields`);
        if (!isNum(c.min, -1e6, 1e6) || !isNum(c.max, c.min, 1e6) || !isNum(c.step, 1e-6, 1e6) || !isNum(c.default, c.min, c.max)) {
          fail(`controls: ${c.id}: bad range`);
        }
        if (!isText(c.unit, 8, { allowEmpty: true })) fail(`controls: ${c.id}: bad unit`);
        break;
      case 'dimensions':
        if (!keysExactly(c, [...common, 'label', 'unit', 'lockLabel', 'presets', 'maxDimension', 'maxArea'], opt)) fail(`controls: ${c.id}: bad fields`);
        if (!Array.isArray(c.presets) || c.presets.length > 6 || !c.presets.every((p) => isInt(p, 1, 100))) fail(`controls: ${c.id}: bad presets`);
        if (!isInt(c.maxDimension, 1, CAPS.maxDimension) || !isInt(c.maxArea, 1, 2 ** 31)) fail(`controls: ${c.id}: bad limits`);
        if (!isText(c.unit, 12, { allowEmpty: true }) || !isText(c.lockLabel, 40)) fail(`controls: ${c.id}: bad labels`);
        break;
      case 'text':
        if (!keysExactly(c, [...common, 'label', 'placeholder', 'maxLength', 'default', 'pattern'], opt)) fail(`controls: ${c.id}: bad fields`);
        if (!isInt(c.maxLength, 1, 1000) || !isText(c.default, c.maxLength, { allowEmpty: true }) || !isText(c.placeholder, 80, { allowEmpty: true })) {
          fail(`controls: ${c.id}: bad text spec`);
        }
        // A character-class pattern the runtime enforces before a job starts,
        // e.g. "0-9, -". Only ASCII letters, digits, space, and , - . are allowed.
        if (!/^[A-Za-z0-9 ,.\-]{1,40}$/.test(c.pattern)) fail(`controls: ${c.id}: bad pattern`);
        break;
      case 'hint':
        if (!keysExactly(c, [...common, 'text'], opt) || !isText(c.text, 200)) fail(`controls: ${c.id}: bad hint`);
        break;
      case 'itemList':
        if (!keysExactly(c, [...common, 'label', 'itemNoun', 'reorder', 'rotate', 'remove', 'minItems', 'maxItems'], opt)) fail(`controls: ${c.id}: bad fields`);
        if (![c.reorder, c.rotate, c.remove].every((b) => typeof b === 'boolean')) fail(`controls: ${c.id}: bad flags`);
        if (!isInt(c.minItems, 1, CAPS.maxItems) || !isInt(c.maxItems, c.minItems, CAPS.maxItems)) fail(`controls: ${c.id}: bad item limits`);
        if (!isText(c.itemNoun, 20)) fail(`controls: ${c.id}: bad noun`);
        if (c.showWhen !== undefined) fail(`controls: ${c.id}: an itemList is always shown`);
        break;
    }
    if (c.label !== undefined && !isText(c.label, 40)) fail(`controls: ${c.id}: bad label`);
  }

  // Characters a text control accepts, expanded from its pattern spec. The
  // spec is literal characters plus "0-9", "a-z" and "A-Z" ranges.
  function textPatternAllows(pattern, value) {
    const allowed = new Set();
    const spec = pattern.replace(/0-9|a-z|A-Z/g, (r) => {
      const [lo, hi] = [r.charCodeAt(0), r.charCodeAt(2)];
      for (let c = lo; c <= hi; c++) allowed.add(String.fromCharCode(c));
      return '';
    });
    for (const ch of spec) allowed.add(ch);
    return [...value].every((ch) => allowed.has(ch));
  }

  // --- capabilities (self-check result) -------------------------------------------------
  function validateCapabilities(manifest, caps) {
    if (!keysExactly(caps, ['options'])) fail('capabilities: bad fields');
    if (!isPlainObject(caps.options)) fail('capabilities: bad options');
    const out = {};
    for (const [id, values] of Object.entries(caps.options)) {
      const c = manifest.controls.find((x) => x.id === id);
      if (!c || c.type !== 'choice' || c.capability !== true) fail(`capabilities: ${id} is not a capability choice`);
      if (!Array.isArray(values) || values.length === 0 || new Set(values).size !== values.length) fail(`capabilities: ${id}: bad values`);
      if (!values.every((v) => c.options.some((o) => o.value === v))) fail(`capabilities: ${id}: unknown value`);
      out[id] = values.slice();
    }
    for (const c of manifest.controls) {
      if (c.type === 'choice' && c.capability === true && !out[c.id]) fail(`capabilities: missing ${c.id}`);
    }
    return { options: out };
  }

  // --- results ------------------------------------------------------------------------------
  function checkSummary(summary) {
    if (!Array.isArray(summary) || summary.length > CAPS.maxSummaryLines || !summary.every((s) => isText(s, CAPS.maxSummaryLength))) {
      fail('result: bad summary');
    }
  }
  function checkPreview(preview, env) {
    if (preview === undefined) return;
    if (!(env && typeof env.ImageBitmap === 'function' && preview instanceof env.ImageBitmap)) fail('result: preview is not an ImageBitmap');
    if (!isInt(preview.width, 1, CAPS.maxPreviewDimension) || !isInt(preview.height, 1, CAPS.maxPreviewDimension)) fail('result: preview too large');
  }

  function validateControlInit(manifest, id, init, capabilities) {
    const c = manifest.controls.find((x) => x.id === id);
    if (!c || c.type === 'hint') fail(`result: no control ${id}`);
    switch (c.type) {
      case 'choice': {
        const allowed = capabilities && capabilities.options[id] ? capabilities.options[id] : c.options.map((o) => o.value);
        if (!keysExactly(init, ['value']) || !allowed.includes(init.value)) fail(`result: ${id}: bad value`);
        return { value: init.value };
      }
      case 'range':
        if (!keysExactly(init, ['value']) || !isNum(init.value, c.min, c.max)) fail(`result: ${id}: bad value`);
        return { value: init.value };
      case 'text':
        if (!keysExactly(init, ['value']) || !isText(init.value, c.maxLength, { allowEmpty: true }) || !textPatternAllows(c.pattern, init.value)) {
          fail(`result: ${id}: bad value`);
        }
        return { value: init.value };
      case 'dimensions': {
        if (!keysExactly(init, ['base'])) fail(`result: ${id}: bad init`);
        const b = init.base;
        if (!keysExactly(b, ['width', 'height']) || !isInt(b.width, 1, 1_000_000) || !isInt(b.height, 1, 1_000_000)) fail(`result: ${id}: bad base`);
        return { base: { width: b.width, height: b.height } };
      }
      case 'itemList': {
        if (!keysExactly(init, ['items']) || !Array.isArray(init.items)) fail(`result: ${id}: bad init`);
        if (init.items.length < c.minItems || init.items.length > c.maxItems) fail(`result: ${id}: item count`);
        const keys = new Set();
        const items = init.items.map((it) => {
          if (!keysExactly(it, ['key', 'label', 'detail', 'rotation'])) fail(`result: ${id}: bad item`);
          if (!ITEM_KEY.test(it.key) || keys.has(it.key)) fail(`result: ${id}: bad item key`);
          keys.add(it.key);
          if (!isText(it.label, 120) || !isText(it.detail, 120, { allowEmpty: true }) || !ROTATIONS.includes(it.rotation)) fail(`result: ${id}: bad item`);
          return { key: it.key, label: it.label, detail: it.detail, rotation: it.rotation };
        });
        return { items };
      }
    }
    return fail('unreachable');
  }

  function validateInspectResult(manifest, result, env, capabilities) {
    if (!keysExactly(result, ['summary'], ['preview', 'controls'])) fail('result: bad fields');
    checkSummary(result.summary);
    checkPreview(result.preview, env);
    const controls = {};
    if (result.controls !== undefined) {
      if (!isPlainObject(result.controls)) fail('result: bad controls');
      for (const [id, init] of Object.entries(result.controls)) controls[id] = validateControlInit(manifest, id, init, capabilities);
    }
    const list = manifest.controls.find((c) => c.type === 'itemList');
    if (list && !controls[list.id]) fail(`result: ${list.id} must be initialised`);
    for (const c of manifest.controls) {
      if (c.type === 'dimensions' && !controls[c.id]) fail(`result: ${c.id} must be initialised`);
    }
    return { summary: result.summary.slice(), preview: result.preview, controls };
  }

  function validateRunResult(manifest, result, env) {
    if (!keysExactly(result, ['summary', 'outputs'], ['preview'])) fail('result: bad fields');
    checkSummary(result.summary);
    checkPreview(result.preview, env);
    const outs = result.outputs;
    if (!Array.isArray(outs) || outs.length === 0 || outs.length > manifest.outputs.maxFiles) fail('result: bad output count');
    const allowed = manifest.outputs.types.map((t) => t.type);
    const outputs = outs.map((o) => {
      if (!keysExactly(o, ['file', 'name', 'summary'])) fail('result: bad output fields');
      if (!(env && typeof env.Blob === 'function' && o.file instanceof env.Blob)) fail('result: output is not a Blob');
      if (!allowed.includes(o.file.type)) fail('result: output type not declared in the manifest');
      if (o.file.size === 0) fail('result: empty output');
      if (!isText(o.name, 200) || !isText(o.summary, CAPS.maxSummaryLength, { allowEmpty: true })) fail('result: bad output text');
      return { file: o.file, name: safeFileName(o.name, OUTPUT_TYPES[o.file.type]), summary: o.summary };
    });
    return { summary: result.summary.slice(), preview: result.preview, outputs };
  }

  // --- run parameters (frame -> worker) -----------------------------------------------------
  function validateParams(manifest, params) {
    const ids = manifest.controls.filter((c) => c.type !== 'hint').map((c) => c.id);
    if (!keysExactly(params, ids)) fail('params: bad fields');
    for (const c of manifest.controls) {
      const v = params[c.id];
      switch (c.type) {
        case 'choice':
          if (!c.options.some((o) => o.value === v)) fail(`params: ${c.id}`);
          break;
        case 'range':
          if (!isNum(v, c.min, c.max)) fail(`params: ${c.id}`);
          break;
        case 'text':
          if (!isText(v, c.maxLength, { allowEmpty: true }) || !textPatternAllows(c.pattern, v)) fail(`params: ${c.id}`);
          break;
        case 'dimensions':
          if (!keysExactly(v, ['width', 'height']) || !isInt(v.width, 1, c.maxDimension) || !isInt(v.height, 1, c.maxDimension) || v.width * v.height > c.maxArea) {
            fail(`params: ${c.id}`);
          }
          break;
        case 'itemList': {
          if (!Array.isArray(v) || v.length < c.minItems || v.length > c.maxItems) fail(`params: ${c.id}: count`);
          const keys = new Set();
          for (const it of v) {
            if (!keysExactly(it, ['key', 'rotation']) || !ITEM_KEY.test(it.key) || keys.has(it.key) || !ROTATIONS.includes(it.rotation)) fail(`params: ${c.id}: item`);
            keys.add(it.key);
          }
          break;
        }
      }
    }
    return params;
  }

  // --- helpers the runtime uses ---------------------------------------------------------------
  // Portable file name with the extension the runtime chose for the type.
  function safeFileName(name, extension) {
    const base =
      String(name)
        .replace(/\.[A-Za-z0-9]{1,5}$/, '')
        .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, '-')
        .replace(/^[.\s-]+|[.\s-]+$/g, '')
        .slice(0, 120) || 'output';
    return `${base}.${extension}`;
  }

  // Width/height from what the user typed, in whole pixels within limits,
  // keeping the aspect ratio if asked.
  function fitSize({ base, width, height, keepAspect, changed, maxDimension, maxArea }) {
    const sw = Math.max(1, base.width | 0);
    const sh = Math.max(1, base.height | 0);
    let w = Number.isFinite(width) && width > 0 ? width : sw;
    let h = Number.isFinite(height) && height > 0 ? height : sh;
    if (keepAspect) {
      if (changed === 'height') w = (h * sw) / sh;
      else h = (w * sh) / sw;
    }
    let scale = Math.min(1, maxDimension / w, maxDimension / h);
    const area = w * scale * (h * scale);
    if (area > maxArea) scale *= Math.sqrt(maxArea / area);
    const clamp = (n) => Math.min(maxDimension, Math.max(1, Math.round(n)));
    return { width: clamp(w * scale), height: clamp(h * scale) };
  }

  function scaleSize(base, percent, limits) {
    const p = Math.max(1, Math.min(100, percent)) / 100;
    return fitSize({ base, width: base.width * p, keepAspect: true, changed: 'width', ...limits });
  }

  function formatBytes(n) {
    if (!Number.isFinite(n) || n < 0) return '';
    if (n < 1024) return `${n} B`;
    const units = ['KB', 'MB', 'GB'];
    let v = n / 1024;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) {
      v /= 1024;
      i += 1;
    }
    return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
  }

  return Object.freeze({
    MANIFEST_VERSION,
    OUTPUT_TYPES,
    CAPS,
    CONTROL_TYPES,
    ROTATIONS,
    SchemaError,
    validateManifest,
    validateCapabilities,
    validateInspectResult,
    validateRunResult,
    validateParams,
    textPatternAllows,
    safeFileName,
    fitSize,
    scaleSize,
    formatBytes,
  });
})();
