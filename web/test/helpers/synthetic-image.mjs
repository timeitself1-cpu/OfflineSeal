// Deterministic synthetic test images.
//
// The PNG carries a harmless, unique ASCII marker in a tEXt chunk. The data-
// isolation tests search everything the shell and the server saw for this
// marker (and its encoded forms). It stands in for "the private file's
// content" without using any real private data.

import zlib from 'node:zlib';

export const MARKER = 'OFFLINESEAL-SYNTHETIC-MARKER-5d1c8e7a42b9';

const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

// width x height gradient. alpha: true makes the left third fully transparent.
export function syntheticPng({ width = 320, height = 240, alpha = false, marker = MARKER } = {}) {
  const channels = alpha ? 4 : 3;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = alpha ? 6 : 2; // RGBA or RGB
  const stride = width * channels + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const o = y * stride + 1 + x * channels;
      raw[o] = Math.round((x / Math.max(1, width - 1)) * 255);
      raw[o + 1] = Math.round((y / Math.max(1, height - 1)) * 255);
      raw[o + 2] = 140;
      if (alpha) raw[o + 3] = x < width / 3 ? 0 : 255;
    }
  }
  const text = Buffer.concat([Buffer.from('Comment\0', 'latin1'), Buffer.from(marker, 'latin1')]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('tEXt', text),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Every form in which the marker could plausibly show up if the file's bytes
// leaked: raw, hex, and base64 at all three alignments. For base64, the
// alignment-dependent edge characters are trimmed.
export function markerForms(marker = MARKER) {
  const bytes = Buffer.from(marker, 'latin1');
  const forms = new Set([marker, bytes.toString('hex'), encodeURIComponent(marker)]);
  for (let pad = 0; pad < 3; pad++) {
    const b64 = Buffer.concat([Buffer.alloc(pad), bytes]).toString('base64');
    forms.add(b64.slice(4, -4));
  }
  return [...forms];
}

export function containsMarker(text, forms = markerForms()) {
  if (typeof text !== 'string' || text.length === 0) return false;
  return forms.some((f) => text.includes(f));
}
