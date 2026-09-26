# OfflineSeal Web

> The tool can have the internet, or it can have your file — never both.

OfflineSeal Web is the zero-install edition of OfflineSeal. You open a link such as
`https://offlineseal.app/image` in a normal browser. The page downloads the
processing tool, seals it inside a browser sandbox with no network access, and
only then lets your file in. Your file is processed on your device, and the result
is saved as a normal download.

**Processed locally in your browser. Your original file is never uploaded by OfflineSeal.**

This first release has one tool, the **Image Converter**: PNG, JPEG, WebP, GIF, BMP
and AVIF in; PNG, JPEG or WebP out, with optional resizing.

| | OfflineSeal Web | OfflineSeal Desktop |
|---|---|---|
| Delivery | Shareable HTTPS URL, nothing to install | Local application and runtime |
| Where the file is processed | A sandboxed frame in your browser | A disposable container on your computer |
| Isolation | **Browser-enforced** (iframe sandbox + Content Security Policy) | **OS-enforced** (network namespace, `network=none`) |
| Claim | Browser policy stops the tool from making network requests | The tool is physically disconnected from the network |

The two editions share the same idea, but they do not make the same security
claims. Web mode never claims OS-level isolation.

![Converted image, ready to download](docs/screenshots/04-converted-1440.png)

---

## How it works

```
User opens /image
  │
  ▼
Outer shell (network-capable, same-origin only)
  1. downloads the tool payload            GET assets/sealed/image-converter.sealed.txt
  2. verifies it against a pinned SHA-384  fetch(…, { integrity })   ── mismatch → refuse
  3. creates <iframe sandbox="allow-scripts allow-downloads" srcdoc=…> (inert)
  │
  ▼
Sealed frame (opaque origin, no network)
  4. removes WebRTC, then checks its own seal:
       origin is opaque · shell is unreachable · its own connect-src 'none' is enforced
  5. posts `frame-ready`                   ── any check fails → `seal-failed` → shell shuts it down
  │
  ▼
Shell removes `inert`: READY
  │
  ▼
User drops or chooses an image INSIDE the frame
  6. decode → preview → convert → verify output → <a download href="blob:…">
  7. result is saved by the browser as a download
```

Every new image gets a fresh frame. **Use another image** destroys the old frame,
along with its image and result, and seals a new one, much as Desktop uses a new
container for each file.

### Where your file exists and where it does not

| Place | Has the file or its bytes? |
|---|---|
| Sealed frame (opaque origin, no network) | **Yes.** The `File` object, the decoded pixels, and the converted `Blob` exist only here. |
| Your Downloads folder | The converted result, when you click Download. |
| Outer shell page | **No.** It has no file input, never reads drop data, and receives only status messages. |
| OfflineSeal's server | **No.** There is no upload endpoint or processing API, and no request is made after READY. |

The shell learns only these status events: `frame-ready`, `seal-failed`,
`file-selected`, `processing-started`, `processing-complete` and
`processing-failed`. It does not even learn the file name.

### The shell ↔ frame protocol

- One direction only: frame → shell. The shell never posts anything to the frame,
  and the frame never listens for messages.
- Six fixed message types. Every message must have exactly the keys `protocol`,
  `instance` and `type`, plus `code` on the two failure types, where it comes
  from a fixed list.
