# OfflineSeal

> **The tool can have the internet, or it can have your file — never both.**

OfflineSeal lets you use software on private files without sending those files to
the software's owner. The tool comes to your data, instead of your data going to
the tool. OfflineSeal first loads the tool completely, then seals off its network
access, and only then lets your file in.

OfflineSeal has two editions, with two different levels of assurance:

```
OFFLINESEAL WEB                         OFFLINESEAL DESKTOP
───────────────                         ───────────────────
Shareable HTTPS URL                     Local application/runtime
Zero installation                       Disposable per-file containers
Local browser processing                Network namespace isolation
Browser-enforced isolation              OS-enforced boundary
```

They share the same idea, but they do not make the same security claims. Desktop is
the high-assurance edition: every file is processed in a fresh container with no
network, enforced by the operating system. Web is the convenient edition: the
browser's sandbox and Content Security Policy keep the tool off the network. It is
not OS-level isolation.

## OfflineSeal Web

[`web/`](web/) is a self-contained static web application. Its first tool is an
Image Converter at `/image`. Open the link, wait for **Ready for your file**, then
drop an image. The image is converted in a sandboxed frame in your browser and
saved as a normal download. Nothing is uploaded.

- Architecture, security boundary, exact policies and limits: [`web/README.md`](web/README.md)
- Deployment: [`web/deploy/README.md`](web/deploy/README.md)
- Tests: `cd web && npm ci && npm test`

![OfflineSeal Web: ready for your file](web/docs/screenshots/02-ready-1440.png)

## OfflineSeal Desktop

OfflineSeal Desktop processes each file in its own disposable container with
Docker `network=none`, a read-only root, and a pinned, verified tool. The container
is destroyed after each file.

The Desktop edition's source is not in this repository yet. OfflineSeal Web does
not depend on it or share any code or runtime with it. Web lives entirely under
`web/`, so it cannot pick up Desktop's host or agent privileges.

## Repository layout

```
web/                  OfflineSeal Web (static site, no server-side code)
  src/policy.mjs      every sandbox/CSP/header policy, in one place
  src/shell/          the outer, network-capable page (never touches your file)
  src/sealed/         the sealed Image Converter (runs in the sandboxed frame)
  build.mjs           builds web/dist/ and the host header files
  server/serve.mjs    local static server that applies the same headers
  test/               unit + browser (Playwright/Chromium) tests
  deploy/             hosting guide and nginx example
  docs/               screenshots and network evidence
```
