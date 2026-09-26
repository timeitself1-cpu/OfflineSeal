// Generates the committed PDF test fixtures in test/fixtures/pdf/. Needs
// pdf-lib (dev dependency), Playwright's Chromium, and the qpdf command-line
// tool. The fixtures are committed, so the tests themselves need none of these
// except pdf-lib.
//
//   node scripts/make-pdf-fixtures.mjs
//
// Page widths are unique per page (see test/unit/pdf-core.test.mjs), so every
// test can tell exactly which page ended up where.

import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

import { makePdf } from '../test/helpers/synthetic-pdf.mjs';

const OUT = new URL('../test/fixtures/pdf/', import.meta.url);
await mkdir(OUT, { recursive: true });
const out = (name) => new URL(name, OUT).pathname;
const qpdf = (...args) => execFileSync('qpdf', args, { stdio: 'inherit' });

// 1. Classic cross-reference table (pdf-lib default).
await writeFile(out('classic-3.pdf'), await makePdf({ widths: [301, 302, 303] }));

// 2. Cross-reference stream + object streams, with a rotated page.
await writeFile(out('objstm-4.pdf'), await makePdf({ widths: [401, 402, 403, 404], rotations: [0, 90, 0, 270], objectStreams: true }));

// 3. The same through qpdf: object streams regenerated, then linearised.
qpdf('--object-streams=generate', out('classic-3.pdf'), out('qpdf-objstm-3.pdf'));
qpdf('--linearize', out('objstm-4.pdf'), out('linearized-4.pdf'));

// 4. Encrypted (AES-256, empty user password): must be refused.
qpdf('--encrypt', '', 'owner-secret', '256', '--', out('classic-3.pdf'), out('encrypted.pdf'));

// 5. A real-world producer: Chromium's PDF printer (fonts, compressed content).
{
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setContent('<h1 style="font:32px sans-serif">OfflineSeal fixture</h1><p>First page</p><p style="break-before:page">Second page</p>');
  await writeFile(out('chromium-2.pdf'), await page.pdf({ width: '5.51in', height: '8.27in', printBackground: true }));
  await browser.close();
}

// 6. Hand-built: nested page tree with inherited MediaBox, Rotate and
//    Resources; then an incremental update that rotates page 2; then a copy
//    whose startxref points nowhere (forces recovery).
function buildPdf(objects, { trailerExtra = '' } = {}) {
  let body = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
  const offsets = [];
  for (const [num, text] of objects) {
    offsets[num] = Buffer.byteLength(body, 'latin1');
    body += `${num} 0 obj\n${text}\nendobj\n`;
  }
  const size = Math.max(...objects.map(([n]) => n)) + 1;
  const xref = Buffer.byteLength(body, 'latin1');
  body += `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (let n = 1; n < size; n++) body += offsets[n] !== undefined ? `${String(offsets[n]).padStart(10, '0')} 00000 n \n` : '0000000000 65535 f \n';
  body += `trailer\n<< /Size ${size} /Root 1 0 R ${trailerExtra}>>\nstartxref\n${xref}\n%%EOF\n`;
  return { bytes: Buffer.from(body, 'latin1'), xref, size };
}
const content = (label) => {
  const s = `BT /F1 18 Tf 20 440 Td (${label}) Tj ET`;
  return `<< /Length ${s.length} >>\nstream\n${s}\nendstream`;
};
const inherited = buildPdf([
  [1, '<< /Type /Catalog /Pages 2 0 R >>'],
  // Root: MediaBox 501 wide and Resources for everything below.
  [2, '<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 3 /MediaBox [0 0 501 500] /Resources << /Font << /F1 9 0 R >> >> >>'],
  [3, '<< /Type /Pages /Parent 2 0 R /Kids [4 0 R 5 0 R] /Count 2 /Rotate 90 >>'],
  [4, '<< /Type /Page /Parent 3 0 R /Contents 7 0 R >>'], // inherits 501 wide, Rotate 90
  [5, '<< /Type /Page /Parent 3 0 R /MediaBox [0 0 502 500] /Rotate 0 /Contents 8 0 R >>'], // own box, own rotation
  [6, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 503 500] /Contents 10 0 R /Annots [11 0 R] >>'], // links to page 1
  [7, content('Inherited page one')],
  [8, content('Page two')],
  [9, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'],
  [10, content('Page three')],
  [11, '<< /Type /Annot /Subtype /Link /Rect [0 0 50 50] /Dest [4 0 R /Fit] /P 6 0 R >>'],
]);
await writeFile(out('inherited-3.pdf'), inherited.bytes);

// Incremental update: a new version of object 5 with /Rotate 180.
{
  const base = inherited.bytes.toString('latin1');
  const obj = '5 0 obj\n<< /Type /Page /Parent 3 0 R /MediaBox [0 0 502 500] /Rotate 180 /Contents 8 0 R >>\nendobj\n';
  const objOffset = Buffer.byteLength(base, 'latin1');
  const xref = objOffset + Buffer.byteLength(obj, 'latin1');
  const update =
    obj +
    `xref\n0 1\n0000000000 65535 f \n5 1\n${String(objOffset).padStart(10, '0')} 00000 n \n` +
    `trailer\n<< /Size ${inherited.size} /Root 1 0 R /Prev ${inherited.xref} >>\nstartxref\n${xref}\n%%EOF\n`;
  await writeFile(out('incremental-3.pdf'), Buffer.from(base + update, 'latin1'));
}

// Broken cross-reference: startxref points into the middle of nowhere.
await writeFile(out('broken-xref-3.pdf'), Buffer.from(inherited.bytes.toString('latin1').replace(/startxref\n\d+/, 'startxref\n999999'), 'latin1'));

console.log('fixtures written to', OUT.pathname);
