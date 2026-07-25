// Pure, DOM-free engine-selection + worker-count helpers for the threaded WASM bundle
// (PLAN-wasm-web-speedup.md §8.3 / §9.3). Kept in its own ES module so app.js imports these AND a
// node unit test (web/engine-select.test.mjs) can exercise the decision logic WITHOUT a browser —
// the load-time bundle switch (§8.3 case) and the N-clamp (§9.3) are the two behaviours a static
// review can verify here, since the real threading is browser-only (user-verified afterward).

// --- Async-search terminal-status codes -----------------------------------------------------------
// MUST mirror web/wasm_gameplay.cpp's WasmSearchStatus (pinned-decision C). An EXPLICIT status —
// not a bare int — because app.js otherwise reads a negative move as an Othello pass, so a fatal
// worker OOM collapsed into a negative move would become a false pass.
export const SEARCH_RUNNING   = 1;
export const SEARCH_OK        = 2;
export const SEARCH_CANCELLED = 3;
export const SEARCH_FATAL     = 4;

// --- Clamp constants (mirror the C++ inline constexprs; JS/shell cannot read a C++ constexpr) -----
// Pool ceiling — MUST match core/board_search.h kMctsPoolCeiling AND build-wasm.sh's
// PTHREAD_POOL_SIZE literal. A conservative physical-core proxy for typical clients (F3: SMT past
// the physical count is flat, so more workers only add the virtual-loss haircut for no speedup).
export const POOL_CEILING = 8;
// Minimum per-worker sim share — MUST match core/board_search.h kMinSimsPerWorker. PROVISIONAL 400
// (the one validated sims/worker point from the P2 single-point gate); the fuller §7.1 sweep is
// deferred. A small budget fanned across many workers drops T/N below any useful tree depth.
export const MIN_SIMS_PER_WORKER = 400;
// Fallback logical-core count when navigator.hardwareConcurrency is undefined — MUST match
// core/board_search.h kPoolFallbackCores AND build-wasm.sh's PTHREAD_POOL_SIZE `||4`. app.js uses it
// as the computeWorkerCount `cores` fallback so the per-move N matches the pool the build actually
// pre-spawned on a host that hides its core count (otherwise N=1 forfeits the threaded speedup).
export const POOL_FALLBACK_CORES = 4;

// reviewer-flagged (#8, rejected): "gate the threaded bundle behind an experimental opt-in until P5."
// The plan (§8.3/§9) defines the COI+SAB capability DETECTION here AS "the capability flag" the
// threaded bundle stays behind until the §10 ship gate — and the shipped demo is served WITHOUT
// COOP/COEP by default (web/index.html: the coi-serviceworker shim is a per-deploy opt-in), so a
// normal static host always gets the single-thread fallback bundle. Threading only activates where a
// host deliberately enables isolation (dev/CI), which is exactly the intended pre-P5 exercise surface;
// `?nothreads=1` is the escape hatch. An extra experimental opt-in would disable that intended
// dev/CI activation and is beyond the plan's spec, so not added.
//
// Decide which bundle to load at page-load (§8.3). The threaded bundle needs cross-origin isolation
// AND SharedArrayBuffer present AND no forced-fallback flag (set by a case-2/3 OOM reload). This is
// feature-detection FIRST, then fetch the chosen factory (§8.3). Note it is necessary but NOT
// sufficient: instantiation / pool-init can still fail WITH isolation present, which the caller
// recovers via try/catch — isolation does not imply threads work. This helper only makes the
// load-time choice; it never asserts the threaded bundle will run.
export function selectEngineBundle({ crossOriginIsolated, hasSharedArrayBuffer, forcedFallback } = {}) {
  const threaded = crossOriginIsolated === true &&
                   hasSharedArrayBuffer === true &&
                   !forcedFallback;
  return threaded ? "learnttt-threaded.js" : "learnttt.js";
}

// Per-move tree-parallel worker count N (§9.3, pinned-decision B). N = max(1, min(pool-1,
// floor(T / kMinSimsPerWorker))), rounded DOWN, clamped toward physical cores via POOL_CEILING.
//   * `totalSims`    — the move's sim budget T.
//   * `logicalCores` — navigator.hardwareConcurrency (logical; the ceiling clamps toward physical).
//   * `override`     — advanced UI / `?mcts-threads=` benchmarking override; when >=1 it forces N,
//                      still clamped to the pool cap (never above pool-1) so it cannot deadlock.
// The build-time pool is min(POOL_CEILING, cores)+1, so the per-move cap (pool-1) is
// min(POOL_CEILING, cores). Rounding DOWN is load-bearing: rounding up would pick an N whose share
// T/N falls BELOW the MIN_SIMS_PER_WORKER=400 floor (e.g. T=1000: floor(2.5)=2 -> 500/worker >= 400,
// but ceil(2.5)=3 -> 333/worker < 400).
export function computeWorkerCount(totalSims, logicalCores, override) {
  const cores = Math.max(1, Math.floor(Number(logicalCores) || 1));
  const poolCap = Math.min(POOL_CEILING, cores);              // = pool - 1
  if (override != null && Number.isFinite(Number(override)) && Number(override) >= 1) {
    return Math.max(1, Math.min(Math.floor(Number(override)), poolCap));
  }
  const byBudget = Math.floor((Number(totalSims) || 0) / MIN_SIMS_PER_WORKER);  // round DOWN
  return Math.max(1, Math.min(poolCap, byBudget));
}
