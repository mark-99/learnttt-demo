// Web-play demo controller (docs/PLAN-webui-demo-fbf243.md §7 Phase 3).
//
// A THIN controller: it drives the existing app.js engine through the `window.__demo` seam (Phase 2) —
// it never forks play/render/load logic. In the dev app it self-gates OFF immediately (a small
// same-origin cached fetch of this module, no behavior change). Under `?demo=1` it:
//   1. fetches + validates demo/manifest.json, sorts games by `order`, injects a tab strip + `demo` body
//      class, and wraps the dev-only file pickers in a collapsed <details class="advanced">;
//   2. on tab click (and once for the default / ?game= tab) loads the bundled model through the shared
//      serializing load coordinator, cross-checks its game-type + board variant, applies the manifest
//      matchup, and starts a new game;
//   3. reconciles demo state when a manual Advanced load happens (learned via the coordinator's result
//      subscription) — a load this controller did NOT initiate.
//
// It couples to app.js only via window.__demo (loadModel / verifyModel / applyMatchup / onLoadResult /
// getModelMeta / ready) — the tiny locked seam.
import { simCount, validateManifest, modelBasename } from "./demo-core.js";

const params = new URLSearchParams(window.location.search);
const DEMO = params.get("demo") === "1";

// Manifest URL resolved against the document (page is web/index.html, manifest is web/demo/manifest.json).
// Model paths inside the manifest are `models/…` relative to the MANIFEST (§5), so they resolve via
// `new URL(game.model, MANIFEST_URL)` -> web/demo/models/… (not web/models/…).
const MANIFEST_URL = new URL("demo/manifest.json", window.location.href);

// Monotonic selection token: a fast tab switch bumps this so a superseded in-flight selection aborts
// its post-load steps (matchup/reset) instead of applying against a model a newer click already replaced.
// This is BELT-AND-SUSPENDERS over the app.js coordinator's own request token: the coordinator serializes
// the wasm writes and marks a superseded load `stale`; this guards the controller-side fetch + post-load
// work that happens outside a single loadModel() call.
let selectSeq = 0;

// The selectSeq value stamped when an Advanced file was picked (below). The Advanced-load reconciliation
// (subscribeToLoads) only takes over the UI while this still equals selectSeq — i.e. no NEWER tab click or
// Advanced pick has happened since. Without it, a slow Advanced load finishing AFTER a later tab click
// would cancel that newer tab selection (the older action wrongly winning). -1 = no Advanced pick yet.
let advancedSeq = -1;

// The bundled game id whose net the engine currently holds, or null when the engine holds a NON-bundled
// save (a custom Advanced load) or nothing valid. Set the moment a tab load's coordinator commit is
// confirmed (selectGame), cleared on an Advanced/custom load or an engine invalidation. A pre-load-failure
// reconcile uses this to identify the live net by IDENTITY, not by matching board variant alone — a custom
// save can share a bundled game's gameType + dimensions + winLength and would otherwise be mislabeled as
// the bundled tab.
let engineNetGameId = null;

// Minimal controller state, also surfaced on window for the §9 render/play harness to await/inspect.
// Not an app.js seam — it is the controller's OWN observable state (activeGameId, loading, lastError).
const state = { activeGameId: null, loading: false, lastError: null, lastSource: null };
window.__demoState = state;

let tabsEl = null;
let blurbEl = null;
let games = [];
let api = null;

async function runDemo() {
  document.body.classList.add("demo");
  api = window.__demo;
  if (!api || api.isDemo !== true) {
    throw new Error("window.__demo missing or not in demo mode — app.js demo seam did not initialize");
  }

  let manifest;
  try {
    const resp = await fetch(MANIFEST_URL);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    manifest = await resp.json();
  } catch (err) {
    throw new Error(`could not fetch ${MANIFEST_URL.pathname}: ${err && err.message ? err.message : err}`);
  }
  games = validateManifest(manifest); // throws a clear message on a malformed/short manifest (§5)

  buildTabStrip();
  wrapAdvancedPickers();
  subscribeToLoads();

  // Initial game: honor ?game=<id> if it names a real tab, else the first (lowest `order`) game.
  const wanted = params.get("game");
  const initial = games.find((g) => g.id === wanted) || games[0];
  selectGame(initial);
}

