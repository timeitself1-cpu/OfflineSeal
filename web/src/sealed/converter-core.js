// Pure image-converter logic. No DOM and no network: just numbers, bytes and
// strings. The build inlines this file into the sealed frame's single
// hash-pinned script. The unit tests load it with node:vm.
//
// Written as a classic script that defines one binding (SealedCore), so the build
// can inline it unchanged and the tests can evaluate it without a bundler.

// eslint-disable-next-line no-unused-vars
const SealedCore = (() => {
  'use strict';

  const LIMITS = Object.freeze({
    // Anything larger is almost certainly not a single image a person means to convert
    // here, and decoding it could exhaust the tab's memory.
    maxInputBytes: 100 * 1024 * 1024,
    // Decoded pixel budget for the source image (about 100 megapixels).
    maxInputPixels: 100_000_000,
    // Canvas limits vary by browser. These stay well inside all current desktop engines.
    maxOutputDimension: 16_384,
    maxOutputPixels: 64_000_000,
  });

  // Output encoders. Every current desktop browser can encode PNG and JPEG.
  // WebP encoding is missing in Safari, so the frame probes the encoder at startup.
  const OUTPUT_TYPES = Object.freeze({
    'image/jpeg': Object.freeze({ label: 'JPEG', ext: 'jpg', lossy: true, alpha: false }),
    'image/png': Object.freeze({ label: 'PNG', ext: 'png', lossy: false, alpha: true }),
    'image/webp': Object.freeze({ label: 'WebP', ext: 'webp', lossy: true, alpha: true }),
  });

  const INPUT_LABELS = Object.freeze({
    'image/png': 'PNG',
    'image/jpeg': 'JPEG',
    'image/webp': 'WebP',
    'image/gif': 'GIF',
    'image/bmp': 'BMP',
    'image/avif': 'AVIF',
  });

  const ACCEPT_ATTRIBUTE = Object.keys(INPUT_LABELS).join(',') + ',.png,.jpg,.jpeg,.webp,.gif,.bmp,.avif';

  const startsWith = (bytes, sig, offset = 0) =>
    bytes.length >= offset + sig.length && sig.every((b, i) => bytes[offset + i] === b);

  const ascii = (s) => Array.from(s, (c) => c.charCodeAt(0));

  // Identify the format from the file's first bytes, not from its name or the
  // browser-reported MIME type, which may be missing or wrong.
  function sniffImageType(bytes) {
    if (!bytes || typeof bytes.length !== 'number') return null;
    if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
    if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
    if (startsWith(bytes, ascii('RIFF')) && startsWith(bytes, ascii('WEBP'), 8)) return 'image/webp';
    if (startsWith(bytes, ascii('GIF87a')) || startsWith(bytes, ascii('GIF89a'))) return 'image/gif';
    if (startsWith(bytes, ascii('BM')) && bytes.length >= 26) return 'image/bmp';
    if (startsWith(bytes, ascii('ftyp'), 4) && (startsWith(bytes, ascii('avif'), 8) || startsWith(bytes, ascii('avis'), 8))) {
      return 'image/avif';
    }
    return null;
  }

  function defaultOutputType(inputType, supported) {
    const preferred = inputType === 'image/jpeg' ? 'image/webp' : 'image/jpeg';
    if (supported.includes(preferred)) return preferred;
    return supported[0] || null;
  }

  const clampInt = (n, lo, hi) => Math.min(hi, Math.max(lo, Math.round(n)));

  // Work out the output size from what the user typed. Always returns whole
  // pixels within the output limits, keeping the aspect ratio if asked.
  function fitSize({ sourceWidth, sourceHeight, width, height, keepAspect, changed }) {
    const sw = Math.max(1, sourceWidth | 0);
    const sh = Math.max(1, sourceHeight | 0);
    let w = Number.isFinite(width) && width > 0 ? width : sw;
    let h = Number.isFinite(height) && height > 0 ? height : sh;
    if (keepAspect) {
      if (changed === 'height') w = (h * sw) / sh;
      else h = (w * sh) / sw;
    }
    const max = LIMITS.maxOutputDimension;
    // Scale down uniformly if a side exceeds the dimension limit or the area exceeds
    // the pixel budget, so the aspect ratio is preserved when clamping.
    let scale = Math.min(1, max / w, max / h);
    const area = w * scale * (h * scale);
    if (area > LIMITS.maxOutputPixels) scale *= Math.sqrt(LIMITS.maxOutputPixels / area);
    return { width: clampInt(w * scale, 1, max), height: clampInt(h * scale, 1, max) };
  }

  function scaleSize(sourceWidth, sourceHeight, percent) {
    const p = Math.max(1, Math.min(100, percent)) / 100;
    return fitSize({ sourceWidth, sourceHeight, width: sourceWidth * p, keepAspect: true, changed: 'width' });
  }

  // Large reductions look noticeably better when done in steps of at most 2x.
  // Returns the list of intermediate sizes ending with the target.
  function downscaleSteps(sourceWidth, sourceHeight, targetWidth, targetHeight) {
    const steps = [];
    let w = sourceWidth;
    let h = sourceHeight;
    while (w / 2 >= targetWidth && h / 2 >= targetHeight) {
      w = Math.max(targetWidth, Math.floor(w / 2));
      h = Math.max(targetHeight, Math.floor(h / 2));
      steps.push({ width: w, height: h });
    }
    const last = steps[steps.length - 1];
    if (!last || last.width !== targetWidth || last.height !== targetHeight) {
      steps.push({ width: targetWidth, height: targetHeight });
    }
    return steps;
  }

  function outputFileName(inputName, outputType) {
    const ext = OUTPUT_TYPES[outputType] ? OUTPUT_TYPES[outputType].ext : 'img';
    const raw = typeof inputName === 'string' ? inputName : '';
    const base =
      raw
        .replace(/\.[A-Za-z0-9]{1,5}$/, '')
        // Keep file names portable: no path separators or control and reserved characters.
        .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, '-')
        .replace(/^[.\s-]+|[.\s-]+$/g, '')
        .slice(0, 120) || 'image';
    const candidate = `${base}.${ext}`;
    return candidate.toLowerCase() === raw.toLowerCase() ? `${base}-converted.${ext}` : candidate;
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

  function sizeChange(before, after) {
    if (!(before > 0) || !(after >= 0)) return '';
    const pct = Math.round(((after - before) / before) * 100);
    if (pct === 0) return 'same size as original';
    return pct < 0 ? `${-pct}% smaller than original` : `${pct}% larger than original`;
  }

  return Object.freeze({
    LIMITS,
    OUTPUT_TYPES,
    INPUT_LABELS,
    ACCEPT_ATTRIBUTE,
    sniffImageType,
    defaultOutputType,
    fitSize,
    scaleSize,
    downscaleSteps,
    outputFileName,
    formatBytes,
    sizeChange,
  });
})();
