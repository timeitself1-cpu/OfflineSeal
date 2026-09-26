# Deploying OfflineSeal Web

OfflineSeal Web is a static site. There is no server-side code, upload endpoint or
processing API.

```sh
cd web
npm ci
npm run build      # writes web/dist/
```

Serve `web/dist/` over **HTTPS**. The host must:

1. **Send the security headers** in `dist/_headers`, which is generated from
   `src/policy.mjs`. The most important is the shell's `Content-Security-Policy`
   header: its `frame-src 'none'` stops the sealed frame from navigating itself,
   and `frame-ancestors` only works as a header. The pages also carry the CSP as
   a `<meta>` tag, so a host that drops headers still gets most of the protection
   (everything except `frame-ancestors`, Permissions-Policy, COOP and CORP). Such
   a host is still **not a supported deployment**.
2. **Map clean URLs**: `/image` → `image.html`, `/` → `index.html`.
3. **Serve `.txt` as `text/plain`**. The tool payload
   (`assets/sealed/image-converter.sealed.txt`) is data for the shell, never a page.
4. **Not rewrite the files.** Injected analytics snippets, "rocket loaders",
   minifiers or HTML rewriting would change the pinned hashes. The page would then
   refuse to run, which is the intended fail-closed behaviour.
5. **Not serve** `headers.json`, `build-info.json` or
   `nginx-security-headers.conf`. They are build outputs for configuring the
   host. They contain no secrets, but there is no reason to publish them.

Headers are per build. The CSP contains hashes of the tool's code, so redeploy
`_headers` (or the nginx snippet) together with the files every time you build.

## Cloudflare Pages

- Build command: `cd web && npm ci && npm run build`
- Output directory: `web/dist`
- `_headers` in the output is applied automatically, and `/image` serves `image.html`.

## Netlify

- Base directory: `web`
- Build command: `npm ci && npm run build`
- Publish directory: `dist`
- `_headers` in the publish directory is applied automatically, and pretty URLs
  serve `image.html` at `/image`.

## nginx

See [`nginx.conf.example`](nginx.conf.example). It includes the generated
`dist/nginx-security-headers.conf`. nginx only inherits `add_header` into a
`location` block that has no `add_header` of its own, so the example includes
the snippet in every location.

## GitHub Pages and other hosts without custom headers

These work only in the reduced meta-CSP mode described above, and are not
recommended.

## Checking a deployment

Open `https://<your-host>/image`, then open DevTools:

- **Network tab:** only the page, `shell.css`, `app.js`, `protocol.js`,
  `sealed-manifest.js` and the `.sealed.txt` payload load from the network. After
  "Ready for your file", converting and downloading an image adds **no network
  requests**. You will see one `blob:null/…` entry per job (inspecting the
  image, each conversion). That is a fresh processing Worker starting from the
  pinned Worker code, which is held in memory; it is not a network request.
- **Console:** each seal check shows as a refused `data:` fetch
  (`Refused to connect to 'data:text/plain,offlineseal-seal-check'`). There is one
  from the frame, and one from each processing Worker before it touches your
  file. Those entries are the checks proving `connect-src 'none'` is enforced;
  they are expected.
- **Response headers of `/image`:** they match `dist/_headers`.
- **Technical details** at the bottom of the page: they show the live sandbox, the
  observed frame origin (`null`) and both CSPs.