// ---- View construction -------------------------------------------------------------------------

function buildTabStrip() {
  const header = document.querySelector(".app header") || document.body;

  tabsEl = document.createElement("nav");
  tabsEl.className = "demo-tabs";
  tabsEl.setAttribute("aria-label", "Game");
  for (const g of games) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "demo-tab";
    btn.dataset.gameId = g.id;
    btn.textContent = g.label;
    btn.setAttribute("aria-current", "false");
    btn.addEventListener("click", () => selectGame(g));
    tabsEl.appendChild(btn);
  }
  header.appendChild(tabsEl);

  blurbEl = document.createElement("p");
  blurbEl.className = "demo-blurb";
  blurbEl.setAttribute("role", "status");
  blurbEl.setAttribute("aria-live", "polite");
  header.appendChild(blurbEl);
}

// Wrap the dev-only file pickers (Save file, Show-checkpoints, Sweep CSV — the whole .controls-files
// block) in a collapsed <details class="advanced">. Presentation ONLY: the inputs keep their existing
// app.js change handlers (moving a DOM node does not detach listeners), so the Advanced picker still
// loads a hand-picked save, and its Save-file handler already routes through the shared coordinator
// (Phase 2). Everything else about the pickers is untouched.
function wrapAdvancedPickers() {
  const controls = document.querySelector(".panel .controls-files");
  if (!controls || !controls.parentNode) {
    // The pickers keep their app.js handlers either way, so play still works — but surface the missing
    // node instead of failing silently, since it means the expected HTML structure changed (§7).
    console.warn("demo: `.panel .controls-files` not found — Advanced dev-tools disclosure not wrapped");
    return;
  }
  const details = document.createElement("details");
  details.className = "advanced";
  const summary = document.createElement("summary");
  summary.textContent = "Advanced (dev tools: load your own save / sweep CSV)";
  details.appendChild(summary);
  controls.parentNode.insertBefore(details, controls);
  details.appendChild(controls); // move the pickers inside; listeners survive the move

  // Cancel any in-flight tab selection the MOMENT the user commits to an Advanced file — synchronously, on
  // the change event, BEFORE app.js's async coordinated load resolves. Without this, a tab whose model is
  // still fetching when the user picks an Advanced file would (after its fetch resolves) enqueue its own
  // loadModel AFTER the advanced coordinator request, mark the advanced load stale, and wrongly win —
  // despite the Advanced pick being the LATER user action (§7). Bumping selectSeq makes the pending tab's
  // post-fetch `mySeq !== selectSeq` guard abort it; the onLoadResult subscription then reconciles the UI.
  const saveInput = document.getElementById("saveFile");
  if (saveInput) {
    saveInput.addEventListener("change", (e) => {
      // Record the bumped seq so the Advanced-load reconciliation can tell whether a NEWER user action
      // (tab click / another Advanced pick) has since superseded THIS pick — see subscribeToLoads.
      if (e.target.files && e.target.files.length) advancedSeq = ++selectSeq;
    });
  }
}

// ---- Tab selection (load -> cross-check -> matchup) ----------------------------------------------

