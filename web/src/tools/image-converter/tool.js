// Image Converter: Worker-only tool code. The build inlines it after the
// runtime's Worker host and image-core.js. It runs only inside a disposable
// processing Worker: no DOM, no network, no storage, one job per Worker.

/* global OfflineSealTool, ImageCore */

(() => {
  'use strict';

  const Core = ImageCore;

  async function decode(file) {
    const type = Core.sniffImageType(new Uint8Array(await file.slice(0, 32).arrayBuffer()));
    if (!type) OfflineSealTool.fail('unsupported-input', 'This file is not a supported image. Choose a PNG, JPEG, WebP, GIF, BMP or AVIF image.');
    let bitmap;
    try {
      bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      OfflineSealTool.fail('invalid-input', `This ${Core.INPUT_LABELS[type]} image could not be read by your browser.`);
    }
    if (bitmap.width * bitmap.height > Core.LIMITS.maxInputPixels) {
      bitmap.close();
      OfflineSealTool.fail('too-large', 'This image has too many pixels to convert safely in the browser.');
    }
    return { type, bitmap };
  }

  // A display-sized copy for the frame to show; not the downloadable data.
  function preview(bitmap, max) {
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

  OfflineSealTool.define({
    // Which encoders this browser really has (browsers fall back to PNG).
    async selfCheck() {
      if (typeof OffscreenCanvas !== 'function' || typeof createImageBitmap !== 'function') return { options: { format: [] } };
      const canvas = new OffscreenCanvas(2, 2);
      canvas.getContext('2d').fillRect(0, 0, 1, 1);
      const format = [];
      for (const type of Object.keys(Core.OUTPUT_TYPES)) {
        try {
          if ((await canvas.convertToBlob({ type })).type === type) format.push(type);
        } catch {
          /* not supported */
        }
      }
      return { options: { format } };
    },

    async inspect([file], ctx) {
      const { type, bitmap } = await decode(file);
      const shown = await preview(bitmap, ctx.previewMax);
      const result = {
        summary: [`${Core.INPUT_LABELS[type]} · ${bitmap.width} × ${bitmap.height} · ${Core.formatBytes(file.size)}`],
        preview: shown,
        controls: {
          format: { value: type === 'image/jpeg' ? 'image/webp' : 'image/jpeg' },
          size: { base: { width: bitmap.width, height: bitmap.height } },
        },
      };
      bitmap.close();
      return result;
    },

    async run([file], params, ctx) {
      const { bitmap } = await decode(file);
      const type = params.format;
      const spec = Core.OUTPUT_TYPES[type];
      const target = params.size;
      const canvas = render(bitmap, target, !spec.alpha);
      bitmap.close();
      let blob;
      try {
        blob = await canvas.convertToBlob(spec.lossy ? { type, quality: params.quality / 100 } : { type });
      } catch {
        OfflineSealTool.fail('tool-failed', 'This browser could not encode the image.');
      }
      if (blob.type !== type) OfflineSealTool.fail('tool-failed', `This browser cannot write ${spec.label} images.`);
      // Decode our own output before offering it, and check it is the format
      // and size we promised (fail closed).
      if (Core.sniffImageType(new Uint8Array(await blob.slice(0, 32).arrayBuffer())) !== type) OfflineSealTool.fail('output-invalid', '');
      const decoded = await createImageBitmap(blob);
      if (decoded.width !== target.width || decoded.height !== target.height) OfflineSealTool.fail('output-invalid', '');
      const thumb = await preview(decoded, { width: 128, height: 128 });
      decoded.close();
      return {
        summary: [`${spec.label} · ${target.width} × ${target.height} · ${Core.formatBytes(blob.size)}`, Core.sizeChange(file.size, blob.size)],
        preview: thumb,
        outputs: [{ file: blob, name: Core.outputFileName(file.name, type), summary: '' }],
      };
    },
  });
})();
