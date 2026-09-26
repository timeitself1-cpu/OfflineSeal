// Builds the deployable static site into web/dist/.
//
// OfflineSeal Web is a small trusted runtime plus tools. A tool is a directory
// under src/tools/ holding:
//   manifest.json   the declarative contract (see src/runtime/tool-schema.js)
//   *.js            Worker-only code: helper files in name order, then tool.js
//
// For every tool the build:
//  1. validates the manifest with the runtime's own schema (a bad manifest
//     fails the build);
//  2. assembles the tool's Worker script: the runtime Worker host, then the
//     tool code;
//  3. writes a self-contained payload. It contains the shared frame runtime
//     (the same script and style bytes for every tool, pinned by SHA-256 in the
//     CSP), plus the tool's manifest and Worker code as inert data blocks. The
//     shell pins the whole payload by SHA-384 (Subresource Integrity);
//  4. writes a shell page at the manifest's path (e.g. /image, /pdf).
// It also writes the landing page and the host header files (_headers,
// headers.json, nginx snippet) from src/policy.mjs.
//
// Deterministic: the same sources always produce byte-identical output.

import { createHash } from 'node:crypto';
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import {
  INSTANCE_PLACEHOLDER,
  SEALED_FRAME_SANDBOX,
  SHELL_TRUSTED_TYPES_POLICY,
  SEALED_WORKER_TRUSTED_TYPES_POLICY,
  sealedFrameCsp,
  shellCsp,
  siteHeaders,
} from './src/policy.mjs';
import { PROTOCOL_ID } from './src/shell/assets/protocol.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
const SRC = join(ROOT, 'src');
export const DIST = join(ROOT, 'dist');
export const TOOLS_DIR = join(SRC, 'tools');

const sha = (alg, data) => createHash(alg).update(data, 'utf8').digest('base64');
const read = (...parts) => readFile(join(...parts), 'utf8');

function fill(template, values, label) {
  const out = template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (m, key) => {
    if (!(key in values)) throw new Error(`${label}: no value for {{${key}}}`);
    return values[key];
  });
  if (/\{\{[A-Z0-9_]+\}\}/.test(out)) throw new Error(`${label}: unfilled placeholder`);
  return out;
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const iife = (...parts) => ['(() => {', "'use strict';", ...parts.map((p) => p.trim()), '})();'].join('\n');

// The runtime's schema module, evaluated here so the build validates manifests
// with exactly the code the browser will run.
export async function loadToolSchema() {
  const source = await read(SRC, 'runtime/tool-schema.js');
  return vm.runInNewContext(`${source}\nToolSchema`, Object.create(null));
}

// The trusted frame runtime: identical for every tool.
export async function buildRuntime() {
  const [schema, protocol, sealCheck, frame, style, template] = await Promise.all(
    ['tool-schema.js', 'worker-protocol.js', 'seal-check.js', 'frame.js', 'frame.css', 'frame.html'].map((f) => read(SRC, 'runtime', f)),
  );
  const script = iife(`const PROTOCOL_ID = ${JSON.stringify(PROTOCOL_ID)};`, schema, protocol, sealCheck, frame);
  if (/<\/script|<!--/i.test(script)) throw new Error('runtime script contains a sequence that would break inlining');
  if (/<\/style/i.test(style)) throw new Error('runtime style contains </style');
  const hashes = { scriptHash: sha('sha256', script), styleHash: sha('sha256', style) };
  return { script, style, template, hashes, csp: sealedFrameCsp(hashes), workerHost: { schema, protocol, sealCheck, host: await read(SRC, 'runtime', 'worker-host.js') } };
}

// One tool: validated manifest, Worker script, payload.
export async function buildTool(toolDir, runtime) {
  runtime ??= await buildRuntime();
  const ToolSchema = await loadToolSchema();
  const manifestText = await read(toolDir, 'manifest.json');
  let manifest;
  try {
    manifest = ToolSchema.validateManifest(JSON.parse(manifestText));
  } catch (e) {
    throw new Error(`${toolDir}: invalid manifest: ${e.message}`);
  }
  const jsFiles = (await readdir(toolDir)).filter((f) => f.endsWith('.js')).sort();
  if (!jsFiles.includes('tool.js')) throw new Error(`${toolDir}: missing tool.js`);
  const helpers = jsFiles.filter((f) => f !== 'tool.js');
  const toolSources = await Promise.all([...helpers, 'tool.js'].map((f) => read(toolDir, f)));
  const manifestJson = JSON.stringify(manifest);
  const { schema, protocol, sealCheck, host } = runtime.workerHost;
  const workerScript = iife(`const TOOL_MANIFEST = ${manifestJson};`, schema, protocol, sealCheck, host, ...toolSources);

  const payload = fill(
    runtime.template,
    {
      SEALED_CSP: runtime.csp,
      RUNTIME_STYLE: runtime.style,
      RUNTIME_SCRIPT: runtime.script,
      // Inert data blocks: not executed, so the CSP does not govern them. The
      // payload's SRI hash covers them, and the runtime validates the manifest.
      TOOL_MANIFEST: manifestJson.replace(/</g, '\\u003c'),
      TOOL_WORKER_BASE64: Buffer.from(workerScript, 'utf8').toString('base64'),
      INSTANCE_PLACEHOLDER,
    },
    `${manifest.id} payload`,
  );
  return {
    manifest,
    workerScript,
    payload,
    payloadPath: `assets/sealed/${manifest.id}.sealed.txt`,
    integrity: `sha384-${sha('sha384', payload)}`,
  };
}

export async function listToolDirs() {
  const entries = await readdir(TOOLS_DIR, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory()).map((e) => join(TOOLS_DIR, e.name)).sort();
}