async function selectGame(game) {
  const mySeq = ++selectSeq;
  state.loading = true;
  state.lastError = null;
  markActiveTab(game.id);
  setBlurb(`Loading ${game.label}…`, { kind: "loading" });

  // Wrap the whole post-setup body: an UNEXPECTED throw from any post-fetch step (loadModel/verifyModel/
  // applyMatchup or a DOM helper) must NOT escape as an unhandled rejection — that bypasses failSelect,
  // leaves state.loading pinned true, and strands the tab visually "Loading…". Route it through failSelect
  // like any other failure. The inner `return failSelect(...)` paths short-circuit as before (a return
  // through the try is not caught here); only a genuine throw reaches the catch.
  try {
    try {
      await api.ready;
    } catch (err) {
      return failSelect(mySeq, "Engine failed to load.");
    }
    if (mySeq !== selectSeq) return; // superseded while awaiting the engine

    // Fetch the bundled model bytes (resolved against the manifest, §5), wrap in a File, and hand the
    // COMPRESSED bytes straight to the reused loadSaveFile() (it zstd-decompresses via its magic-byte path).
    let file;
    try {
      const url = new URL(game.model, MANIFEST_URL);
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const buf = await resp.arrayBuffer();
      // Omitting lastModified makes the File constructor default it to Date.now(), which
      // refreshModelSummary() would then render as the model's "saved <time>" — falsely dating every
      // bundled net to page-load time. There is no true save time available client-side, so pin it to 0
      // (falsy) so the summary shows "saved unknown time" rather than a misleading now-stamp.
      file = new File([buf], modelBasename(game.model), { lastModified: 0 });
    } catch (err) {
      return failSelect(mySeq, `Could not fetch model: ${err && err.message ? err.message : err}`);
    }
    if (mySeq !== selectSeq) return; // a newer tab click superseded us during the fetch

    // Reflect the target game in the URL BEFORE the load that could trip the threaded fixed-heap
    // fallback's full-page reload (app.js): on that reload runDemo() re-reads ?game=, so it must already
    // name THIS game — otherwise the reload silently retries the previous tab and the user's click is lost.
    updateGameParam(game.id);

    // Load through the shared serializing coordinator (source:'tab'). It awaits arrayBuffer()/decompression
    // + the wasm write under one token, so overlapping loads can't clobber each other; a superseded load
    // resolves {stale:true} and we abort WITHOUT applying a matchup/reset (§7).
    const result = await api.loadModel(file);
    if (result && result.stale) {
      // A stale result has two causes. (a) A NEWER controller selection (tab click / Advanced pick) bumped
      // selectSeq — that selection owns the UI, so just abort. (b) loadSaveFile's OWN move-generation guard
      // tripped (an MvM autoplay tick / board click / New Game / player-setting flip during the fetch+zstd
      // decompress) with NO newer selectGame — then mySeq===selectSeq and NOTHING else settles this tab,
      // stranding it "Loading…". In demo mode EVERY coordinator-token supersession comes from a selectGame
      // or Advanced pick (both bump selectSeq), so case (b) is ALWAYS loadSaveFile's pre-wasm-write guard —
      // the prior model is still live and play still valid, so keep it (modelLost:false) and re-derive the
      // highlighted tab from the engine rather than stranding the UI.
      if (mySeq !== selectSeq) return;
      return failSelect(mySeq, `Loading ${game.label} was interrupted; keeping the current model.`);
    }
    if (mySeq !== selectSeq) return;          // controller-side supersession
    if (!result || result.ok !== true) {
      // The coordinator already invalidated play + entered the no-save state (demo mode) and fired the
      // subscription. Surface the message; do NOT fall through to matchup/reset against the prior model.
      return failSelect(mySeq, result && result.error ? result.error : "Model failed to load.", { modelLost: true });
    }

    // Game-type + board-variant cross-check via the seam (§5). A load can succeed yet be the WRONG net
    // (mis-curation); on a mismatch the seam invalidates the load and disables play.
    const verify = api.verifyModel({
      gameType: game.gameType,
      boardWidth: game.boardWidth,
      boardHeight: game.boardHeight,
      winLength: game.winLength,
    });
    if (!verify || verify.ok !== true) {
      const detail = verify && Array.isArray(verify.mismatch) ? verify.mismatch.join(", ") : "unknown";
      return failSelect(mySeq, `Bundled ${game.label} model does not match its expected variant (${detail}).`, { modelLost: true });
    }

    // Apply the manifest matchup AFTER the validated load so it wins over the localStorage restore (§2
    // ordering hazard). simCount picks the threaded budget only on a multi-core build (inert today, §6.1).
    const matchup = {
      p1: game.defaultMatchup.p1,
      p2: game.defaultMatchup.p2,
      sims: simCount(game, deriveMultiCore()),
    };
    if (Number.isFinite(game.heuristicPly)) matchup.ply = game.heuristicPly;
    if (game.neatMember) matchup.neatMember = game.neatMember; // NEAT champion-member pin (TTT)
    const applied = api.applyMatchup(matchup); // sets playerConfig, refreshes controls, starts a new game
    if (!applied || applied.ok !== true) {
      return failSelect(mySeq, "Could not apply the game matchup.", { modelLost: true });
    }

    // Record load provenance only NOW — once the bundled net is committed AND fully configured (verified +
    // matchup applied). Earlier (at commit) is unsafe: a load that commits its net but is then superseded
    // at the `mySeq !== selectSeq` check above returns BEFORE verify/matchup, so recording its id at commit
    // would let a later pre-load-failure reconcile relight that tab for a net whose matchup (player config,
    // sims, TTT champion pin) was never applied — describing a game the engine isn't actually set up for
    // (finding #1). loadModel resolving through applyMatchup has no await, so mySeq===selectSeq still holds:
    // a superseded load never reaches here. reconcileActiveFromEngine then identifies the engine's net by
    // IDENTITY (not variant alone), so a custom save sharing a bundled variant can't be mislabeled.
    engineNetGameId = game.id;

    // reviewer-flagged (redundant seq-check — applyMatchup is synchronous, so selectSeq cannot advance
    // between the post-load check above and here): KEPT as belt-and-suspenders, matching this controller's
    // guard-after-every-step style, so inserting any future async step before the commit stays safe.
    if (mySeq !== selectSeq) return;
    state.loading = false;
    state.lastError = null;
    state.activeGameId = game.id;
    state.lastSource = "tab";
    markActiveTab(game.id);
    setBlurb(game.blurb || "", { kind: "blurb" });
    updateGameParam(game.id);
  } catch (err) {
    // Model treated as lost: a partially-applied load/verify/matchup leaves no guaranteed-live model.
    return failSelect(mySeq, `Failed to load ${game.label}: ${err && err.message ? err.message : err}`, { modelLost: true });
  }
}

