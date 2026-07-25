// Pure, DOM-free helpers for the web-play demo controller (docs/PLAN-webui-demo-fbf243.md §5/§6.1).
//
// Everything here is side-effect-free and independent of `window`/`document`, so it is unit-testable in
// bare Node (web/demo-core.test.mjs) — mirroring the engine-select.js / engine-select.test.mjs split.
// The DOM/browser controller lives in web/demo.js and imports these.

// §6.1 — the ONE forward-compat seam this plan owns. `multiCore` is passed in (the demo derives it from
// the companion speedup plan's cross-origin-isolation signal, web/demo.js `deriveMultiCore`), so this
// helper stays pure and testable with multiCore true/false. A game opts into the threaded sim budget
// PURELY by the manifest declaring a numeric `simsThreaded`; the manifest omits it for models the
// threaded build does not accelerate (today TTT's NEAT net and the C4 AZ net), which then fall back to
// `sims`. Today's single, non-pthread build resolves multiCore to false everywhere, so `sims` is always
// chosen — the seam is inert but ready.
export function simCount(game, multiCore) {
  if (game && multiCore === true && Number.isFinite(game.simsThreaded)) return game.simsThreaded;
  return game ? game.sims : undefined;
}

// Last path segment of a manifest `model` path ("models/ttt.sav.zst" -> "ttt.sav.zst"). Used as the
// File name handed to loadSaveFile() (its zstd magic-byte path keys off the bytes, not the name, but a
// real basename keeps the game-info "saved from" line and any error message legible).
export function modelBasename(modelPath) {
  const parts = String(modelPath == null ? "" : modelPath).split("/");
  return parts[parts.length - 1] || "";
}

const kMatchupTypes = new Set(["human", "model", "heuristic"]);
// NEAT_POPULATION games — the only ones that carry a champion-member pin. Mirrors build-demo-bundle.sh
// --check's NEAT_GAMES so both validators agree on where a `neatMember` is allowed.
const kNeatGames = new Set(["ttt"]);
// `selector` is a fixed UI-mode enum, NOT a population size: 0 = Elo, 1 = Best by Playoff, 2 = Best vs
// Heuristic (app.js applyModelConfig / restorePlayerConfigFromStorage, which bounds it 0..2). A pin above
// this range would be silently coerced/rejected by the wasm, so reject it up front (mirrors the static
// checker in build-demo-bundle.sh --check).
const kSelectorMax = 2;

