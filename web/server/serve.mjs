// A small static server for OfflineSeal Web's built site (web/dist).
//
// It sends exactly the headers in dist/headers.json, the same rules the build
// writes to _headers for production hosts. So local runs and the browser tests
// exercise what ships.
//
// For tests, startServer({ observe: true }) also records every request (method,
// URL, headers, body) and every TCP connection, and answers
// /__test_should_not_be_reached/* so the tests can prove the sealed frame never
// reaches it. These endpoints exist only in this local server; the static site
// has none.

import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_ROOT = fileURLToPath(new URL('../dist/', import.meta.url));

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

export const PROBE_PREFIX = '/__test_should_not_be_reached/';

function matches(pattern, path) {
  if (pattern.endsWith('/*')) return path.startsWith(pattern.slice(0, -1)) || path === pattern.slice(0, -2);
  return pattern === path;
}

export async function startServer({ root = DEFAULT_ROOT, port = 0, host = '127.0.0.1', observe = false, delays = {} } = {}) {
  const rules = JSON.parse(await readFile(join(root, 'headers.json'), 'utf8'));
  const log = [];
  const connections = { count: 0 };

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const url = new URL(req.url, 'http://placeholder');
    const entry = {
      time: Date.now(),
      method: req.method,
      url: req.url,
      path: url.pathname,
      headers: req.headers,
      body: Buffer.concat(chunks).toString('latin1'),
    };
    if (observe) log.push(entry);

    if (observe && url.pathname.startsWith(PROBE_PREFIX)) {
      res.writeHead(200, { 'content-type': 'text/plain', 'access-control-allow-origin': '*' });
      return res.end('reached');
    }

    const delay = delays[url.pathname];
    if (delay) await new Promise((r) => setTimeout(r, delay));

    const file = await resolveFile(root, url.pathname);
    const headers = {};
    for (const rule of rules) if (matches(rule.pattern, url.pathname)) Object.assign(headers, rule.headers);
    if (!file) {
      res.writeHead(404, { ...headers, 'content-type': 'text/plain; charset=utf-8' });
      return res.end('Not found');
    }
    headers['content-type'] = TYPES[extname(file)] || 'application/octet-stream';
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : await readFile(file));
  });
  server.on('connection', () => {
    connections.count += 1;
  });

  await new Promise((resolve) => server.listen(port, host, resolve));
  const origin = `http://${host}:${server.address().port}`;
  return {
    origin,
    log,
    connections,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(resolve);
      }),
  };
}

// Maps clean URLs the way static hosts do: /image serves image.html, / serves index.html.
async function resolveFile(root, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const candidates = decoded.endsWith('/') ? [decoded + 'index.html'] : [decoded, decoded + '.html'];
  for (const candidate of candidates) {
    const full = normalize(join(root, candidate));
    if (!full.startsWith(normalize(root).replace(/[\\/]?$/, sep))) return null; // path traversal
    if (/(^|[\\/])(headers\.json|build-info\.json|_headers|nginx-security-headers\.conf)$/.test(full)) continue;
    try {
      if ((await stat(full)).isFile()) return full;
    } catch {
      /* try next */
    }
  }
  return null;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const portArg = process.argv.indexOf('--port');
  const port = portArg > -1 ? Number(process.argv[portArg + 1]) : 8080;
  const hostArg = process.argv.indexOf('--host');
  const host = hostArg > -1 ? process.argv[hostArg + 1] : '127.0.0.1';
  const { origin } = await startServer({ port, host });
  console.log(`OfflineSeal Web: ${origin}/image`);
}
