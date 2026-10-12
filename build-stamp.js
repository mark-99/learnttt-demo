// Build stamp (git sha + UTC build time) shown in the page footer so a visitor can tell which deploy
// they have loaded. scripts/write-build-stamp.sh writes web/build-stamp.json at build time; both
// build-wasm.sh and scripts/build-demo-bundle.sh call it. DOM-free apart from the optional `el` argument,
// so web/build-stamp.test.mjs runs it in bare Node.

export const kUnknownStampText = "build unknown";

// {sha, builtAt} -> "build 8eb3fab · 2026-10-12 14:03 UTC". Anything malformed gives the unknown text.
export function formatBuildStamp(stamp) {
  const sha = stamp && typeof stamp.sha === "string" ? stamp.sha.trim() : "";
  const m = stamp && typeof stamp.builtAt === "string"
    ? /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(stamp.builtAt) : null;
  if (!sha || !m) return kUnknownStampText;
  return `build ${sha} · ${m[1]} ${m[2]} UTC`;
}

// Fetch the stamp with cache: "no-store" so a cached copy can never pair an old stamp with a new page,
// write the text into `el` (if given) and resolve to {sha, builtAt, text}. Never rejects: a missing or
// bad stamp file gives {sha: null, builtAt: null, text: "build unknown"}.
export async function loadBuildStamp(el, fetchFn = globalThis.fetch) {
  let stamp = null;
  try {
    const res = await fetchFn("build-stamp.json", { cache: "no-store" });
    if (res.ok) stamp = await res.json();
  } catch { /* missing file or bad JSON: fall through to "build unknown" */ }
  const text = formatBuildStamp(stamp);
  const known = text !== kUnknownStampText;
  const result = { sha: known ? stamp.sha : null, builtAt: known ? stamp.builtAt : null, text };
  if (el) el.textContent = text;
  return result;
}
