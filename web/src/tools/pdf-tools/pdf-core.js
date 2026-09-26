// PDF Tools: a small PDF engine for reorganising pages, meaning merge,
// split, rotate and reorder. It never renders and never decodes page content;
// content streams are copied byte for byte.
//
// Reads: classic cross-reference tables, cross-reference streams, hybrid
// files, incremental updates (/Prev), object streams (Flate, with PNG
// predictors), and a scanning fallback for damaged cross-reference data.
// Refuses: encrypted PDFs.
// Writes: a fresh PDF containing the chosen pages, each with its inherited
// attributes made explicit, plus every object those pages reference (and
// nothing else), renumbered, with a classic cross-reference table. The
// document catalog is new: bookmarks, forms, attachments, scripts, open
// actions and document metadata of the sources are not carried over.
//
// Worker-only tool code: no DOM, no network. The build inlines it into the
// PDF Tools Worker only. The unit tests run it in Node through node:vm.

// eslint-disable-next-line no-unused-vars
const PdfCore = (() => {
  'use strict';

  class PdfError extends Error {
    constructor(code, message) {
      super(message || code);
      this.code = code; // 'not-pdf' | 'encrypted' | 'damaged' | 'unsupported' | 'too-complex'
    }
  }

  // --- object model --------------------------------------------------------------------
  class Ref {
    constructor(num, gen) {
      this.num = num;
      this.gen = gen;
    }
    get key() {
      return `${this.num} ${this.gen}`;
    }
  }
  class Name {
    constructor(name) {
      this.name = name; // decoded, one char per byte (latin1)
    }
  }
  class Str {
    constructor(bytes) {
      this.bytes = bytes;
    }
  }
  class Real {
    constructor(raw) {
      this.raw = raw;
      this.value = Number(raw);
    }
  }
  class Dict {
    constructor(map = new Map()) {
      this.map = map;
    }
    get(key) {
      return this.map.get(key);
    }
    has(key) {
      return this.map.has(key);
    }
    set(key, value) {
      this.map.set(key, value);
    }
    delete(key) {
      this.map.delete(key);
    }
  }
  class Stream {
    constructor(dict, data) {
      this.dict = dict;
      this.data = data; // raw (still encoded) bytes
    }
  }
  class Keyword {
    constructor(word) {
      this.word = word;
    }
  }

  const num = (v) => (typeof v === 'number' ? v : v instanceof Real ? v.value : NaN);
  const isName = (v, name) => v instanceof Name && (name === undefined || v.name === name);

  const LIMITS = Object.freeze({ maxDepth: 64, maxObjects: 2_000_000, maxPages: 100_000, maxXrefSections: 200, maxStreamBytes: 256 * 1024 * 1024 });

  // --- lexer ----------------------------------------------------------------------------
  const WS = new Set([0, 9, 10, 12, 13, 32]);
  const DELIM = new Set([40, 41, 60, 62, 91, 93, 123, 125, 47, 37]); // ( ) < > [ ] { } / %
  const isRegular = (c) => !WS.has(c) && !DELIM.has(c);
  const latin1 = (bytes, a, b) => {
    let s = '';
    for (let i = a; i < b; i++) s += String.fromCharCode(bytes[i]);
    return s;
  };

  class Lexer {
    constructor(bytes, pos = 0) {
      this.b = bytes;
      this.pos = pos;
    }
    skipWs() {
      const b = this.b;
      for (;;) {
        while (this.pos < b.length && WS.has(b[this.pos])) this.pos++;
        if (b[this.pos] === 37) {
          while (this.pos < b.length && b[this.pos] !== 10 && b[this.pos] !== 13) this.pos++;
        } else return;
      }
    }
    // Returns a token: number, Real, Name, Str, Keyword, or the strings '<<' '>>' '[' ']'.
    // Returns null at end of input.
    next() {
      this.skipWs();
      const b = this.b;
      if (this.pos >= b.length) return null;
      const c = b[this.pos];
      if (c === 47) return this.name();
      if (c === 40) return this.literal();
      if (c === 60) {
        if (b[this.pos + 1] === 60) {
          this.pos += 2;
          return '<<';
        }
        return this.hex();
      }
      if (c === 62) {
        if (b[this.pos + 1] === 62) {
          this.pos += 2;
          return '>>';
        }
        throw new PdfError('damaged', 'stray >');
      }
      if (c === 91 || c === 93 || c === 123 || c === 125) {
        this.pos++;
        return String.fromCharCode(c);
      }
      const start = this.pos;
      while (this.pos < b.length && isRegular(b[this.pos])) this.pos++;
      if (this.pos === start) {
        this.pos++;
        throw new PdfError('damaged', 'unexpected delimiter');
      }
      const word = latin1(b, start, this.pos);
      if (/^[+-]?\d+$/.test(word)) return Number(word);
      if (/^[+-]?(\d+\.\d*|\.\d+|\d+\.)$/.test(word)) return new Real(word.replace(/^([+-]?)\./, '$10.').replace(/\.$/, '.0'));
      if (/^[+-]?[\d.]+$/.test(word)) return 0; // malformed numbers like "1.2.3" or "--1": read as 0, as viewers do
      return new Keyword(word);
    }
    name() {
      const b = this.b;
      this.pos++; // '/'
      let s = '';
      while (this.pos < b.length && isRegular(b[this.pos])) {
        const c = b[this.pos];
        if (c === 35 && /^[0-9A-Fa-f]{2}$/.test(latin1(b, this.pos + 1, this.pos + 3))) {
          s += String.fromCharCode(parseInt(latin1(b, this.pos + 1, this.pos + 3), 16));
          this.pos += 3;
        } else {
          s += String.fromCharCode(c);
          this.pos++;
        }
      }
      return new Name(s);
    }
    literal() {
      const b = this.b;
      this.pos++; // '('
      const out = [];
      let depth = 1;
      while (this.pos < b.length) {
        const c = b[this.pos++];
        if (c === 92) {
          const d = b[this.pos++];
          const map = { 110: 10, 114: 13, 116: 9, 98: 8, 102: 12, 40: 40, 41: 41, 92: 92 };
          if (d in map) out.push(map[d]);
          else if (d >= 48 && d <= 55) {
            let v = d - 48;
            for (let k = 0; k < 2 && b[this.pos] >= 48 && b[this.pos] <= 55; k++) v = v * 8 + (b[this.pos++] - 48);
            out.push(v & 255);
          } else if (d === 13) {
            if (b[this.pos] === 10) this.pos++;
          } else if (d !== 10 && d !== undefined) out.push(d);
        } else if (c === 40) {
          depth++;
          out.push(c);
        } else if (c === 41) {
          if (--depth === 0) return new Str(Uint8Array.from(out));
          out.push(c);
        } else out.push(c);
      }
      throw new PdfError('damaged', 'unterminated string');
    }
    hex() {
      const b = this.b;
      this.pos++; // '<'
      let digits = '';
      while (this.pos < b.length && b[this.pos] !== 62) {
        const c = b[this.pos++];
        if (!WS.has(c)) digits += String.fromCharCode(c);
      }
      this.pos++; // '>'
      if (!/^[0-9A-Fa-f]*$/.test(digits)) throw new PdfError('damaged', 'bad hex string');
      if (digits.length % 2) digits += '0';
      const out = new Uint8Array(digits.length / 2);
      for (let i = 0; i < out.length; i++) out[i] = parseInt(digits.substr(i * 2, 2), 16);
      return new Str(out);
    }
  }

  // Parses one object at the lexer position. Handles "n g R" references.
  function parseObject(lx, depth = 0) {
    if (depth > LIMITS.maxDepth) throw new PdfError('too-complex', 'nesting too deep');
    const t = lx.next();
    return fromToken(lx, t, depth);
  }
  function fromToken(lx, t, depth) {
    if (t === null) throw new PdfError('damaged', 'unexpected end');
    if (t === '<<') {
      const map = new Map();
      for (;;) {
        const k = lx.next();
        if (k === '>>') return new Dict(map);
        if (!(k instanceof Name)) {
          if (k === null) throw new PdfError('damaged', 'unterminated dictionary');
          continue; // tolerate junk keys, as viewers do
        }
        const vt = lx.next();
        if (vt === '>>') {
          map.set(k.name, null);
          return new Dict(map);
        }
        map.set(k.name, fromToken(lx, vt, depth + 1));
      }
    }
    if (t === '[') {
      const arr = [];
      for (;;) {
        const save = lx.pos;
        const it = lx.next();
        if (it === ']') return arr;
        if (it === null) throw new PdfError('damaged', 'unterminated array');
        lx.pos = save;
        arr.push(parseObject(lx, depth + 1));
      }
    }
    if (typeof t === 'number' && Number.isInteger(t) && t >= 0) {
      // Maybe "num gen R".
      const save = lx.pos;
      const g = lx.next();
      if (typeof g === 'number' && Number.isInteger(g) && g >= 0) {
        const r = lx.next();
        if (r instanceof Keyword && r.word === 'R') return new Ref(t, g);
      }
      lx.pos = save;
      return t;
    }
    if (t instanceof Keyword) {
      if (t.word === 'true') return true;
      if (t.word === 'false') return false;
      if (t.word === 'null') return null;
      throw new PdfError('damaged', `unexpected keyword ${t.word.slice(0, 20)}`);
    }
    if (t === '>>' || t === ']' || t === '{' || t === '}') throw new PdfError('damaged', 'unexpected delimiter');
    return t; // number, Real, Name, Str
  }

  // --- filters (only for cross-reference and object streams) -------------------------
  async function inflate(bytes) {
    if (typeof DecompressionStream !== 'function') throw new PdfError('unsupported', 'no deflate support');
    const ds = new DecompressionStream('deflate');
    const writer = ds.writable.getWriter();
    writer.write(bytes).catch(() => {});
    writer.close().catch(() => {});
    const reader = ds.readable.getReader();
    const chunks = [];
    let total = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        chunks.push(value);
        total += value.length;
        if (total > LIMITS.maxStreamBytes) throw new PdfError('too-complex', 'stream too large');
      }
    } catch (e) {
      if (e instanceof PdfError) throw e;
      // Trailing junk after a complete deflate stream is common: keep what was produced.
      if (total === 0) throw new PdfError('damaged', 'bad compressed data');
    }
    const out = new Uint8Array(total);
    let o = 0;
    for (const c of chunks) {
      out.set(c, o);
      o += c.length;
    }
    return out;
  }

  function unpredict(data, parms) {
    const predictor = parms instanceof Dict ? num(parms.get('Predictor')) : 1;
    if (!(predictor > 1)) return data;
    const colors = parms.has('Colors') ? num(parms.get('Colors')) : 1;
    const bpc = parms.has('BitsPerComponent') ? num(parms.get('BitsPerComponent')) : 8;
    const columns = parms.has('Columns') ? num(parms.get('Columns')) : 1;
    const bpp = Math.max(1, Math.ceil((colors * bpc) / 8));
    const rowLen = Math.ceil((colors * bpc * columns) / 8);
    if (predictor === 2) {
      if (bpc !== 8) throw new PdfError('unsupported', 'TIFF predictor');
      const out = Uint8Array.from(data);
      for (let r = 0; r < out.length; r += rowLen) for (let i = bpp; i < rowLen && r + i < out.length; i++) out[r + i] = (out[r + i] + out[r + i - bpp]) & 255;
      return out;
    }
    const rows = Math.floor(data.length / (rowLen + 1));
    const out = new Uint8Array(rows * rowLen);
    let prev = new Uint8Array(rowLen);
    for (let r = 0; r < rows; r++) {
      const type = data[r * (rowLen + 1)];
      const src = data.subarray(r * (rowLen + 1) + 1, (r + 1) * (rowLen + 1));
      const row = out.subarray(r * rowLen, (r + 1) * rowLen);
      for (let i = 0; i < rowLen; i++) {
        const left = i >= bpp ? row[i - bpp] : 0;
        const up = prev[i];
        const ul = i >= bpp ? prev[i - bpp] : 0;
        let v = src[i];
        if (type === 1) v += left;
        else if (type === 2) v += up;
        else if (type === 3) v += (left + up) >> 1;
        else if (type === 4) {
          const p = left + up - ul;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - ul);
          v += pa <= pb && pa <= pc ? left : pb <= pc ? up : ul;
        } else if (type !== 0) throw new PdfError('damaged', 'bad predictor row');
        row[i] = v & 255;
      }
      prev = row;
    }
    return out;
  }

  async function decodeStream(stream) {
    let filters = stream.dict.get('Filter');
    let parms = stream.dict.get('DecodeParms');
    if (filters === undefined || filters === null) return stream.data;
    if (!Array.isArray(filters)) filters = [filters];
    if (!Array.isArray(parms)) parms = [parms];
    let data = stream.data;
    for (let i = 0; i < filters.length; i++) {
      if (!isName(filters[i], 'FlateDecode') && !isName(filters[i], 'Fl')) throw new PdfError('unsupported', 'unsupported compression');
      data = unpredict(await inflate(data), parms[i]);
    }
    return data;
  }

  // --- document -------------------------------------------------------------------------
  const find = (bytes, needle, from = 0, to = bytes.length) => {
    const n = needle.length;
    outer: for (let i = from; i <= to - n; i++) {
      for (let j = 0; j < n; j++) if (bytes[i + j] !== needle.charCodeAt(j)) continue outer;
      return i;
    }
    return -1;
  };
  const findLast = (bytes, needle, from = 0) => {
    const n = needle.length;
    outer: for (let i = bytes.length - n; i >= from; i--) {
      for (let j = 0; j < n; j++) if (bytes[i + j] !== needle.charCodeAt(j)) continue outer;
      return i;
    }
    return -1;
  };

  class PdfDocument {
    constructor(bytes) {
      this.bytes = bytes;
      this.entries = new Map(); // num -> { type: 'n', offset, gen } | { type: 'c', stream, index }
      this.objStms = new Map(); // num -> Map(objNum -> value)
      this.cache = new Map();
      this.trailer = null;
      this.version = '1.4';
      this.recovered = false;
      this.pages = [];
    }

    static async open(bytes) {
      if (!(bytes instanceof Uint8Array)) throw new PdfError('not-pdf');
      const header = find(bytes, '%PDF-', 0, Math.min(bytes.length, 1024));
      if (header < 0) throw new PdfError('not-pdf', 'no PDF header');
      const doc = new PdfDocument(header > 0 ? bytes.subarray(header) : bytes);
      const v = /^%PDF-(\d\.\d)/.exec(latin1(doc.bytes, 0, 12));
      if (v) doc.version = v[1];
      try {
        await doc.readXrefChain();
        await doc.loadObjectStreams();
        doc.loadPages();
        if (doc.pages.length === 0) throw new PdfError('damaged', 'no pages');
      } catch (e) {
        if (e instanceof PdfError && (e.code === 'encrypted' || e.code === 'too-complex')) throw e;
        // Fall back to scanning the whole file for objects.
        doc.trailer = null;
        doc.entries.clear();
        doc.objStms.clear();
        doc.cache.clear();
        doc.pages = [];
        doc.recovered = true;
        await doc.recover();
        await doc.loadObjectStreams();
        doc.loadPages();
      }
      if (doc.pages.length === 0) throw new PdfError('damaged', 'no pages');
      return doc;
    }

    async readXrefChain() {
      const sx = findLast(this.bytes, 'startxref');
      if (sx < 0) throw new PdfError('damaged', 'no startxref');
      const lx = new Lexer(this.bytes, sx + 9);
      let offset = lx.next();
      const seen = new Set();
      while (typeof offset === 'number' && !seen.has(offset)) {
        if (seen.size >= LIMITS.maxXrefSections) throw new PdfError('too-complex', 'too many xref sections');
        seen.add(offset);
        const trailer = await this.readXrefSection(offset);
        if (!this.trailer) this.trailer = trailer;
        const prev = trailer.get('Prev');
        offset = typeof prev === 'number' ? prev : null;
      }
      if (!this.trailer) throw new PdfError('damaged', 'no trailer');
      this.checkTrailer();
    }

    checkTrailer() {
      if (this.trailer.has('Encrypt') && this.trailer.get('Encrypt') !== null) throw new PdfError('encrypted');
      if (!(this.trailer.get('Root') instanceof Ref)) throw new PdfError('damaged', 'no root');
    }

    addEntry(n, entry) {
      if (!this.entries.has(n)) {
        if (this.entries.size >= LIMITS.maxObjects) throw new PdfError('too-complex', 'too many objects');
        this.entries.set(n, entry); // newest section wins: sections are read newest first
      }
    }

    async readXrefSection(offset) {
      if (offset < 0 || offset >= this.bytes.length) throw new PdfError('damaged', 'xref offset out of range');
      const lx = new Lexer(this.bytes, offset);
      const first = lx.next();
      if (first instanceof Keyword && first.word === 'xref') {
        const table = [];
        for (;;) {
          const start = lx.next();
          if (start instanceof Keyword && start.word === 'trailer') break;
          const count = lx.next();
          if (typeof start !== 'number' || typeof count !== 'number' || count < 0 || count > LIMITS.maxObjects) throw new PdfError('damaged', 'bad xref subsection');
          for (let i = 0; i < count; i++) {
            const off = lx.next();
            const gen = lx.next();
            const kind = lx.next();
            if (typeof off !== 'number' || typeof gen !== 'number' || !(kind instanceof Keyword)) throw new PdfError('damaged', 'bad xref entry');
            table.push([start + i, kind.word === 'n' ? { type: 'n', offset: off, gen } : { type: 'f' }]);
          }
        }
        const trailer = parseObject(lx);
        if (!(trailer instanceof Dict)) throw new PdfError('damaged', 'bad trailer');
        // Hybrid file: the /XRefStm stream lists objects the table marks free.
        const stm = trailer.get('XRefStm');
        const fromStream = new Map();
        if (typeof stm === 'number') {
          const tmp = new PdfDocument(this.bytes);
          await tmp.readXrefStream(stm);
          for (const [n, e] of tmp.entries) fromStream.set(n, e);
        }
        for (const [n, e] of table) {
          if (e.type === 'f') {
            if (fromStream.has(n)) this.addEntry(n, fromStream.get(n));
            else this.addEntry(n, e);
          } else this.addEntry(n, e);
        }
        for (const [n, e] of fromStream) this.addEntry(n, e);
        return trailer;
      }
      return this.readXrefStream(offset);
    }

    async readXrefStream(offset) {
      const { value } = this.readIndirectAt(offset);
      if (!(value instanceof Stream) || !isName(value.dict.get('Type'), 'XRef')) throw new PdfError('damaged', 'not an xref stream');
      const dict = value.dict;
      const w = dict.get('W');
      if (!Array.isArray(w) || w.length !== 3 || !w.every((x) => Number.isInteger(x) && x >= 0 && x <= 8)) throw new PdfError('damaged', 'bad /W');
      const size = dict.get('Size');
      const index = Array.isArray(dict.get('Index')) ? dict.get('Index') : [0, size];
      const data = await decodeStream(value);
      const rowLen = w[0] + w[1] + w[2];
      let p = 0;
      const field = (width, dflt) => {
        if (width === 0) return dflt;
        let v = 0;
        for (let k = 0; k < width; k++) v = v * 256 + data[p++];
        return v;
      };
      for (let i = 0; i + 1 < index.length; i += 2) {
        const start = index[i];
        const count = index[i + 1];
        if (!Number.isInteger(start) || !Number.isInteger(count) || count < 0 || count > LIMITS.maxObjects) throw new PdfError('damaged', 'bad /Index');
        for (let j = 0; j < count; j++) {
          if (p + rowLen > data.length) throw new PdfError('damaged', 'xref stream too short');
          const type = field(w[0], 1);
          const a = field(w[1], 0);
          const b = field(w[2], 0);
          const n = start + j;
          if (type === 1) this.addEntry(n, { type: 'n', offset: a, gen: b });
          else if (type === 2) this.addEntry(n, { type: 'c', stream: a, index: b });
          else this.addEntry(n, { type: 'f' });
        }
      }
      return dict;
    }

    // Reads "num gen obj ... endobj" at an offset. Streams keep their raw bytes.
    readIndirectAt(offset) {
      const lx = new Lexer(this.bytes, offset);
      const n = lx.next();
      const g = lx.next();
      const kw = lx.next();
      if (typeof n !== 'number' || typeof g !== 'number' || !(kw instanceof Keyword) || kw.word !== 'obj') throw new PdfError('damaged', 'no object at offset');
      const value = parseObject(lx);
      const save = lx.pos;
      const after = lx.next();
      if (value instanceof Dict && after instanceof Keyword && after.word === 'stream') {
        return { num: n, gen: g, value: this.readStreamBody(value, lx.pos) };
      }
      lx.pos = save;
      return { num: n, gen: g, value };
    }

    readStreamBody(dict, pos) {
      const b = this.bytes;
      if (b[pos] === 13 && b[pos + 1] === 10) pos += 2;
      else if (b[pos] === 10 || b[pos] === 13) pos += 1;
      let len = dict.get('Length');
      if (len instanceof Ref) {
        try {
          len = this.getDirectNumber(len);
        } catch {
          len = -1;
        }
      }
      let end = -1;
      if (Number.isInteger(len) && len >= 0 && pos + len <= b.length) {
        const probe = new Lexer(b, pos + len);
        const t = probe.next();
        if (t instanceof Keyword && t.word === 'endstream') end = pos + len;
      }
      if (end < 0) {
        const idx = find(b, 'endstream', pos);
        if (idx < 0) throw new PdfError('damaged', 'unterminated stream');
        end = idx;
        if (b[end - 1] === 10) end--;
        if (b[end - 1] === 13) end--;
      }
      if (end - pos > LIMITS.maxStreamBytes) throw new PdfError('too-complex', 'stream too large');
      return new Stream(dict, b.subarray(pos, end));
    }

    getDirectNumber(ref) {
      const e = this.entries.get(ref.num);
      if (!e || e.type !== 'n') throw new PdfError('damaged', 'length object missing');
      const { value } = this.readIndirectAt(e.offset);
      if (!Number.isInteger(value)) throw new PdfError('damaged', 'length is not a number');
      return value;
    }

    async loadObjectStreams() {
      const needed = new Set();
      for (const e of this.entries.values()) if (e.type === 'c') needed.add(e.stream);
      for (const n of needed) {
        const e = this.entries.get(n);
        if (!e || e.type !== 'n') continue;
        let value;
        try {
          ({ value } = this.readIndirectAt(e.offset));
        } catch {
          continue;
        }
        if (!(value instanceof Stream) || !isName(value.dict.get('Type'), 'ObjStm')) continue;
        const count = value.dict.get('N');
        const first = value.dict.get('First');
        if (!Number.isInteger(count) || !Number.isInteger(first) || count < 0 || count > LIMITS.maxObjects) continue;
        const data = await decodeStream(value);
        const lx = new Lexer(data, 0);
        const pairs = [];
        for (let i = 0; i < count; i++) {
          const on = lx.next();
          const oo = lx.next();
          if (typeof on !== 'number' || typeof oo !== 'number') break;
          pairs.push([on, oo]);
        }
        const objects = new Map();
        for (const [on, oo] of pairs) {
          try {
            objects.set(on, parseObject(new Lexer(data, first + oo)));
          } catch {
            /* skip one bad object */
          }
        }
        this.objStms.set(n, objects);
      }
    }

    // Resolve an object number (synchronously: object streams are decoded up front).
    get(ref) {
      if (!(ref instanceof Ref)) return ref;
      const key = ref.key;
      if (this.cache.has(key)) return this.cache.get(key);
      const e = this.entries.get(ref.num);
      let value = null;
      if (e && e.type === 'n') {
        try {
          const got = this.readIndirectAt(e.offset);
          if (got.num === ref.num) value = got.value;
        } catch {
          value = null;
        }
      } else if (e && e.type === 'c') {
        const objects = this.objStms.get(e.stream);
        value = objects && objects.has(ref.num) ? objects.get(ref.num) : null;
      }
      this.cache.set(key, value);
      return value;
    }

    async recover() {
      // One character per byte, so string offsets are byte offsets.
      const text = new TextDecoder('latin1').decode(this.bytes);
      const re = /(\d+)\s+(\d+)\s+obj\b/g;
      let m;
      let found = 0;
      while ((m = re.exec(text))) {
        if (++found > LIMITS.maxObjects) throw new PdfError('too-complex', 'too many objects');
        const n = Number(m[1]);
        this.entries.set(n, { type: 'n', offset: m.index, gen: Number(m[2]) }); // later definitions win
      }
      // Objects inside object streams, for numbers with no direct definition.
      for (const [n, e] of [...this.entries]) {
        let value;
        try {
          ({ value } = this.readIndirectAt(e.offset));
        } catch {
          continue;
        }
        if (value instanceof Stream && isName(value.dict.get('Type'), 'ObjStm')) {
          const count = value.dict.get('N');
          let data;
          try {
            data = await decodeStream(value);
          } catch {
            continue;
          }
          const lx = new Lexer(data, 0);
          for (let i = 0; i < count; i++) {
            const on = lx.next();
            lx.next();
            if (typeof on !== 'number') break;
            if (!this.entries.has(on)) this.entries.set(on, { type: 'c', stream: n, index: i });
          }
        }
      }
      // Trailer: the last "trailer" dictionary, else an xref stream dictionary, else find the catalog.
      const t = findLast(this.bytes, 'trailer');
      if (t >= 0) {
        try {
          const d = parseObject(new Lexer(this.bytes, t + 7));
          if (d instanceof Dict && d.get('Root') instanceof Ref) this.trailer = d;
        } catch {
          /* keep looking */
        }
      }
      if (!this.trailer) {
        for (const [n, e] of this.entries) {
          if (e.type !== 'n') continue;
          try {
            const { value } = this.readIndirectAt(e.offset);
            const d = value instanceof Stream ? value.dict : value;
            if (d instanceof Dict && isName(d.get('Type'), 'XRef') && d.get('Root') instanceof Ref) this.trailer = d;
            else if (d instanceof Dict && isName(d.get('Type'), 'Catalog') && !this.trailer) this.trailer = new Dict(new Map([['Root', new Ref(n, e.gen)]]));
          } catch {
            /* ignore */
          }
        }
      }
      if (!this.trailer) throw new PdfError('damaged', 'no document catalog');
      this.checkTrailer();
    }

    loadPages() {
      const root = this.get(this.trailer.get('Root'));
      if (!(root instanceof Dict)) throw new PdfError('damaged', 'bad catalog');
      const cv = root.get('Version');
      if (cv instanceof Name && /^\d\.\d$/.test(cv.name) && cv.name > this.version) this.version = cv.name;
      const pages = [];
      const seen = new Set();
      const walk = (ref, inherited, depth) => {
        if (depth > LIMITS.maxDepth) throw new PdfError('too-complex', 'page tree too deep');
        if (!(ref instanceof Ref) || seen.has(ref.key)) return;
        seen.add(ref.key);
        const node = this.get(ref);
        if (!(node instanceof Dict)) return;
        const here = { ...inherited };
        for (const k of ['Resources', 'MediaBox', 'CropBox', 'Rotate']) if (node.has(k)) here[k] = node.get(k);
        const kids = this.get(node.get('Kids'));
        if (isName(node.get('Type'), 'Pages') || (Array.isArray(kids) && !isName(node.get('Type'), 'Page'))) {
          if (Array.isArray(kids)) for (const kid of kids) walk(kid, here, depth + 1);
        } else {
          if (pages.length >= LIMITS.maxPages) throw new PdfError('too-complex', 'too many pages');
          pages.push({ ref, dict: node, inherited: here });
        }
      };
      walk(root.get('Pages'), {}, 0);
      this.pages = pages;
    }

    pageInfo(index) {
      const p = this.pages[index];
      const box = this.get(p.inherited.MediaBox);
      let width = 612;
      let height = 792;
      if (Array.isArray(box) && box.length === 4) {
        const v = box.map((x) => num(this.get(x)));
        if (v.every(Number.isFinite)) {
          width = Math.abs(v[2] - v[0]);
          height = Math.abs(v[3] - v[1]);
        }
      }
      return { width, height, rotation: normaliseRotation(num(this.get(p.inherited.Rotate))) };
    }

    isPageTreeNode(value) {
      return value instanceof Dict && (isName(value.get('Type'), 'Page') || isName(value.get('Type'), 'Pages'));
    }
  }

  function normaliseRotation(r) {
    if (!Number.isFinite(r) || r % 90 !== 0) return 0;
    return ((r % 360) + 360) % 360;
  }

  // --- writer -----------------------------------------------------------------------------
  const enc = (s) => {
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 255;
    return out;
  };

  function serializeName(name) {
    let s = '/';
    for (let i = 0; i < name.length; i++) {
      const c = name.charCodeAt(i);
      if (c < 0x21 || c > 0x7e || DELIM.has(c) || c === 35) s += '#' + c.toString(16).padStart(2, '0');
      else s += name[i];
    }
    return s;
  }
  function serialize(v) {
    if (v === null || v === undefined) return 'null';
    if (v === true) return 'true';
    if (v === false) return 'false';
    if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Math.round(v * 1e6) / 1e6);
    if (v instanceof Real) return v.raw;
    if (v instanceof Name) return serializeName(v.name);
    if (v instanceof Str) return '<' + Array.from(v.bytes, (b) => b.toString(16).padStart(2, '0')).join('') + '>';
    if (v instanceof Ref) return `${v.num} ${v.gen} R`;
    if (Array.isArray(v)) return '[' + v.map(serialize).join(' ') + ']';
    if (v instanceof Dict) {
      let s = '<<';
      for (const [k, val] of v.map) s += serializeName(k) + ' ' + serialize(val) + ' ';
      return s + '>>';
    }
    throw new PdfError('damaged', 'cannot serialise value');
  }

  // plan: [{ doc, index, rotation }] -> Uint8Array
  function write(plan) {
    const objects = []; // index = object number - 1
    const alloc = () => objects.push(null);
    const catalogNum = alloc();
    const pagesNum = alloc();
    const pageNums = new Map(); // doc -> Map(pageRefKey -> new num)
    const copied = new Map(); // doc -> Map(oldRefKey -> new num)
    const queue = [];
    let version = '1.4';

    for (const item of plan) {
      if (!pageNums.has(item.doc)) {
        pageNums.set(item.doc, new Map());
        copied.set(item.doc, new Map());
      }
      const key = item.doc.pages[item.index].ref.key;
      if (pageNums.get(item.doc).has(key)) throw new PdfError('damaged', 'page used twice');
      pageNums.get(item.doc).set(key, alloc());
      if (item.doc.version > version) version = item.doc.version;
    }

    const copyValue = (doc, v) => {
      if (v instanceof Ref) {
        const pageNum = pageNums.get(doc).get(v.key);
        if (pageNum) return new Ref(pageNum, 0);
        const memo = copied.get(doc);
        if (memo.has(v.key)) return new Ref(memo.get(v.key), 0);
        const target = doc.get(v);
        // Links to pages that are not in this output (or to the old page tree) become null.
        if (target === null || doc.isPageTreeNode(target)) return null;
        const n = alloc();
        memo.set(v.key, n);
        queue.push([doc, target, n]);
        return new Ref(n, 0);
      }
      if (Array.isArray(v)) return v.map((x) => copyValue(doc, x));
      if (v instanceof Dict) {
        const out = new Dict();
        for (const [k, val] of v.map) out.set(k, copyValue(doc, val));
        return out;
      }
      if (v instanceof Stream) {
        const d = copyValue(doc, v.dict);
        d.delete('Length');
        return new Stream(d, v.data);
      }
      return v;
    };

    const kids = [];
    for (const item of plan) {
      const page = item.doc.pages[item.index];
      const num = pageNums.get(item.doc).get(page.ref.key);
      const dict = new Dict();
      for (const [k, val] of page.dict.map) {
        if (k === 'Parent' || k === 'Rotate') continue;
        dict.set(k, copyValue(item.doc, val));
      }
      // Make inherited attributes explicit: the new page tree has no ancestors to inherit from.
      for (const k of ['Resources', 'MediaBox', 'CropBox']) {
        if (!dict.has(k) && page.inherited[k] !== undefined) dict.set(k, copyValue(item.doc, page.inherited[k]));
      }
      if (!dict.has('MediaBox')) dict.set('MediaBox', [0, 0, 612, 792]);
      if (!dict.has('Resources')) dict.set('Resources', new Dict());
      dict.set('Type', new Name('Page'));
      dict.set('Parent', new Ref(pagesNum, 0));
      dict.set('Rotate', normaliseRotation(item.rotation));
      objects[num - 1] = dict;
      kids.push(new Ref(num, 0));
    }
    for (let q = 0; q < queue.length; q++) {
      const [doc, target, n] = queue[q];
      objects[n - 1] = copyValue(doc, target);
    }
    objects[catalogNum - 1] = new Dict(new Map([['Type', new Name('Catalog')], ['Pages', new Ref(pagesNum, 0)]]));
    objects[pagesNum - 1] = new Dict(new Map([['Type', new Name('Pages')], ['Kids', kids], ['Count', kids.length]]));

    // Serialise with a classic cross-reference table.
    const chunks = [];
    let size = 0;
    const push = (u8) => {
      chunks.push(u8);
      size += u8.length;
    };
    push(enc(`%PDF-${version}\n%âãÏÓ\n`));
    const offsets = [];
    objects.forEach((obj, i) => {
      offsets.push(size);
      if (obj instanceof Stream) {
        obj.dict.set('Length', obj.data.length);
        push(enc(`${i + 1} 0 obj\n${serialize(obj.dict)}\nstream\n`));
        push(obj.data);
        push(enc('\nendstream\nendobj\n'));
      } else {
        push(enc(`${i + 1} 0 obj\n${serialize(obj)}\nendobj\n`));
      }
    });
    const xref = size;
    let table = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (const off of offsets) table += `${String(off).padStart(10, '0')} 00000 n \n`;
    push(enc(`${table}trailer\n<< /Size ${objects.length + 1} /Root ${catalogNum} 0 R >>\nstartxref\n${xref}\n%%EOF\n`));
    const out = new Uint8Array(size);
    let o = 0;
    for (const c of chunks) {
      out.set(c, o);
      o += c.length;
    }
    return out;
  }

  // "1-3, 5, 7-" against `count` pages -> [[1,3],[5,5],[7,count]]
  function parseRanges(text, count) {
    const parts = String(text).split(',').map((p) => p.trim()).filter(Boolean);
    if (parts.length === 0) throw new Error('Enter at least one page range, like 1-3, 5.');
    if (parts.length > 500) throw new Error('Too many ranges.');
    return parts.map((p) => {
      const m = /^(\d+)?\s*(-)?\s*(\d+)?$/.exec(p);
      if (!m || (!m[1] && !m[3])) throw new Error(`"${p}" is not a page range.`);
      const a = m[1] ? Number(m[1]) : 1;
      const b = m[2] ? (m[3] ? Number(m[3]) : count) : a;
      if (a < 1 || b > count || a > b) throw new Error(`"${p}" is outside pages 1–${count}.`);
      return [a, b];
    });
  }

  const PAPER = [
    ['A3', 841.89, 1190.55],
    ['A4', 595.28, 841.89],
    ['A5', 419.53, 595.28],
    ['Letter', 612, 792],
    ['Legal', 612, 1008],
    ['Tabloid', 792, 1224],
  ];
  function describeSize(width, height, rotation) {
    const [w, h] = rotation % 180 ? [height, width] : [width, height];
    const orientation = w > h ? 'landscape' : 'portrait';
    const lo = Math.min(width, height);
    const hi = Math.max(width, height);
    const paper = PAPER.find(([, pw, ph]) => Math.abs(pw - lo) < 3 && Math.abs(ph - hi) < 3);
    return paper ? `${paper[0]} ${orientation}` : `${Math.round(w)} × ${Math.round(h)} pt`;
  }

  return Object.freeze({ PdfError, PdfDocument, open: (bytes) => PdfDocument.open(bytes), write, parseRanges, describeSize, normaliseRotation, _internal: { Lexer, parseObject, Ref, Name, Dict, Stream, Str, Real, serialize } });
})();