function failSelect(mySeq, message, { modelLost = false } = {}) {
  if (mySeq !== selectSeq) return; // a newer selection owns the UI now; don't stomp its state
  state.loading = false;
  state.lastError = message;
  if (modelLost) {
    // No guaranteed-live model. For a load/verify failure the coordinator/seam ALREADY entered the no-save
    // state (play disabled). But an UNEXPECTED throw AFTER a successful load — e.g. applyMatchup throwing
    // partway, reaching selectGame's catch — leaves the net loaded and play ENABLED, because the coordinator
    // never ran on that success. So actively disable the engine here via the seam rather than ASSUME it was;
    // enterNoSaveState is idempotent, so re-calling it when play is already disabled is harmless. Then clear
    // the engine-net marker + active-game highlight so a tab can never claim a model that's gone.
    try { api.invalidate?.(message); } catch (e) { /* seam missing/failed — UI state below still clears */ }
    engineNetGameId = null;
    state.activeGameId = null;
    markActiveTab(null);
  } else {
    // A PRE-load failure (engine unavailable / THIS selection's model fetch failed) never touched the
    // engine via this selection, so the demo deliberately keeps whatever model is live (app.js §2). But a
    // sibling tab load that started earlier can have replaced the live net while we were fetching — its
    // wasm write is committed and not cancellable, so selectSeq supersession can't roll it back. Re-derive
    // the highlight from the net the engine ACTUALLY holds rather than blindly re-lighting the previously
    // active game: otherwise the tab could falsely name a model a concurrent load already swapped out. In
    // the common (no concurrent load) case this resolves right back to the prior game, unchanged.
    const liveId = reconcileActiveFromEngine();
    markActiveTab(liveId);
    // selectGame advances ?game= to the REQUESTED game before the load (so a threaded-heap fallback reload
    // re-reads the right tab). On a kept-current failure the engine still holds the previous model, so
    // re-point the URL at what is ACTUALLY live — otherwise a reload or shared link opens a different game
    // than the board shows (finding #3). Only when we resolved a live bundled tab; a null (custom/none)
    // live net has no tab id to name, so leave the URL untouched.
    if (liveId) updateGameParam(liveId);
  }
  setBlurb(message, { kind: "error" });
}