// Validate the demo manifest (§5) and return its games sorted by `order`. Throws an Error naming EVERY
// problem (not just the first) so a malformed/short manifest surfaces a clear message instead of the
// controller silently rendering an empty tab strip. Only the fields the controller actually consumes
// are required; `source` (the audit trail) is not read by the UI, so it is not validated here.
export function validateManifest(manifest) {
  const errs = [];
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("manifest is not a JSON object");
  }
  if (manifest.schemaVersion !== 1) {
    errs.push(`unsupported schemaVersion ${JSON.stringify(manifest.schemaVersion)} (expected 1)`);
  }
  const games = manifest.games;
  if (!Array.isArray(games) || games.length === 0) {
    // Nothing further to validate without a games array.
    errs.push("`games` must be a non-empty array");
    throw new Error("invalid demo manifest: " + errs.join("; "));
  }

  const seenIds = new Set();
  const seenOrders = new Set();
  const isPosInt = (v) => Number.isInteger(v) && v > 0;
  const winLengthGames = new Set(["ttt", "connect4", "gomoku"]); // games that USE win-length (§5)

  games.forEach((g, i) => {
    const where = `game[${i}]${g && typeof g.id === "string" ? ` (id=${g.id})` : ""}`;
    if (!g || typeof g !== "object") { errs.push(`${where}: not an object`); return; }
    if (typeof g.id !== "string" || g.id === "") errs.push(`${where}: missing string \`id\``);
    else if (seenIds.has(g.id)) errs.push(`${where}: duplicate \`id\` ${JSON.stringify(g.id)}`);
    else seenIds.add(g.id);
    if (typeof g.label !== "string" || g.label === "") errs.push(`${where}: missing string \`label\``);
    // `order` must be a positive integer with no duplicates — matches build-demo-bundle.sh --check
    // (is_int(order) && order>=1 + duplicate-order rejection), so a hand-edited manifest that skipped
    // --check can't get a fractional/duplicate order (ambiguous tab ordering) past this runtime gate.
    if (!(Number.isInteger(g.order) && g.order >= 1)) errs.push(`${where}: \`order\` must be a positive integer`);
    else if (seenOrders.has(g.order)) errs.push(`${where}: duplicate \`order\` ${g.order}`);
    else seenOrders.add(g.order);
    if (!Number.isInteger(g.gameType)) errs.push(`${where}: missing integer \`gameType\``);
    if (!isPosInt(g.boardWidth)) errs.push(`${where}: \`boardWidth\` must be a positive integer`);
    if (!isPosInt(g.boardHeight)) errs.push(`${where}: \`boardHeight\` must be a positive integer`);
    // winLength: required (present as a number) for the games that use it; 0/absent is fine otherwise.
    if (typeof g.id === "string" && winLengthGames.has(g.id)) {
      if (!isPosInt(g.winLength)) errs.push(`${where}: \`winLength\` must be a positive integer for ${g.id}`);
    } else if (g.winLength != null && !(Number.isInteger(g.winLength) && g.winLength >= 0)) {
      errs.push(`${where}: \`winLength\`, when present, must be a non-negative integer`);
    }
    if (typeof g.model !== "string" || g.model === "") errs.push(`${where}: missing string \`model\``);
    if (!(Number.isFinite(g.sims) && g.sims >= 0)) errs.push(`${where}: \`sims\` must be a non-negative number`);
    if (g.simsThreaded != null && !(Number.isFinite(g.simsThreaded) && g.simsThreaded >= 0)) {
      errs.push(`${where}: \`simsThreaded\`, when present, must be a non-negative number`);
    }
    if (g.heuristicPly != null && !isPosInt(g.heuristicPly)) {
      errs.push(`${where}: \`heuristicPly\`, when present, must be a positive integer`);
    }
    const m = g.defaultMatchup;
    if (!m || typeof m !== "object") errs.push(`${where}: missing \`defaultMatchup\` object`);
    else {
      if (!kMatchupTypes.has(m.p1)) errs.push(`${where}: \`defaultMatchup.p1\` must be human|model|heuristic`);
      if (!kMatchupTypes.has(m.p2)) errs.push(`${where}: \`defaultMatchup.p2\` must be human|model|heuristic`);
    }
    // neatMember: REQUIRED for a NEAT save, must be null otherwise (mirrors build-demo-bundle.sh --check).
    // Range-bound, not just type-check: `selector` is the 0..kSelectorMax UI-mode enum (0 = Elo, else a
    // best-selector slot; applyModelConfig) and `eloRank` is a 1-based rank (champion = rank 1). A pin
    // outside those ranges is nonsensical — applyModelConfig would reject/coerce it in the wasm while
    // demoApplyMatchup still reported success, seating the wrong (or no) member.
    const isNeat = typeof g.id === "string" && kNeatGames.has(g.id);
    if (isNeat) {
      // A NEAT save is useless without its champion pin: absent it, the controller falls back to the
      // localStorage-restored member and can seat a stale/non-champion net that still validates.
      const nm = g.neatMember;
      if (nm == null || typeof nm !== "object"
          || !(Number.isInteger(nm.selector) && nm.selector >= 0 && nm.selector <= kSelectorMax)
          || !(Number.isInteger(nm.eloRank) && nm.eloRank >= 1)) {
        errs.push(`${where}: \`neatMember\` {selector:int 0..${kSelectorMax}, eloRank:int>=1} required for a NEAT save`);
      }
    } else if (g.neatMember != null) {
      // A champion-member pin is meaningful ONLY for a NEAT save; on any other game applyMatchup ignores
      // it (isNeatSave() false), so reject it here too.
      errs.push(`${where}: \`neatMember\` must be null for a non-NEAT game (${g.id})`);
    }
    if (g.blurb != null && typeof g.blurb !== "string") errs.push(`${where}: \`blurb\`, when present, must be a string`);
  });

  if (errs.length) throw new Error("invalid demo manifest: " + errs.join("; "));

  // Stable sort by `order` (Array.prototype.sort is stable in modern engines; tie-break by input index
  // is implicit). Return a copy so callers can't mutate the manifest's array.
  return games.slice().sort((a, b) => a.order - b.order);
}
