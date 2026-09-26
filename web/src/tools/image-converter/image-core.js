// Image Converter tool: pure helpers (format sniffing, encoder table, resize
// steps, names). No DOM and no network. The build inlines this file into the
// Image Converter's Worker code only; the trusted frame never contains it.
// The unit tests load it with node:vm.

// eslint-disable-next-line no-unused-vars
const ImageCore = (() => {
  'use strict';

  const LIMITS = Object.freeze({
    // Decoded pixel budget for the source image (about 100 megapixels). The
    // file-size and output-size limits live in the manifest.
    maxInputPixels: 100_000_000,
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
    sniffImageType,
    defaultOutputType,
    downscaleSteps,
    outputFileName,
    formatBytes,
    sizeChange,
  });
})();
