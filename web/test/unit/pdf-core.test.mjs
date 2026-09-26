// The PDF Tools engine (src/tools/pdf-tools/pdf-core.js), run in Node through
// node:vm. Outputs are verified three independent ways: pdf-lib (a separate
// parser), a re-parse by the engine itself, and `qpdf --check` when qpdf is
// installed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';

import { describePdf, makePdf } from '../helpers/synthetic-pdf.mjs';

const source = readFileSync(new URL('../../src/tools/pdf-tools/pdf-core.js', import.meta.url), 'utf8');
const Pdf = vm.runInNewContext(`${source}\nPdfCore`, { TextDecoder, DecompressionStream, Uint8Array });
const fixture = (name) => new Uint8Array(readFileSync(new URL(`../fixtures/pdf/${name}`, import.meta.url)));
const plain = (v) => JSON.parse(JSON.stringify(v));

const hasQpdf = (() => {
  try {
    execFileSync('qpdf', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
function qpdfCheck(bytes) {
  if (!hasQpdf) return 'skipped';
  const file = join(mkdtempSync(join(tmpdir(), 'offlineseal-pdf-')), 'out.pdf');
  writeFileSync(file, bytes);
  try {
    execFileSync('qpdf', ['--check', file], { stdio: 'pipe' });
    return 'ok';
  } catch (e) {
    return `qpdf exit ${e.status}: ${String(e.stdout).slice(0, 400)}`;
  }
}

async function pagesOf(bytes) {
  const doc = await Pdf.open(bytes);
  return doc.pages.map((_, i) => {
    const info = doc.pageInfo(i);
    return { width: Math.round(info.width), rotation: info.rotation };
  });
}

const EXPECTED = {
  'classic-3.pdf': [[301, 0], [302, 0], [303, 0]],
  'objstm-4.pdf': [[401, 0], [402, 90], [403, 0], [404, 270]],
  'qpdf-objstm-3.pdf': [[301, 0], [302, 0], [303, 0]],
  'linearized-4.pdf': [[401, 0], [402, 90], [403, 0], [404, 270]],
  'chromium-2.pdf': [[397, 0], [397, 0]],
  'inherited-3.pdf': [[501, 90], [502, 0], [503, 0]],
  'incremental-3.pdf': [[501, 90], [502, 180], [503, 0]],
  'broken-xref-3.pdf': [[501, 90], [502, 0], [503, 0]],
};
// Arrays made inside the vm context have that context's prototypes: compare as plain data.
const asPairs = (pages) => plain(Array.from(pages, (p) => [p.width, p.rotation]));

test('reads every fixture layout: classic, object streams, qpdf, linearised, Chromium, inherited, incremental, damaged', async () => {
  for (const [name, expected] of Object.entries(EXPECTED)) {
    assert.deepEqual(asPairs(await pagesOf(fixture(name))), expected, name);
  }
  const broken = await Pdf.open(fixture('broken-xref-3.pdf'));
  assert.equal(broken.recovered, true, 'damaged cross-reference data is recovered by scanning');
  assert.equal((await Pdf.open(fixture('classic-3.pdf'))).recovered, false);
});

test('refuses encrypted PDFs and non-PDFs', async () => {
  await assert.rejects(Pdf.open(fixture('encrypted.pdf')), (e) => e.code === 'encrypted');
  await assert.rejects(Pdf.open(new TextEncoder().encode('just some text, not a PDF')), (e) => e.code === 'not-pdf');
  await assert.rejects(Pdf.open(new TextEncoder().encode('%PDF-1.7\n garbage with no objects at all')), (e) => e.code === 'damaged');
});

test('writes reordered, rotated subsets that three independent readers agree on', async () => {
  for (const name of Object.keys(EXPECTED)) {
    const doc = await Pdf.open(fixture(name));
    const n = doc.pages.length;
    // Reverse the order, turn every page 90° further, drop page 1 if there is more than one.
    const plan = doc.pages
      .map((_, index) => ({ doc, index, rotation: (doc.pageInfo(index).rotation + 90) % 360 }))
      .reverse()
      .filter((it) => n === 1 || it.index !== 0);
    const out = Pdf.write(plan);
    const expected = plain(plan.map((it) => [Math.round(doc.pageInfo(it.index).width), it.rotation]));
    assert.deepEqual(asPairs(await pagesOf(out)), expected, `${name}: engine re-read`);
    assert.deepEqual((await describePdf(Buffer.from(out))).map((p) => [p.width, p.rotation]), expected, `${name}: pdf-lib read`);
    assert.equal(qpdfCheck(out), hasQpdf ? 'ok' : 'skipped', `${name}: qpdf --check`);
  }
});

test('merges pages from several documents in any order', async () => {
  const a = await Pdf.open(fixture('classic-3.pdf'));
  const b = await Pdf.open(fixture('objstm-4.pdf'));
  const c = await Pdf.open(fixture('chromium-2.pdf'));
  const plan = [
    { doc: b, index: 3, rotation: 0 },
    { doc: a, index: 0, rotation: 0 },
    { doc: c, index: 1, rotation: 180 },
    { doc: b, index: 0, rotation: 90 },
    { doc: a, index: 2, rotation: 0 },
  ];
  const out = Pdf.write(plan);
  const expected = [[404, 0], [301, 0], [397, 180], [401, 90], [303, 0]];
  assert.deepEqual(asPairs(await pagesOf(out)), expected);
  assert.deepEqual((await describePdf(Buffer.from(out))).map((p) => [p.width, p.rotation]), expected);
  assert.equal(qpdfCheck(out), hasQpdf ? 'ok' : 'skipped');
});

test('inherited attributes become explicit; links to dropped pages become null; nothing dangles', async () => {
  const doc = await Pdf.open(fixture('inherited-3.pdf'));
  // Keep only page 3, whose annotation links to page 1 and names page 3 as /P.
  const out = Pdf.write([{ doc, index: 2, rotation: 0 }]);
  const text = new TextDecoder('latin1').decode(out);
  const re = await Pdf.open(out);
  const page = re.pages[0].dict;
  assert.ok(page.has('MediaBox') && page.has('Resources'), 'inherited attributes written onto the page');
  // Every reference in the output resolves to an object that exists.
  for (const m of text.matchAll(/(\d+) 0 R/g)) assert.notEqual(re.get(new Pdf._internal.Ref(Number(m[1]), 0)), null, `dangling ${m[0]}`);
  // The annotation's /Dest to the dropped page is now null; its /P points at the new page.
  const annot = re.get(re.get(page.get('Annots'))[0]);
  assert.equal(annot.get('Dest')[0], null);
  assert.equal(annot.get('P').num, re.pages[0].ref.num);
  // Only the objects page 3 needs were copied: not pages 1–2 or their content.
  assert.ok(!text.includes('Inherited page one') && !text.includes('Page two'));
  assert.ok(text.includes('Page three'));
  assert.equal(qpdfCheck(out), hasQpdf ? 'ok' : 'skipped');
});

test('the source catalog, metadata and page tree are not carried over', async () => {
  const bytes = await makePdf({ widths: [310, 320], marker: 'CATALOG-MARKER-XYZ' });
  const doc = await Pdf.open(new Uint8Array(bytes));
  const out = Pdf.write([{ doc, index: 1, rotation: 0 }]);
  const text = new TextDecoder('latin1').decode(out);
  assert.ok(!text.includes('CATALOG-MARKER-XYZ'), 'Info dictionary not copied');
  assert.ok(!text.includes('/Info'), 'no Info reference');
  assert.equal((text.match(/\/Type \/Pages/g) || []).length, 1, 'one fresh page tree');
});

test('page ranges', () => {
  assert.deepEqual(plain(Pdf.parseRanges('1-3, 5, 7-', 10)), [[1, 3], [5, 5], [7, 10]]);
  assert.deepEqual(plain(Pdf.parseRanges(' -2 ', 4)), [[1, 2]]);
  for (const bad of ['', ',', '0', '3-1', '1-11', '1-2-3', 'a', '5-']) {
    assert.throws(() => Pdf.parseRanges(bad, bad === '5-' ? 4 : 10), undefined, bad);
  }
});

test('paper size descriptions', () => {
  assert.equal(Pdf.describeSize(595.28, 841.89, 0), 'A4 portrait');
  assert.equal(Pdf.describeSize(595.28, 841.89, 90), 'A4 landscape');
  assert.equal(Pdf.describeSize(612, 792, 0), 'Letter portrait');
  assert.equal(Pdf.describeSize(301, 500, 0), '301 × 500 pt');
});

test('lexer: strings, names, numbers and references round-trip', () => {
  const { Lexer, parseObject, serialize } = Pdf._internal;
  const src = new TextEncoder().encode('<< /A (a\\(b\\)c\\101) /B <48656c6c6f> /C [1 -2 .5 +3. 4 0 R] /D#20E true /E null >>');
  const obj = parseObject(new Lexer(src));
  assert.equal(new TextDecoder().decode(obj.get('A').bytes), 'a(b)cA');
  assert.equal(new TextDecoder().decode(obj.get('B').bytes), 'Hello');
  assert.equal(obj.get('C')[4].num, 4);
  assert.equal(obj.get('D E'), true);
  assert.equal(serialize(obj), '<</A <612862296341> /B <48656c6c6f> /C [1 -2 0.5 +3.0 4 0 R] /D#20E true /E null >>');
});
