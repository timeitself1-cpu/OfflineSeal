// Single source of truth for every browser security policy OfflineSeal Web ships.
//
// build.mjs uses these functions to write the policies into the built pages
// (meta tags) and into the host header files (_headers, headers.json, nginx
// snippet). The unit tests check this module; the browser tests check what the
// browser actually enforces at runtime.
//
// Rule of thumb for every entry below: if the image converter does not need a
// capability, it is denied. Every allowance has a comment saying why it exists.

// ---------------------------------------------------------------------------
// Sealed processing frame: iframe sandbox
// ---------------------------------------------------------------------------

// allow-scripts:   the converter is JavaScript; without it nothing runs.
// allow-downloads: required to save the converted image. Verified in Chromium 141:
//                  without it, the click on the <a download href="blob:..."> link is
//                  silently dropped and no file is produced.
//
// Deliberately absent (each would widen what the frame can do):
//   allow-same-origin  -> would give the frame the site's real origin instead of an
//                         opaque one, letting it reach the shell's DOM and storage.
//   allow-forms        -> form submission is a network channel.
//   allow-popups       -> window.open() to an arbitrary URL is a network channel.
//   allow-top-navigation(-by-user-activation) -> could navigate the whole tab away,
//                         carrying data in the URL.
//   allow-modals, allow-presentation, allow-pointer-lock, allow-orientation-lock,
//   allow-storage-access-by-user-activation -> not needed by the converter.
export const SEALED_FRAME_SANDBOX = Object.freeze(['allow-scripts', 'allow-downloads']);

export const FORBIDDEN_SANDBOX_TOKENS = Object.freeze([
  'allow-same-origin',
  'allow-forms',
  'allow-popups',
  'allow-popups-to-escape-sandbox',
  'allow-top-navigation',
  'allow-top-navigation-by-user-activation',
  'allow-top-navigation-to-custom-protocols',
  'allow-modals',
  'allow-presentation',
  'allow-pointer-lock',
  'allow-orientation-lock',
  'allow-storage-access-by-user-activation',
]);

// The placeholder the shell replaces with a fresh random id for every frame it
// creates, so it can tell one frame instance's messages from another's.
export const INSTANCE_PLACEHOLDER = '__OFFLINESEAL_FRAME_INSTANCE__';

// ---------------------------------------------------------------------------
// Sealed processing frame: Content-Security-Policy
// ---------------------------------------------------------------------------

// The frame is an about:srcdoc document, so a host cannot attach HTTP headers to it.
// Its policy is carried in the payload as a <meta> tag. The browser *also*
// applies the shell's header-delivered policy to it (srcdoc documents inherit
// their parent's policy container), so the frame is bound by both. Where they
// differ, the stricter one wins.
export function sealedFrameCsp({ scriptHash, styleHash }) {
  return serializeCsp([
    ['default-src', "'none'"],
    // Only the one inline script bundled in the payload, identified by hash.
    ['script-src', `'sha256-${scriptHash}'`],
    // Only the one inline <style> block bundled in the payload, identified by hash.
    ['style-src', `'sha256-${styleHash}'`],
    // Previews are drawn on <canvas> from createImageBitmap(), so the frame does
    // not need to load any image URL, not even blob: or data:.
    ['img-src', "'none'"],
    ['media-src', "'none'"],
    ['font-src', "'none'"],
    // fetch, XHR, sendBeacon, WebSocket, EventSource, <a ping>.
    ['connect-src', "'none'"],
    ['form-action', "'none'"],
    ['frame-src', "'none'"],
    ['child-src', "'none'"],
    ['worker-src', "'none'"],
    ['object-src', "'none'"],
    ['manifest-src', "'none'"],
    ['base-uri', "'none'"],
    // No HTML-from-string sinks at all. The converter builds its DOM with
    // createElement/textContent. This also stops the frame from creating a
    // nested srcdoc document to get a fresh, unhardened JavaScript realm.
    ['require-trusted-types-for', "'script'"],
    ['trusted-types', "'none'"],
  ]);
}

// ---------------------------------------------------------------------------
// Outer shell: Content-Security-Policy
// ---------------------------------------------------------------------------

export const SHELL_TRUSTED_TYPES_POLICY = 'offlineseal-sealed-frame';

