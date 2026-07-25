# Hosting the web UI (cross-origin isolation for the threaded bundle)

The multi-threaded WASM bundle (`learnttt-threaded.js`, built by
`./build-wasm.sh --threads`) uses pthreads + `SharedArrayBuffer`, which the
browser only permits when the document is **cross-origin isolated**
(`self.crossOriginIsolated === true`). The single-thread fallback bundle
(`learnttt.js`) needs none of this and works on any host. See
`docs/PLAN-wasm-web-speedup.md` §8.2 / §8.3.

`app.js` feature-detects `crossOriginIsolated` and loads the threaded bundle only
when it is `true`; otherwise it loads `learnttt.js` and plays single-threaded
(identical moves, just slower). So isolation is a **speed** feature — the UI is
fully functional without it — but you get the multi-core speedup only when it is on.

Cross-origin isolation requires two response headers on **the HTML document** (and,
with the service-worker shim below, on every same-origin subresource):

```
Cross-Origin-Opener-Policy:   same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Under `COEP: require-corp`, every **cross-origin** subresource must itself carry a
CORP/CORS header or it is blocked. This repo's `web/` has been audited and made
self-contained for that mode:

- **Fonts are self-hosted** — `dm-fonts.css` + `web/fonts/*.woff2` (DM Sans, DM
  Serif Display, OFL-1.1). The former Google Fonts `<link>`s are gone
  (`index.html`), so no cross-origin font fetch remains.
- `fzstd.js` and `style.css` are same-origin (bundled in `web/`).
- The only `fetch()`s (`app.js`: sweep CSV, bundled save) are **same-origin
  relative paths** — unaffected by COEP.

## Pick the hosting path

### A. You control the headers (own server, nginx/Caddy, Netlify/Cloudflare `_headers`)

Set the two headers directly on the document response. Examples:

**nginx**
```nginx
location / {
    add_header Cross-Origin-Opener-Policy   same-origin;
    add_header Cross-Origin-Embedder-Policy  require-corp;
}
```

**Netlify / Cloudflare Pages `_headers`**
```
/*
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp
```

This is the robust path — no reload race, works in private mode. Do **not** wire the
service worker below if you set real headers.

### B. Header-less host (e.g. GitHub Pages) — use the service-worker shim

GitHub Pages cannot set response headers, so use the bundled
**`coi-serviceworker.js`** (v0.1.7, MIT, gzuidhof/coi-serviceworker): a service
worker that re-serves same-origin responses with the COOP/COEP headers. Load it as
the **very first script** in `<head>`, before anything else:

```html
<script src="coi-serviceworker.js"></script>
```

Caveats (all inherent to the shim, documented so they aren't surprises):

- **First-load reload race.** On the first visit the SW installs, then reloads the
  page once so the reloaded response is isolated. `app.js`'s capability detection
  must therefore run *after* that reload — it already re-checks `crossOriginIsolated`
  at load, so the second load simply picks the threaded bundle.
- **No-SW environments** (some private/incognito modes, SW disabled) silently cannot
  isolate → `crossOriginIsolated` stays `false` → single-thread fallback. Correct by
  construction; just no speedup.
- Must be **same-origin** and the **first** script, or it won't intercept in time.

State which path a given deploy uses; do not use both.