// ---- Advanced-load reconciliation (a load THIS controller did not initiate) ----------------------

function subscribeToLoads() {
  api.onLoadResult(({ source, result }) => {
    // Tab loads are handled inline by selectGame (awaited). The ?save= URL autoload is skipped in demo
    // mode. So the only loads to reconcile here are MANUAL Advanced-picker loads (§7 step 4).
    if (source !== "advanced") return;
    if (result && result.stale) return; // superseded advanced load — nothing to reconcile
    // A NON-stale Advanced result means the coordinator TOUCHED the engine: it committed a CUSTOM (non-
    // bundled) net, or a failure invalidated the loaded net. Either way the engine no longer holds the
    // previously-known bundled net, so clear the identity marker NOW — BEFORE the supersession bail below.
    // If a newer tab click has already superseded this reconcile and then fails pre-load, its reconcile
    // must not relight a bundled tab for the custom net when their variants happen to coincide (finding
    // #2). A later successful tab load re-sets engineNetGameId once its own matchup is applied.
    engineNetGameId = null;
    // Only reconcile the UI if THIS Advanced load is still the latest user action. A tab click (or another
    // Advanced pick) after this load was initiated bumps selectSeq past advancedSeq; that newer selection
    // owns the UI, so bailing here avoids the older Advanced load cancelling it (its own post-fetch
    // `mySeq !== selectSeq` guard / coordinator ordering already lets the newer selection win).
    if (selectSeq !== advancedSeq) return;
    // The hand-picked net matches no tab: clear the active-tab marker + blurb. On a FAILURE the load may
    // have wiped the prior model (wasm_load.cpp:25) and the coordinator already disabled play — leaving a
    // tab "active" would falsely claim a model that is gone, so clear it in both cases.
    // reviewer-flagged (#4 dead/no-op re-increment): this bump cancels NOTHING today — reaching here means
    // selectSeq===advancedSeq, and no in-flight selectGame can hold mySeq===advancedSeq (advancedSeq came
    // from the pick's own ++selectSeq, a distinct increment from any selectGame's ++selectSeq). KEPT as a
    // defensive belt-and-suspenders bump (matching this file's guard-after-every-step style) so a future
    // async step that DID leave a same-seq selection in flight would still be superseded here.
    selectSeq++;
    state.activeGameId = null;
    state.loading = false;
    markActiveTab(null);
    if (result && result.ok === true) {
      state.lastError = null;
      state.lastSource = "advanced";
      setBlurb("Loaded a hand-picked save via Advanced (no game tab).", { kind: "blurb" });
    } else {
      state.lastError = (result && result.error) || "Advanced load failed.";
      state.lastSource = "advanced";
      setBlurb(state.lastError, { kind: "error" });
    }
  });
}

// ---- Small DOM/state helpers ---------------------------------------------------------------------

function markActiveTab(gameId) {
  if (!tabsEl) return;
  for (const btn of tabsEl.querySelectorAll(".demo-tab")) {
    const on = btn.dataset.gameId === gameId;
    btn.classList.toggle("active", on);
    btn.setAttribute("aria-current", on ? "page" : "false");
  }
}

