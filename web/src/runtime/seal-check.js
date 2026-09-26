// Seal self-check shared by the sealed frame and its Workers. Inlined into
// both scripts by the build.
//
// It confirms that *this* global's own `connect-src 'none'` is being enforced.
// It tries to fetch a data: URL, so even without a policy nothing would leave
// the browser. Two things must both happen: the fetch is refused, and the
// browser reports a violation of a policy that says `connect-src 'none'`. That
// proves the sealed policy is active, not only a looser inherited one.
//
// `target` is where violation events fire: `document` in the frame, `self`
// in a Worker.

// eslint-disable-next-line no-unused-vars
const SealCheck = (() => {
  'use strict';

  function connectIsBlocked(target, timeoutMs = 3000) {
    return new Promise((resolve) => {
      let refused = false;
      let reported = false;
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        target.removeEventListener('securitypolicyviolation', onViolation);
        resolve(value);
      };
      const onViolation = (e) => {
        if (e.effectiveDirective === 'connect-src' && /(^|;)\s*connect-src 'none'/.test(e.originalPolicy)) {
          reported = true;
          if (refused) finish(true);
        }
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      target.addEventListener('securitypolicyviolation', onViolation);
      fetch('data:text/plain,offlineseal-seal-check').then(
        () => finish(false),
        () => {
          refused = true;
          if (reported) finish(true);
        },
      );
    });
  }

  // Delete every WebRTC constructor from a global. WebRTC is governed by neither
  // CSP nor the iframe sandbox. Returns true if none remain.
  function removeWebRtc(global) {
    for (const name of Object.getOwnPropertyNames(global)) {
      if (/^(webkit|moz)?RTC/.test(name)) {
        try {
          delete global[name];
        } catch {
          /* non-configurable: reported by the return value */
        }
      }
    }
    return !Object.getOwnPropertyNames(global).some((n) => /^(webkit|moz)?RTCPeerConnection$/.test(n));
  }

  return Object.freeze({ connectIsBlocked, removeWebRtc });
})();
