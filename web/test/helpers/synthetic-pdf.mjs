// Synthetic PDFs for tests, made with pdf-lib (a dev-only test dependency,
// never shipped). Every page gets a unique width, so the order and rotation
// of pages in any output can be checked exactly. Each document carries the
// harmless unique marker in an uncompressed Info entry.

import { PDFDocument, PDFName, PDFString, StandardFonts, degrees } from 'pdf-lib';

import { MARKER } from './synthetic-image.mjs';

// widths: one entry per page. rotations: optional, same length.
export async function makePdf({ widths, height = 500, rotations = [], marker = MARKER, objectStreams = false } = {}) {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  widths.forEach((w, i) => {
    const page = doc.addPage([w, height]);
    page.drawText(`Page ${i + 1} · width ${w}`, { x: 20, y: height - 40, size: 14, font });
    if (rotations[i]) page.setRotation(degrees(rotations[i]));
  });
  doc.getInfoDict().set(PDFName.of('OfflineSealMarker'), PDFString.of(marker));
  return Buffer.from(await doc.save({ useObjectStreams: objectStreams }));
}

// Independent reading of an output: page widths (MediaBox) and rotations.
export async function describePdf(bytes) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  return doc.getPages().map((p) => ({ width: Math.round(p.getMediaBox().width), rotation: p.getRotation().angle }));
}