// Re-derive which tab reflects the net the ENGINE actually holds right now, via the getModelMeta seam,
// and record it on state.activeGameId. Used on a PRE-load failure: this selection's own load never touched
// the engine, but a sibling tab load that started earlier can still have replaced the live net while we
// were fetching (its wasm write is committed inside the coordinator and isn't cancellable, so bumping
// selectSeq can't undo it). Reading ground truth keeps the highlighted tab honest instead of assuming the
// previously-active game is still loaded. In the common (no concurrent load) case this resolves straight
// back to the prior game, preserving the "keep the old model on a pre-load failure" behavior. Returns the
// matching game id (or null when the loaded net matches no tab / nothing is loaded).
function reconcileActiveFromEngine() {
  let meta = null;
  try { meta = typeof api?.getModelMeta === "function" ? api.getModelMeta() : null; } catch (e) { meta = null; }
  if (!meta || meta.loaded !== true) { state.activeGameId = null; return null; }
  // Identify by IDENTITY, not variant alone. A custom Advanced save can share a bundled game's gameType +
  // board dimensions (+ winLength); matching on those would mislabel it as the bundled tab. engineNetGameId
  // is set ONLY when a tab load is FULLY configured (net committed + verified + matchup applied), and
  // cleared to null on an Advanced/custom load or an engine invalidation — so a net that committed but was
  // superseded before its matchup ran is NOT claimed here. Trust it, then cross-check that the engine's
  // ACTUAL variant still matches that game (defense against a stale marker) before lighting the tab.
  const g = engineNetGameId ? games.find((x) => x.id === engineNetGameId) : null;
  const match = g &&
    g.gameType === meta.gameType &&
    g.boardWidth === meta.boardWidth &&
    g.boardHeight === meta.boardHeight &&
    (!(g.winLength > 0) || g.winLength === meta.winLength) ? g : null;
  state.activeGameId = match ? match.id : null;
  return state.activeGameId;
}

function setBlurb(text, { kind } = {}) {
  if (!blurbEl) return;
  blurbEl.textContent = text || "";
  blurbEl.classList.toggle("error", kind === "error");
  blurbEl.classList.toggle("loading", kind === "loading");
}

// Reflect the active game in the URL (?game=<id>) so it is copy/paste- and bookmark-stable. Always
// replaceState (never pushState): the controller has no popstate handler, so pushing per-tab history
// entries would make Back change the URL without changing the board — a mismatch. replaceState keeps the
// URL truthful without that broken history.
function updateGameParam(gameId) {
  try {
    const url = new URL(window.location.href);
    url.searchParams.set("demo", "1");
    url.searchParams.set("game", gameId);
    window.history.replaceState({ game: gameId }, "", url);
  } catch (e) { /* history API unavailable — non-fatal, the demo still works */ }
}

function showFatal(message) {
  try {
    const el = document.getElementById("error");
    if (el) el.textContent = message;
    if (blurbEl) setBlurb(message, { kind: "error" });
  } catch (e) { /* nothing more we can do */ }
}

// §6.1 — derive the ONE `multiCore` boolean. The companion speedup plan publishes cross-origin isolation
// as the demo-visible primitive; its threaded (SharedArrayBuffer) bundle can only load WHEN the document
// is cross-origin-isolated, so `self.crossOriginIsolated === true` is a NECESSARY isolation signal — but
// not sufficient: `?nothreads=1`, an OOM single-thread fallback, or a timed-out/failed threaded init all
// leave an isolated page running the single-thread engine. Applying `simsThreaded` to a single-thread
// engine only makes moves slower, so ALSO require that the threaded engine actually loaded
// (api.usingThreadedEngine()). Today the demo is served WITHOUT COOP/COEP headers, so crossOriginIsolated
// is false everywhere (short-circuiting before the seam call) and simCount always returns the single-
// thread `sims`. When the companion's threaded build + an isolated host land, BOTH become true and the
// per-model `simsThreaded` budgets engage.
function deriveMultiCore() {
  return typeof self !== "undefined"
      && self.crossOriginIsolated === true
      && typeof api?.usingThreadedEngine === "function"
      && api.usingThreadedEngine() === true;
}

// ---- Entry point (kept LAST so runDemo() sees the module-scope const/let above, not their TDZ) --------
// Self-gate: in the dev app (no ?demo=1) do nothing at all. This module is ALWAYS referenced by
// index.html (§7) so app.js never injects <script> tags (keeping the §9 same-origin assertion clean),
// but its whole behavior is demo-only.
if (DEMO) {
  runDemo().catch((err) => {
    // Any unexpected failure in setup must surface visibly, not vanish — the visitor should see why the
    // showcase failed to come up rather than a blank page.
    console.error("demo controller failed:", err);
    showFatal(`Demo failed to start: ${err && err.message ? err.message : err}`);
  });
}
