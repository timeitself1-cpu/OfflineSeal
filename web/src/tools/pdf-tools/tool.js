// PDF Tools: Worker-only tool code. The build inlines it after the runtime's
// Worker host and pdf-core.js. It runs only inside a disposable processing
// Worker: no DOM, no network, no storage, one job per Worker.
//
// inspect: read every chosen PDF and list its pages (the runtime shows them
//          with its generic item list).
// run:     read the PDFs again (this is a fresh Worker), then write the pages
//          in the user's order and rotation into one PDF, one PDF per page, or
//          one PDF per range. Every output is re-read before it is offered.

/* global OfflineSealTool, PdfCore */

(() => {
  'use strict';

  const baseName = (name) => String(name).replace(/\.pdf$/i, '').slice(0, 80) || 'document';
  const shortName = (name) => {
    const b = baseName(name);
    return b.length > 32 ? `${b.slice(0, 30)}…` : b;
  };
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  async function openAll(files) {
    const docs = [];
    for (const file of files) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      try {
        docs.push(await PdfCore.open(bytes));
      } catch (e) {
        const code = e && e.code;
        if (code === 'not-pdf') OfflineSealTool.fail('unsupported-input', `${file.name} is not a PDF.`);
        if (code === 'encrypted') OfflineSealTool.fail('unsupported-input', `${file.name} is password-protected. Remove the protection first.`);
        if (code === 'too-complex') OfflineSealTool.fail('too-large', `${file.name} is too complex to process in the browser.`);
        if (code === 'unsupported') OfflineSealTool.fail('unsupported-input', `${file.name} uses a PDF feature this tool does not support.`);
        OfflineSealTool.fail('invalid-input', `${file.name} could not be read. It may be damaged.`);
      }
    }
    return docs;
  }

  // Item keys are "file:page", both zero-based.
  const keyOf = (f, p) => `${f}:${p}`;

  OfflineSealTool.define({
    async inspect(files) {
      const docs = await openAll(files);
      const items = [];
      docs.forEach((doc, f) => {
        doc.pages.forEach((_, p) => {
          const info = doc.pageInfo(p);
          items.push({
            key: keyOf(f, p),
            label: files.length > 1 ? `${shortName(files[f].name)} · page ${p + 1}` : `Page ${p + 1}`,
            // The page as stored, before rotation (the list shows rotation separately).
            detail: PdfCore.describeSize(info.width, info.height, 0),
            rotation: info.rotation,
          });
        });
      });
      const max = OfflineSealTool.manifest.controls.find((c) => c.id === 'pages').maxItems;
      if (items.length > max) OfflineSealTool.fail('too-large', `These PDFs have ${items.length} pages; the limit is ${max}.`);
      const repaired = docs.filter((d) => d.recovered).length;
      const summary = [plural(items.length, 'page')];
      if (repaired) summary.push(`${plural(repaired, 'file')} had damaged structure and were read by scanning.`);
      return { summary, controls: { pages: { items } } };
    },

    async run(files, params) {
      const docs = await openAll(files);
      const plan = params.pages.map(({ key, rotation }) => {
        const m = /^(\d+):(\d+)$/.exec(key);
        const doc = m && docs[Number(m[1])];
        if (!doc || !doc.pages[Number(m[2])]) OfflineSealTool.fail('invalid-input', 'The page list no longer matches these files.');
        return { doc, index: Number(m[2]), rotation, file: Number(m[1]), page: Number(m[2]) };
      });

      const first = baseName(files[0].name);
      let groups;
      if (params.mode === 'merge') {
        groups = [{ items: plan, name: files.length > 1 ? `${first}-merged` : `${first}-edited` }];
      } else if (params.mode === 'each') {
        groups = plan.map((it, i) => ({ items: [it], name: `${baseName(files[it.file].name)}-page-${String(i + 1).padStart(String(plan.length).length, '0')}` }));
      } else {
        let ranges;
        try {
          ranges = PdfCore.parseRanges(params.ranges, plan.length);
        } catch (e) {
          OfflineSealTool.fail('invalid-input', e.message);
        }
        groups = ranges.map(([a, b]) => ({ items: plan.slice(a - 1, b), name: `${first}-pages-${a === b ? a : `${a}-${b}`}` }));
      }
      const maxOutputs = OfflineSealTool.manifest.outputs.maxFiles;
      if (groups.length > maxOutputs) OfflineSealTool.fail('too-large', `That would create ${groups.length} files; the limit is ${maxOutputs}. Use ranges instead.`);

      const outputs = [];
      let totalBytes = 0;
      for (const group of groups) {
        let bytes;
        try {
          bytes = PdfCore.write(group.items);
        } catch {
          OfflineSealTool.fail('tool-failed', 'These pages could not be written.');
        }
        // Re-read what we wrote, and check it has exactly the planned pages and rotations (fail closed).
        let check;
        try {
          check = await PdfCore.open(bytes);
        } catch {
          OfflineSealTool.fail('output-invalid', '');
        }
        if (check.pages.length !== group.items.length || check.pages.some((_, i) => check.pageInfo(i).rotation !== PdfCore.normaliseRotation(group.items[i].rotation))) {
          OfflineSealTool.fail('output-invalid', '');
        }
        totalBytes += bytes.length;
        outputs.push({
          file: new Blob([bytes], { type: 'application/pdf' }),
          name: `${group.name}.pdf`,
          summary: `${plural(group.items.length, 'page')} · ${OfflineSealTool.formatBytes(bytes.length)}`,
        });
      }
      const pages = plan.length;
      const summary =
        outputs.length === 1
          ? [`PDF · ${plural(pages, 'page')} · ${OfflineSealTool.formatBytes(totalBytes)}`]
          : [`${plural(outputs.length, 'PDF')} · ${plural(groups.reduce((n, g) => n + g.items.length, 0), 'page')}`, `${OfflineSealTool.formatBytes(totalBytes)} in total`];
      return { summary, outputs };
    },
  });
})();