- Each message is checked for `event.source` (the live frame's window),
  `event.origin === "null"`, the frame instance id, its exact shape, and whether
  it is allowed in the current lifecycle state. Anything else is dropped and
  counted.
- No message can make the shell fetch, open, navigate, upload or run anything.
  There is no generic operation.

See [`src/shell/assets/protocol.js`](src/shell/assets/protocol.js).

---

## Security boundary: what browser mode enforces

**Enforced by the browser**, and verified at runtime by the tests in Chromium 141:

- **Opaque origin.** The frame is sandboxed without `allow-same-origin`, so it
  cannot read the shell's DOM, cookies or storage.
- **No network from the frame.** `connect-src 'none'` and `default-src 'none'`
  cover fetch, XHR, `sendBeacon`, WebSocket, EventSource, WebTransport and every
  resource type (images, CSS, fonts, media, scripts, workers, objects, prefetch).
- **No forms, popups or top-level navigation.** These sandbox flags are absent,
  and `form-action 'none'` is set.
- **No self-navigation.** The shell's `frame-src 'none'` stops the frame from
  navigating itself to any URL, including same-origin URLs with data in the query
  string. If a navigation is attempted anyway, the shell sees the extra `load`
  event and destroys the frame.
- **No code the tool didn't ship.** `script-src` allows one SHA-256 hash, with no
  `'unsafe-inline'` and no `'unsafe-eval'`. Trusted Types `'none'` blocks every
  HTML-from-string sink, including nested `srcdoc` frames.
- **Pinned tool.** The shell uses the payload only if it matches the SHA-384
  compiled into the shell (Subresource Integrity).
- **Fail closed.** If the payload doesn't match, a seal self-check fails, the
  frame stays silent for 10 s, or the frame navigates, there is no processing
  area and no file can be added.

**Not enforced by browser policy**, stated plainly:

- **WebRTC.** Neither CSP nor the iframe sandbox governs WebRTC (STUN/TURN over
  UDP) in current browsers. Chromium 141 does not recognise CSP3's
  `webrtc 'block'`. In testing, an unhardened frame with this exact policy sent
  STUN packets. As mitigation, the frame deletes the WebRTC constructors before
  any other code runs. This is **JavaScript-level hardening**, not a browser
  boundary. It holds because the frame cannot load or evaluate any other code
  (one script hash, no eval, and Trusted Types blocks nested `srcdoc`), and a
  nested `about:blank` frame is cross-origin to it. Browsers without Trusted
  Types (older Firefox) lose that last property.
- **DNS.** Tests confirm that `<link rel=dns-prefetch/preconnect>` produced no
  TCP connection, and `x-dns-prefetch-control: off` is set. However, a local HTTP
  test server cannot observe DNS lookups.
- **Browser extensions** that can read page content can read the frame too.
- **The browser itself.** The browser vendor's own services (sync, safe-browsing
  checks on downloads, crash reports) are outside what a web page can control.
- **The tool is first-party.** Browser policy stops the frame from using the
  network. It does not stop the frame from putting wrong pixels in your output.
  The Image Converter is written and reviewed as part of OfflineSeal, and a
  static audit test checks that it uses no network API.

Need OS-enforced isolation instead? That is what OfflineSeal Desktop is for.

---

## Exact policies

The policies are generated from one module, [`src/policy.mjs`](src/policy.mjs), by
`build.mjs`. The hashes change whenever the tool's code changes; the current values
are in `dist/build-info.json` after a build.

**Sealed frame sandbox** (checked on the live DOM by the tests):

```
sandbox="allow-scripts allow-downloads"
```

`allow-downloads` is required. Without it, Chromium silently drops the
`<a download>` click and no file is saved (verified). Every other token is absent,
including `allow-same-origin`, `allow-forms`, `allow-popups`, `allow-modals` and
all `allow-top-navigation*`.

**Sealed frame CSP** (a `<meta>` in the payload; `srcdoc` documents cannot have HTTP headers):

```
default-src 'none'; script-src 'sha256-<tool script>'; style-src 'sha256-<tool style>';
img-src 'none'; media-src 'none'; font-src 'none'; connect-src 'none'; form-action 'none';
frame-src 'none'; child-src 'none'; worker-src 'none'; object-src 'none'; manifest-src 'none';
base-uri 'none'; require-trusted-types-for 'script'; trusted-types 'none'
```

The frame also inherits the shell's header CSP below. Both apply.

**Shell CSP** (HTTP header; the page also carries the same policy as a `<meta>` fallback, without `frame-ancestors`):

```
default-src 'none'; script-src 'self' 'sha256-<tool script>'; style-src 'self' 'sha256-<tool style>';
img-src 'self'; connect-src 'self'; frame-src 'none'; child-src 'none'; worker-src 'none';
form-action 'none'; object-src 'none'; media-src 'none'; font-src 'none'; manifest-src 'none';
base-uri 'none'; require-trusted-types-for 'script'; trusted-types offlineseal-sealed-frame;
frame-ancestors 'none'
```

**Other response headers**:

```
Permissions-Policy: accelerometer=(), attribution-reporting=(), autoplay=(), browsing-topics=(),
  camera=(), clipboard-read=(), clipboard-write=(), compute-pressure=(), display-capture=(),
  encrypted-media=(), fullscreen=(), gamepad=(), geolocation=(), gyroscope=(), hid=(),
  identity-credentials-get=(), idle-detection=(), local-fonts=(), magnetometer=(), microphone=(),
  midi=(), otp-credentials=(), payment=(), picture-in-picture=(), publickey-credentials-create=(),
  publickey-credentials-get=(), screen-wake-lock=(), serial=(), storage-access=(), sync-xhr=(),
  usb=(), window-management=(), xr-spatial-tracking=()
Referrer-Policy: no-referrer
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Resource-Policy: same-origin
Origin-Agent-Cluster: ?1
X-DNS-Prefetch-Control: off
Strict-Transport-Security: max-age=31536000
```