// The shell may use the network, but only to download its own files from its
// own origin. It never sends user data anywhere, and it has no code path that
// forwards a request on the frame's behalf.
//
// forHeader=false produces the <meta> copy. frame-ancestors is not valid in a
// meta policy, so it is left out there. The meta copy is a fallback for hosts
// that fail to send the header.
export function shellCsp({ scriptHash, styleHash }, { forHeader = true } = {}) {
  const directives = [
    ['default-src', "'none'"],
    // The shell's own modules. The sealed script's hash is listed because the
    // srcdoc frame inherits this policy too: without it, the inherited policy
    // would block the frame's only script.
    ['script-src', "'self'", `'sha256-${scriptHash}'`],
    ['style-src', "'self'", `'sha256-${styleHash}'`],
    // The site icon.
    ['img-src', "'self'"],
    // The shell downloads the pinned tool payload from its own origin, and
    // nothing else. (The frame's own policy narrows this to 'none'.)
    ['connect-src', "'self'"],
    // The processing frame is an about:srcdoc document, which frame-src does
    // not govern. 'none' then blocks every *navigation* of that frame to a real
    // URL, including the frame navigating itself. Without it, the frame could
    // leak data by doing location.href = 'https://example/?data=...'.
    ['frame-src', "'none'"],
    ['child-src', "'none'"],
    ['worker-src', "'none'"],
    ['form-action', "'none'"],
    ['object-src', "'none'"],
    ['media-src', "'none'"],
    ['font-src', "'none'"],
    ['manifest-src', "'none'"],
    ['base-uri', "'none'"],
    // The only HTML-from-string sink in the shell is iframe.srcdoc. The named
    // Trusted Types policy only accepts the integrity-verified tool payload.
    ['require-trusted-types-for', "'script'"],
    ['trusted-types', SHELL_TRUSTED_TYPES_POLICY],
  ];
  if (forHeader) directives.push(['frame-ancestors', "'none'"]);
  return serializeCsp(directives);
}

// ---------------------------------------------------------------------------
// Permissions-Policy
// ---------------------------------------------------------------------------

// The converter needs none of these, so every one is disabled for the shell and
// for every frame inside it. The list only holds features Chromium recognises:
// Chromium 141 reports "Unrecognized feature" for 'bluetooth' and 'web-share'
// and ignores them, so listing them would only produce console warnings. The
// browser tests fail if Chromium reports any entry here as unrecognised.
export const PERMISSIONS_POLICY_DENIED = Object.freeze([
  'accelerometer',
  'attribution-reporting',
  'autoplay',
  'browsing-topics',
  'camera',
  'clipboard-read',
  'clipboard-write',
  'compute-pressure',
  'display-capture',
  'encrypted-media',
  'fullscreen',
  'gamepad',
  'geolocation',
  'gyroscope',
  'hid',
  'identity-credentials-get',
  'idle-detection',
  'local-fonts',
  'magnetometer',
  'microphone',
  'midi',
  'otp-credentials',
  'payment',
  'picture-in-picture',
  'publickey-credentials-create',
  'publickey-credentials-get',
  'screen-wake-lock',
  'serial',
  'storage-access',
  'sync-xhr',
  'usb',
  'window-management',
  'xr-spatial-tracking',
]);

export function permissionsPolicy() {
  return PERMISSIONS_POLICY_DENIED.map((feature) => `${feature}=()`).join(', ');
}

// ---------------------------------------------------------------------------
// HTTP response headers for the whole static site
// ---------------------------------------------------------------------------

export function siteHeaders(hashes) {
  return [
    {
      pattern: '/*',
      headers: {
        'Content-Security-Policy': shellCsp(hashes, { forHeader: true }),
        'Permissions-Policy': permissionsPolicy(),
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
        // Legacy equivalent of frame-ancestors 'none', for older browsers.
        'X-Frame-Options': 'DENY',
        // Puts OfflineSeal in its own browsing context group: no window.opener
        // relationship with pages that link to it or that it links to.
        'Cross-Origin-Opener-Policy': 'same-origin',
        // Other sites cannot embed OfflineSeal's files as subresources.
        'Cross-Origin-Resource-Policy': 'same-origin',
        'Origin-Agent-Cluster': '?1',
        'X-DNS-Prefetch-Control': 'off',
        // Ignored by browsers over plain http (local development). On the
        // production HTTPS origin it makes the browser refuse plain http.
        'Strict-Transport-Security': 'max-age=31536000',
      },
    },
    {
      // Versioned by content hash in sealed-manifest.js, but kept short-lived so
      // a fix ships promptly. The payload is integrity-checked on every load.
      pattern: '/assets/*',
      headers: { 'Cache-Control': 'public, max-age=300' },
    },
  ];
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function serializeCsp(directives) {
  return directives.map((parts) => parts.join(' ')).join('; ');
}

export function parseCsp(policy) {
  const out = new Map();
  for (const raw of policy.split(';')) {
    const parts = raw.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) continue;
    const [name, ...values] = parts;
    out.set(name.toLowerCase(), values);
  }
  return out;
}