export async function build({ outDir = DIST, quiet = false, extraToolDirs = [] } = {}) {
  const runtime = await buildRuntime();
  const toolDirs = [...(await listToolDirs()), ...extraToolDirs];
  const tools = [];
  for (const dir of toolDirs) tools.push(await buildTool(dir, runtime));
  for (const [i, t] of tools.entries()) {
    if (tools.findIndex((o) => o.manifest.id === t.manifest.id || o.manifest.shell.path === t.manifest.shell.path) !== i) {
      throw new Error(`duplicate tool id or path: ${t.manifest.id}`);
    }
  }

  const shellMetaCsp = shellCsp(runtime.hashes, { forHeader: false });
  const shellHeaderCsp = shellCsp(runtime.hashes, { forHeader: true });
  const headers = siteHeaders(runtime.hashes);

  await rm(outDir, { recursive: true, force: true });
  await mkdir(join(outDir, 'assets/sealed'), { recursive: true });

  const toolTemplate = await read(SRC, 'shell/tool.html');
  for (const t of tools) {
    const s = t.manifest.shell;
    await writeFile(
      join(outDir, `${s.path}.html`),
      fill(toolTemplate, { SHELL_CSP_META: shellMetaCsp, TOOL_ID: escapeHtml(t.manifest.id), TITLE: escapeHtml(s.title), LEDE: escapeHtml(s.lede), RESTART_LABEL: escapeHtml(s.restartLabel) }, `${s.path}.html`),
    );
    await writeFile(join(outDir, t.payloadPath), t.payload);
  }
  const cards = tools
    .map((t) => `    <a class="tool-card" href="${escapeHtml(t.manifest.shell.path)}">\n      <h2>${escapeHtml(t.manifest.shell.title)} →</h2>\n      <p>${escapeHtml(t.manifest.shell.lede)}</p>\n    </a>`)
    .join('\n');
  await writeFile(join(outDir, 'index.html'), fill(await read(SRC, 'shell/index.html'), { SHELL_CSP_META: shellMetaCsp, TOOL_CARDS: cards }, 'index.html'));
  for (const asset of ['app.js', 'protocol.js', 'shell.css', 'icon.svg']) {
    await copyFile(join(SRC, 'shell/assets', asset), join(outDir, 'assets', asset));
  }

  const registry = Object.fromEntries(
    tools.map((t) => [t.manifest.id, { name: t.manifest.name, version: t.manifest.version, path: './' + t.payloadPath.slice('assets/'.length), integrity: t.integrity }]),
  );
  await writeFile(
    join(outDir, 'assets/sealed-manifest.js'),
    '// Generated by web/build.mjs. Do not edit: rebuild instead.\n' +
      `export const SEALED_RUNTIME = Object.freeze(${JSON.stringify(
        {
          sandbox: SEALED_FRAME_SANDBOX,
          instancePlaceholder: INSTANCE_PLACEHOLDER,
          trustedTypesPolicy: SHELL_TRUSTED_TYPES_POLICY,
          runtimeScriptHash: `sha256-${runtime.hashes.scriptHash}`,
        },
        null,
        2,
      )});\n` +
      `export const SEALED_TOOLS = Object.freeze(${JSON.stringify(registry, null, 2)});\n`,
  );

  await writeFile(join(outDir, 'headers.json'), JSON.stringify(headers, null, 2) + '\n');
  await writeFile(join(outDir, '_headers'), toNetlifyHeaders(headers));
  await writeFile(join(outDir, 'nginx-security-headers.conf'), toNginx(headers[0].headers));

  const info = {
    runtimeScriptHash: runtime.hashes.scriptHash,
    runtimeStyleHash: runtime.hashes.styleHash,
    sandbox: SEALED_FRAME_SANDBOX.join(' '),
    workerTrustedTypesPolicy: SEALED_WORKER_TRUSTED_TYPES_POLICY,
    sealedCsp: runtime.csp,
    shellCspHeader: shellHeaderCsp,
    shellCspMeta: shellMetaCsp,
    tools: Object.fromEntries(
      tools.map((t) => [
        t.manifest.id,
        {
          path: t.manifest.shell.path,
          payloadPath: t.payloadPath,
          integrity: t.integrity,
          payloadBytes: Buffer.byteLength(t.payload),
          workerSourceSha256: createHash('sha256').update(t.workerScript, 'utf8').digest('hex'),
        },
      ]),
    ),
  };
  await writeFile(join(outDir, 'build-info.json'), JSON.stringify(info, null, 2) + '\n');

  if (!quiet) {
    console.log(`OfflineSeal Web built into ${outDir}`);
    console.log(`  runtime script sha256-${runtime.hashes.scriptHash} (shared by every tool)`);
    for (const t of tools) console.log(`  /${t.manifest.shell.path}  ${t.manifest.id} ${t.manifest.version}  ${Buffer.byteLength(t.payload)} bytes  ${t.integrity}`);
  }
  return info;
}

function toNetlifyHeaders(rules) {
  const lines = ['# Generated by web/build.mjs from src/policy.mjs. Netlify / Cloudflare Pages format.'];
  for (const { pattern, headers } of rules) {
    lines.push(pattern);
    for (const [name, value] of Object.entries(headers)) lines.push(`  ${name}: ${value}`);
  }
  return lines.join('\n') + '\n';
}

function toNginx(headers) {
  const lines = ['# Generated by web/build.mjs from src/policy.mjs. Include in every location that serves OfflineSeal Web.'];
  for (const [name, value] of Object.entries(headers)) {
    lines.push(`add_header ${name} "${value.replace(/"/g, '\\"')}" always;`);
  }
  return lines.join('\n') + '\n';
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await build();
}