The converter needs no browser permission, so every feature is `()`. `bluetooth`
and `web-share` are left out because Chromium 141 reports them as unrecognised
and ignores them.

`Cross-Origin-Embedder-Policy` is deliberately **not** set. It would enable
cross-origin isolation (SharedArrayBuffer), which the tool doesn't need. The CSP
already blocks every cross-origin load, so COEP would add no protection here.

---

## Develop and test

```sh
cd web
npm ci
npx playwright install chromium   # not needed where Chromium is preinstalled
npm test                          # build + 42 unit tests + 28 browser tests
npm run serve                     # http://127.0.0.1:8080/image
npm run evidence                  # screenshots + network log into docs/
```

| Suite | What it checks |
|---|---|
| `test/unit/protocol` | Message allowlist and lifecycle state machine. |
| `test/unit/policy` | Sandbox tokens; every CSP directive; no wildcard, scheme, `unsafe-*` or host sources; required headers. |
| `test/unit/build` | Payload integrity, script/style hashes, CSP placement, no external URLs, trackers or fonts, deterministic output. |
| `test/unit/sealed-audit` | The tool code uses no network API, no eval/HTML sinks, and posts only protocol messages. The shell never reads files. |
| `test/unit/server`, `converter-core` | Clean URLs and headers; converter maths, format sniffing, file names. |
| `test/e2e/policy` | Live iframe sandbox, opaque origin, enforced frame CSP, response headers, Permissions-Policy, frame-ancestors. |
| `test/e2e/network-probes` | 36 benign probe channels from the live frame (details below). Positive controls; self-navigation; shell online but no relay. |
| `test/e2e/data-isolation` | A synthetic marker image end to end with the shell realm and server instrumented, plus a positive control for the detector. |
| `test/e2e/messages` | 16 hostile messages have no effect; messages from other windows are ignored; COOP severs openers. |
| `test/e2e/lifecycle` | No file admission before READY; tamper, seal-failure and timeout paths fail closed; a fresh frame per image; drops on the page are ignored. |
| `test/e2e/conversion` | PNG→JPEG/WebP/PNG, resize, alpha flattening, JPEG/GIF input, drag and drop, bad input. Outputs are decoded in a separate clean page. |

The probe channels cover fetch (same-origin, cross-origin, POST, keepalive), XHR,
sendBeacon, WebSocket, EventSource, WebTransport, image, SVG image, CSS
background, CSSOM `@import`, FontFace, stylesheet, prefetch, preload,
modulepreload, preconnect, dns-prefetch, script, iframe, object, embed, Worker,
SharedWorker, audio, video poster, GET and POST forms, `window.open`, top
navigation, `target=_top` and `_blank` links, meta refresh, WebRTC (direct and via
a nested frame), and nested `srcdoc`. The pass condition is that the probe servers
observe **zero** HTTP requests, TCP connections, WebSocket upgrades and UDP
packets.

The probes carry only a fixed harmless string, never file content. They show what
the browser enforced in this run; they are not proof against every conceivable
browser behaviour.

### Browser support

| Browser | Status |
|---|---|
| Chrome / Chromium 141 | **Automated.** All tests run here. |
| Edge | Chromium-based, so expected to behave the same. **Not run.** |
| Firefox | **Not run.** Firefox could not be installed in the environment used for this release. Expected differences: Trusted Types support depends on version (without it, the shell falls back to a plain string for `srcdoc`, and the frame loses its Trusted Types defences); `document.featurePolicy` doesn't exist, so the Permissions-Policy test is Chromium-specific. The frame's seal self-check still runs, so a Firefox that failed to enforce `connect-src` would fail closed. |
| Safari | Not a target. It has no WebP encoder, so the frame hides the WebP option. |

## Deploy

See [`deploy/README.md`](deploy/README.md). In short: run `npm run build` and serve
`web/dist/` over HTTPS with the headers from `dist/_headers`. Cloudflare Pages and
Netlify read `_headers` automatically, and an nginx example is included.
