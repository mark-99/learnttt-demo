import {
  selectEngineBundle,
  computeWorkerCount,
  POOL_CEILING,
  POOL_FALLBACK_CORES,
  SEARCH_RUNNING,
  SEARCH_OK,
  SEARCH_CANCELLED,
  SEARCH_FATAL,
} from "./engine-select.js";

let ModulePromise = null;
let Module = null;

// --- Threaded-engine wiring (PLAN §8.3/§9) ---
// True once the pthreads/SharedArrayBuffer bundle instantiated successfully. When false the app is
// on the single-thread fallback bundle (identical moves, just slower) and every move takes the
// synchronous wasm_select_move path — no async orchestration, no pool, no cancel flag.
let usingThreadedEngine = false;
// Advanced per-move worker-count override (`?mcts-threads=N`) for benchmarking; null = auto (§9.3).
let mctsThreadOverride = null;
// Snapshot of the runtime engine capabilities, filled by createEngineModule() once the bundle is
// chosen and rendered into the #capabilities status line — a user-visible indicator of whether the
// multi-threaded engine is active (and why not, when single-thread). Purely informational.
let engineCapabilities = null;
// Promise of the in-flight threaded search (start/poll), or null when idle. cancelAndQuiesceSearch()
// awaits it so a save-swap / new-game / config-change never mutates gState under a live worker
// (the use-after-free barrier is Promise-resolution, PLAN §9.4).
let activeSearch = null;
// Monotonic cancel epoch, bumped by cancelAndQuiesceSearch() the instant it decides to cancel a
// live search — BEFORE it awaits quiescence. makeMoveForPlayer / playHeadlessGame snapshot it
// before their search await and DISCARD an otherwise-OK result whose epoch advanced. This closes
// the window where the coordinator publishes SEARCH_OK in the microtask just before the cancel
// flag flips: moveGeneration alone can't catch it because mutation callers bump moveGeneration
// only AFTER quiescence, not before the await (§9.4). Kept separate from moveGeneration so the
// quiesce's own invalidation never poisons callers (e.g. the sweep-CSV loader) that use
// moveGeneration to detect an unrelated save-load across their await.
let searchCancelEpoch = 0;
// Depth-counted lock so an in-flight threaded search disables board/config-mutating controls
// (§9.4 "simplest safe form"); the sync fallback blocks the main thread so it needs no lock.
let searchLockDepth = 0;
// sessionStorage key: a case-(2)/(3) fixed-heap OOM sets it, then reloads into the growable
// non-threaded bundle which reads it and skips the threaded upgrade (PLAN §8.3).
const kForceFallbackKey = "learntttForceFallback";
// forceFallbackReload's private-mode (sessionStorage-unavailable) OOM carry pins the fallback with
// ?nothreads=oom — a DISTINCT value from the user escape hatch ?nothreads=1 (engine-select.js) so the
// post-load strip clears only the transient OOM carry and never the sticky user opt-in. Both values
// force the single-thread bundle (isFallbackForced honours each).
const kNoThreadsOomValue = "oom";
// Ceiling (ms) on threaded-engine instantiation before we abandon it for the single-thread fallback.
// emcc 3.1.58's pthread runtime routes a worker load/MIME failure to worker.onerror WITHOUT rejecting
// the module-ready Promise, so instantiateEngineFactory() can HANG forever instead of throwing — and
// the catch-driven fallback (createEngineModule) would never fire, leaving the demo stuck on init.
// This timeout makes that fallback fire regardless. It is a ceiling, not an expected duration: a
// healthy init settles in well under a second (PLAN §9.3 — the wasm compile is paid once).
const kThreadedInitTimeoutMs = 20000;

// --- Demo mode (docs/PLAN-webui-demo-fbf243.md §7 Phase 2) ---
// `?demo=1` turns index.html into the stand-alone showcase: demo.js injects the tab strip and drives
// the engine through window.__demo (assembled in init()). Two dev-app behaviors are gated OFF in demo
// mode — the `../saves/` sweep-CSV auto-load and the `?save=` URL autoload (the demo controls loading
// itself) — and every localStorage player-config key is namespaced so a demo session neither inherits
// nor writes the dev app's shared prefs.
const demoMode = new URLSearchParams(window.location.search).get("demo") === "1";
// ONE mode-aware localStorage key helper, applied to EVERY read AND write (§2). Namespacing only the
// P{1,2}* loop is insufficient: learntttAutoDelay/learntttGraphMode are written directly elsewhere, and
// restorePlayerConfigFromStorage() also migrates-then-deletes legacy keys. In demo mode every key is
// prefixed and the legacy migration is disabled, so the showcase can't mutate the dev app's storage.
const kDemoStoragePrefix = "learntttDemo_";
// reviewer-flagged (#10 "double-prefixed keys read noisily, e.g. learntttDemo_learntttP1Type"), NOT
// taken: purely cosmetic (the finding agrees). Shortening the prefix or renaming the keys would change
// the persisted localStorage key names, silently orphaning every returning demo visitor's saved
// settings — real churn/risk for a DevTools-readability nicety, so keep the stable keys.
function lsKey(key) { return demoMode ? kDemoStoragePrefix + key : key; }

// --- DOM elements ---
const saveInput = document.getElementById("saveFile");
const showCheckpointsToggle = document.getElementById("showCheckpoints");
const newGameButton = document.getElementById("newGame");
const undoButton = document.getElementById("undoMove");
const gameInfo = document.getElementById("gameInfo");
const modelInfo = document.getElementById("modelInfo");
const trainingParamsEl = document.getElementById("trainingParams");
const playInfo = document.getElementById("playInfo");
const statusLine = document.getElementById("status");
const scoreLine = document.getElementById("score");
const errorLine = document.getElementById("error");
const boardEl = document.getElementById("board");
const graphCanvas = document.getElementById("graphCanvas");
const graphStats = document.getElementById("graphStats");
const graphModeSelect = document.getElementById("graphMode");
const graphMinWeight = document.getElementById("graphMinWeight");
const graphMinWeightValue = document.getElementById("graphMinWeightValue");
const graphShowDisabled = document.getElementById("graphShowDisabled");
const othelloScoreBars = document.getElementById("othelloScoreBars");
const sweepFileInput = document.getElementById("sweepFile");
const sweepInfoEl = document.getElementById("sweepInfo");
const graphPlayerSelect = document.getElementById("graphPlayerSelect");
const autoplayControlsEl = document.getElementById("autoplayControls");
const autoPlayBtn = document.getElementById("autoPlayBtn");
const autoPauseBtn = document.getElementById("autoPauseBtn");
const autoStepBtn = document.getElementById("autoStepBtn");
const speedSlider = document.getElementById("speedSlider");
const speedLabel = document.getElementById("speedLabel");
const batchCountInput = document.getElementById("batchCount");
const batchBtn = document.getElementById("batchBtn");
const batchShowGames = document.getElementById("batchShowGames");
const batchScoreEl = document.getElementById("batchScore");
const swapSidesBtn = document.getElementById("swapSides");
const statusHistoryEl = document.getElementById("statusHistory");
const transcriptTextEl = document.getElementById("transcriptText");
const copyTranscriptBtn = document.getElementById("copyTranscriptBtn");
const downloadTranscriptBtn = document.getElementById("downloadTranscriptBtn");

// --- State ---
let board = [];
let cells = [];
let width = 0;
let height = 0;
let winLength = 0;
let gameType = 0;
let boardPtr = 0;
let boardSize = 0;
let loaded = false;
let turn = 1;
let gameOver = false;
let winningCells = [];
let moveHistory = [];
let sweepData = null;
let othelloLegalMoves = new Map();
let othelloIllegalMoveFallbacks = 0;

// Per-player configuration
let playerConfig = {
  1: { type: "human", sims: 25600, selector: 0, eloRank: 1, ply: 2 },
  2: { type: "model", sims: 25600, selector: 0, eloRank: 1, ply: 2 },
};

// WASM model config cache — avoids redundant rebuilds per move
let lastAppliedConfig = { selector: -1, eloRank: -1, player: -1 };

// Scheduler generation ID — prevents stale timer callbacks
let moveGeneration = 0;

// Thinking indicator state
let thinkingStart = 0;
// Rolling history of recent status messages (newest last). Shown above the current status line so a
// fast player's move doesn't instantly scroll the previous message away (persistent, not timer-wiped).
const kStatusHistoryLen = 3;
let statusHistory = [];

// Auto-play state
let autoPlay = {
  running: false,
  delay: 500,
  timerId: null,
  batchMode: false,
  batchVisual: false,
  batchTotal: 0,
  batchPlayed: 0,
  score: { p1: 0, draws: 0, p2: 0 },
};

// Graph state
let graphNodes = [];
let graphConnections = [];
let graphMaxAbsWeight = 0;
let graphRenderQueued = false;
let graphMode = "topology";
let graphTopologyStatsText = "No model loaded.";
let graphActivationSnapshots = { 1: [], 2: [] };
let graphActivationIndexByNodeId = new Map();
let graphLayoutCache = null;
let graphTooltipEl = null;
let graphViewPlayer = 0; // 0=auto (last model that moved), 1=P1, 2=P2
let lastModelMovePlayer = null; // tracks which model moved last

// Saved elo ranks per player when switching away from Elo selector
let savedEloRank = { 1: 1, 2: 1 };

// Max elo rank from loaded population
let maxEloRank = 1;

// Training mode string from loaded save
let trainingMode = "";
// Whether the loaded save is an ALPHAZERO_CNN net (read once at load via the direct wasm_is_cnn export,
// wasm_load.cpp:947). A CNN save's trainingMode is "ALPHAZERO_CNN", which the old string test missed —
// so it read as NEAT and the UI wrongly exposed the NEAT model-selector / Elo controls. Classify CNN as
// fixed-topology GLOBALLY (§2), by this cached bool rather than string-matching trainingMode.
let isCnnModel = false;

// --- Transcript panel state ---
const kMaxBatchTranscriptGames = 1000;      // cap recorded batch games (bounds memory/DOM)
const kBatchTranscriptRefreshInterval = 25; // headless batch: refresh panel every N games
let batchTranscripts = [];     // recorded per-game records accumulated during a batch run
let batchOmittedGames = 0;     // games played beyond the cap (disclosed in the output)
// True while the panel shows accumulated batch results instead of the current live
// game. Set in startBatch(); reset by any fresh interactive activity (new game,
// human move, load, swap, watch/step). Persists after a batch ends so the user can
// still copy/download the results.
let viewingBatch = false;

// WASM game constants
let GAME_TTT = 1;
let GAME_C4 = 2;
let GAME_OTH = 3;
let GAME_HEX = 4;
let GAME_GOMOKU = 5;
let OTH_PASS_MOVE = 64;

function refreshWasmConstants() {
  if (!Module) return;
  try {
    if (typeof Module._wasm_const_game_ttt === "function") {
      GAME_TTT = Module._wasm_const_game_ttt();
      GAME_C4 = Module._wasm_const_game_c4();
      GAME_OTH = Module._wasm_const_game_oth();
      if (typeof Module._wasm_const_game_hex === "function") {
        GAME_HEX = Module._wasm_const_game_hex();
      }
      if (typeof Module._wasm_const_game_gomoku === "function") {
        GAME_GOMOKU = Module._wasm_const_game_gomoku();
      }
      GAME_CONFIG = buildGameConfig();
    }
    if (typeof Module._wasm_const_othello_pass_move === "function") {
      OTH_PASS_MOVE = Module._wasm_const_othello_pass_move();
    }
  } catch (err) {
    console.warn("refreshWasmConstants failed:", err);
  }
}

// --- Game configuration ---
const TTT_SIMS_OPTIONS = [0, 25, 50, 100, 250];
const C4_SIMS_OPTIONS = [0, 50, 100, 200, 400, 800, 1600, 3200, 6400, 12800, 25600, 51200, 204800];
const OTHELLO_SIMS_OPTIONS = [0, 50, 100, 200, 400, 800, 1600, 3200, 6400, 12800, 25600, 51200, 204800];
const HEX_SIMS_OPTIONS = [0, 50, 100, 200, 400, 800, 1600, 3200, 6400, 12800, 25600, 51200, 204800];
const GOMOKU_SIMS_OPTIONS = [0, 50, 100, 200, 400, 800, 1600, 3200, 6400, 12800, 25600, 51200];

// Bump on EVERY change to a game's `defaultSims` below. Each bump clears the stored
// per-player `learntttP{p}Sims` override once (restorePlayerConfigFromStorage) so
// returning users pick up the new default instead of pinning the old one; all other
// stored keys are left untouched. Version 1 = Phase 0 interactive-latency cut.
// Version 2 = getDefaultModelSims now CAPS a CNN/AZ net's stored play-sims at the per-game
// interactive default (P0's 12800 for Othello was being overridden by the net's 25600 play-sims).
// Version 3 = Othello default 12800 -> 6400; also clears a manually-selected 25600 that persisted
// per-player at v2 (a stored learntttP{p}Sims overrides the computed default until this bump).
// Version 4 = clear stale stored sims again after fixing setSelectNumericOptions (it used to PRESERVE
// a stale dropdown value over the restored/default sims, so a pre-load 25600 / v2's 12800 stuck).
const SIMS_DEFAULTS_VERSION = 4;
const HEURISTIC_PLY_OPTIONS = [1, 2, 3, 4, 5, 6];
const C4_HEURISTIC_PLY_OPTIONS = [6, 8, 10, 11, 12, 13];
// reviewer-flagged (cap at ply 6 or add a latency tooltip for ply 7-8): rejected
// — consistent with C4_HEURISTIC_PLY_OPTIONS, which already exposes alpha-beta
// ply up to 13 with no warning. Ply is a user-selected interactive option; the
// established convention here is to expose the full range unguarded.
// Curated NEGAMAX-lookahead tiers for the Othello heuristic opponent (single-threaded alpha-beta —
// the 8-worker pool is MCTS-only, it does NOT speed this up). In real play (temp=0, one pruned search)
// these are fast: ply 10 is <1s, ply 12 is the ~2-3s "thinking" tier. All even (parity effect: even
// depths play better). ply 14+ omitted — it can spike; add it if 12 still feels too fast.
// getHeuristicPlyOptions() auto-includes the loaded net's own default ply (play_lookahead, e.g. 4).
const OTHELLO_HEURISTIC_PLY_OPTIONS = [6, 8, 10, 12];
const HEX_HEURISTIC_PLY_OPTIONS = [1, 2, 3];

function buildGameConfig() {
  return {
    [GAME_TTT]: {
      name: "Tic-Tac-Toe",
      simsOptions: TTT_SIMS_OPTIONS,
      defaultSims: 100,
      cssClass: "ttt",
      sideLabels: { 1: "First (X)", 2: "Second (O)" },
      pieceText: { 1: "X", 2: "O" },
      rulesLabel: (wl) => `win ${wl}`,
      supportsHeuristic: false,
      supportsBestVsHeuristic: true,
    },
    [GAME_C4]: {
      name: "Connect 4",
      simsOptions: C4_SIMS_OPTIONS,
      defaultSims: 12800,  // Phase 0: lowered from 25600 for faster interactive play (slider retains max)
      defaultHeuristicPly: 6,
      heuristicPlyOptions: C4_HEURISTIC_PLY_OPTIONS,
      cssClass: "c4",
      sideLabels: { 1: "First (Red)", 2: "Second (Yellow)" },
      rulesLabel: (wl) => `win ${wl}`,
      supportsHeuristic: true,
      supportsBestVsHeuristic: true,
    },
    [GAME_OTH]: {
      name: "Othello",
      simsOptions: OTHELLO_SIMS_OPTIONS,
      defaultSims: 6400,  // interactive default ~2.4s at 8 workers (25600 ~9s was too slow; slider retains max)
      defaultHeuristicPly: 4,
      heuristicPlyOptions: OTHELLO_HEURISTIC_PLY_OPTIONS,
      cssClass: "oth",
      sideLabels: { 1: "Black (First)", 2: "White (Second)" },
      rulesLabel: () => "disc majority",
      supportsHeuristic: true,
      supportsBestVsHeuristic: true,
    },
    [GAME_HEX]: {
      name: "Hex",
      simsOptions: HEX_SIMS_OPTIONS,
      defaultSims: 800,  // Phase 0: lowered from 1600 for faster interactive play (slider retains max)
      defaultHeuristicPly: 2,
      heuristicPlyOptions: HEX_HEURISTIC_PLY_OPTIONS,
      cssClass: "hex",
      sideLabels: { 1: "Red (first)", 2: "Blue (second)" },
      rulesLabel: () => "connect sides",
      supportsHeuristic: true,
      supportsBestVsHeuristic: true,
    },
    [GAME_GOMOKU]: {
      name: "Gomoku",
      simsOptions: GOMOKU_SIMS_OPTIONS,
      defaultSims: 3200,  // Phase 0: lowered from 6400 for faster interactive play (slider retains max)
      defaultHeuristicPly: 2,
      cssClass: "gomoku",
      sideLabels: { 1: "Black (first)", 2: "White (second)" },
      pieceText: { 1: "\u25CF", 2: "\u25CB" },
      rulesLabel: (wl) => `${wl} in a row`,
      supportsHeuristic: true,
      supportsBestVsHeuristic: true,
    },
  };
}
let GAME_CONFIG = buildGameConfig();

// --- Player helpers ---
function isHuman(p) { return playerConfig[p]?.type === "human"; }
function isModel(p) { return playerConfig[p]?.type === "model"; }
function isHeuristic(p) { return playerConfig[p]?.type === "heuristic"; }
function isComputerVsComputer() { return !isHuman(1) && !isHuman(2); }
function hasHumanPlayer() { return isHuman(1) || isHuman(2); }
function getHumanPlayer() { return isHuman(1) ? 1 : isHuman(2) ? 2 : null; }
function soleHuman() {
  // Returns the human player number if exactly one human, else null
  const h = getHumanPlayer();
  if (h === null) return null;
  return isHuman(1) && isHuman(2) ? null : h;
}

// Color/piece name for a board side, ignoring the positional word.
// Handles both "First (Red)" → "Red" and "Red (first)" → "Red".
function sideColorName(side) {
  const raw = getGameConfig()?.sideLabels?.[side];
  if (!raw) return `Player ${side}`;
  const m = raw.match(/^(.+?)\s*\(([^)]+)\)$/);
  if (m) {
    const before = m[1], inside = m[2];
    return /^(first|second)$/i.test(before) ? inside : before;
  }
  return raw;
}

function playerName(p) {
  const solo = soleHuman();
  if (isHuman(p) && solo === p) return "You";
  if (getGameConfig()?.sideLabels?.[p]) return sideColorName(p);
  const cfg = playerConfig[p];
  if (cfg.type === "model") {
    return cfg.eloRank > 1 ? `Model #${cfg.eloRank}` : "Model";
  }
  if (cfg.type === "heuristic") return "Heuristic";
  return `Player ${p}`;
}

function winMessage(piece) {
  const name = playerName(piece);
  return name === "You" ? "You win!" : `${name} wins!`;
}

// --- Game helpers ---
function getGameConfig() { return GAME_CONFIG[gameType]; }
function getGameName() { return getGameConfig()?.name || "Unknown"; }
function isOthello() { return gameType === GAME_OTH; }
function isTicTacToe() { return gameType === GAME_TTT; }
function isConnect4() { return gameType === GAME_C4; }
function isHex() { return gameType === GAME_HEX; }
function isGomoku() { return gameType === GAME_GOMOKU; }
function canUseBestVsHeuristic() { return getGameConfig()?.supportsBestVsHeuristic ?? false; }
function canUseHeuristicOpponent() { return getGameConfig()?.supportsHeuristic ?? false; }
// A CNN save IS fixed-topology (it uses cnnNet, not a NEAT population), so classify it as such GLOBALLY
// via the direct wasm_is_cnn export (isCnnModel) — not by string-matching the "ALPHAZERO_CNN" mode (§2).
// isNeatSave() = !isFixedTopologySave(), so this one change also correctly hides the NEAT model-selector
// / Elo controls (gated on isNeatSave()) and coerces selector=0 in restorePlayerConfigFromStorage.
function isFixedTopologySave() { return trainingMode === "ALPHAZERO" || trainingMode === "TD_LAMBDA" || isCnnModel; }
function isNeatSave() { return !isFixedTopologySave(); }

function getDefaultHeuristicPly() {
  // For NEAT/Fixed-GA saves, play_lookahead reflects the tournament heuristic ply.
  // For AZ/TD saves, it's not meaningful for heuristic play — use game config default.
  if (loaded && Module && !isFixedTopologySave() && typeof Module._wasm_get_play_lookahead === "function") {
    const ply = Number(Module._wasm_get_play_lookahead());
    if (Number.isFinite(ply) && ply >= 1) return Math.floor(ply);
  }
  return getGameConfig()?.defaultHeuristicPly || 3;
}

function getHeuristicPlyOptions() {
  const gcfg = getGameConfig();
  const options = (gcfg?.heuristicPlyOptions || HEURISTIC_PLY_OPTIONS).slice();
  const defaultPly = getDefaultHeuristicPly();
  if (defaultPly >= 1 && !options.includes(defaultPly)) {
    options.push(defaultPly);
    options.sort((a, b) => a - b);
  }
  return options;
}

function getDefaultModelSims() {
  const config = getGameConfig();
  let simsOptions = config?.simsOptions || OTHELLO_SIMS_OPTIONS;
  // Phase 0 interactive default cap (per game, lowered for responsiveness; the slider retains the max).
  const interactiveCap = config?.defaultSims || 25600;
  let defaultSims = interactiveCap;
  if (Module && typeof Module._wasm_get_play_sims === "function") {
    // Route through isFixedTopologySave() so CNN saves take the AZ branch too (§2 edit b). Inert in
    // the web build (_wasm_get_play_sims is unexported), but kept consistent for a node/CLI variant.
    const isAZ = isFixedTopologySave();
    if (isAZ) {
      const trainSims = typeof Module._wasm_get_train_sims === "function"
        ? Module._wasm_get_train_sims() : 0;
      const maxGameSims = simsOptions[simsOptions.length - 1] || 12800;
      const azDefault = Math.max(trainSims > 0 ? trainSims * 16 : 12800, 12800);
      defaultSims = Math.min(azDefault, maxGameSims);
    } else {
      const playSims = Module._wasm_get_play_sims();
      if (playSims > 0) defaultSims = playSims;
    }
  }
  // A CNN save's trainSims*16 — or a legacy play-sims value (_wasm_get_play_sims, e.g. 25600) — must NOT
  // push the interactive default above the Phase 0 cap; that cap is the whole point of P0 (a fast first
  // move). The slider still exposes the full range up to the net's own value, so more strength is one
  // click away. Note ALPHAZERO_CNN saves now take the IF/AZ branch above (isFixedTopologySave() is true
  // for CNN, §2 edit b), so this clamp bounds their trainSims*16 default; it also still bounds any
  // play-sims value that reaches the else-branch.
  return Math.min(defaultSims, interactiveCap);
}

// --- WASM model switching ---
function applyModelConfig(config, player) {
  // CNN saves use cnnNet, not a NEAT population — set_elo_rank/set_best_selector are meaningless there
  // (the population is empty, so wasm_set_elo_rank returns -1 on every call, §2). Skip the reconfigure
  // entirely for a CNN net rather than logging a spurious warning each move.
  if (isCnnModel) return;
  if (config.selector === lastAppliedConfig.selector &&
      config.eloRank === lastAppliedConfig.eloRank &&
      player === lastAppliedConfig.player) return;

  let ok = true;
  if (config.selector === 0) {
    // Elo: set rank (also sets selector to Elo in WASM — harmless)
    if (typeof Module._wasm_set_elo_rank === "function") {
      const result = Module._wasm_set_elo_rank(config.eloRank);
      if (result < 0) { console.warn("wasm_set_elo_rank failed for rank", config.eloRank); ok = false; }
    }
  } else {
    // Playoff/BvH: set selector ONLY (do NOT call set_elo_rank — it clobbers selector)
    if (typeof Module._wasm_set_best_selector === "function") {
      const result = Module._wasm_set_best_selector(config.selector);
      if (result < 0) { console.warn("wasm_set_best_selector failed for selector", config.selector); ok = false; }
    }
  }
  // Only cache on success to allow retry on next call
  if (ok) lastAppliedConfig = { selector: config.selector, eloRank: config.eloRank, player: player ?? -1 };
}

function invalidateModelConfigCache() {
  lastAppliedConfig = { selector: -1, eloRank: -1, player: -1 };
}

// --- Turn scheduling ---
function turnMessage(p) {
  const name = playerName(p);
  return name === "You" ? "Your turn" : `${name}'s turn`;
}

function scheduleNextMove() {
  if (gameOver) return;
  if (isHuman(turn)) {
    setStatus(turnMessage(turn));
    updateHexPreviewState();
    return;
  }
  if (isComputerVsComputer()) {
    if (autoPlay.running) {
      scheduleAutoMove();
    }
    // If not running (paused), do nothing — user must click Play or Step
  } else {
    const gen = moveGeneration;
    const p = turn;
    // First rAF paints the human's move; runMoveWithThinking adds a second rAF
    // so the "thinking..." status renders before the synchronous WASM call.
    requestAnimationFrame(() => {
      if (gen !== moveGeneration) return;
      runMoveWithThinking(p, gen).catch(e => setError(e?.message || String(e)));
    });
  }
}

function scheduleAutoMove() {
  if (autoPlay.timerId) clearTimeout(autoPlay.timerId);
  const gen = moveGeneration;
  // Minimum-time: subtract elapsed move time so the delay is a floor, not added on top.
  // Note: thinkingStart is read but not consumed here — finishThinking resets it after
  // computing the display timing (scheduleAutoMove runs before finishThinking in the call chain).
  const elapsed = thinkingStart > 0 ? performance.now() - thinkingStart : 0;
  const remaining = Math.max(0, autoPlay.delay - elapsed);
  autoPlay.timerId = setTimeout(async () => {
    autoPlay.timerId = null;
    if (gen !== moveGeneration || !autoPlay.running || gameOver) return;
    if (autoPlay.batchMode && !autoPlay.batchVisual) {
      // Legacy headless-step branch: the real headless driver is runHeadlessBatch/playHeadlessGame
      // (which keeps autoPlay.running=false, so this is normally unreachable). makeMoveForPlayer is
      // async now — await it so a threaded search applies in-band and its rejection isn't swallowed.
      try { await makeMoveForPlayer(turn); } catch (err) { console.error("[batch] move failed:", err); }
      return;
    }
    // Snapshot the error line BEFORE the move so the re-drive gate below keys off "did THIS move
    // surface an error", not "is any error visible". A STALE error left by an earlier move (setError
    // is only cleared on save-load / WASM-init) would otherwise poison the gate and suppress a
    // legitimate busy-reject re-drive, stalling autoplay.
    const errBefore = errorLine.textContent;
    try {
      await runMoveWithThinking(turn, gen);
    } catch (err) {
      // A thrown config/WASM error must not leave autoplay 'running' with no armed timer and the
      // controls disabled (a wedged UI) — that's what an unhandled rejection here would do. Surface it
      // and unwind autoplay, matching the sibling .catch handlers (stepAutoPlay / autoPauseBtn).
      setError(err?.message || String(err));
      pauseAutoPlay().catch(e => setError(e?.message || String(e)));
      return;
    }
    // If wasm_start_search busy-rejected this move (a prior coordinator was still quiescing — e.g.
    // Pause re-enabled Play before its cancel finished), the move returned SEARCH_CANCELLED, applied
    // nothing, and scheduled no successor — leaving autoplay running with no armed timer (a stall).
    // A successful move instead chains scheduleNextMove → scheduleAutoMove (sets timerId) and a
    // terminal one sets gameOver, so re-drive ONLY when still running with no timer, not game-over,
    // same generation, still CvC, AND this move introduced no NEW error (errorLine unchanged from
    // errBefore). That error gate is load-bearing: a genuine makeMoveForPlayer failure (illegal move /
    // no legal moves / heuristic unavailable) sets a new/changed error text and correctly blocks the
    // re-drive so it can't spin. The one aliasing case — this move fails with the SAME text a stale
    // error already held — is a no-legal-move position, which also sets gameOver and is blocked by that
    // clause. The quiescing coordinator clears busy within a tick or two, so a real re-drive settles
    // quickly rather than spinning.
    // reviewer-flagged (no retry cap / backoff on the busy-reject re-drive), NOT taken: this re-drive
    // fires ONLY on a transient busy-reject that the quiescing coordinator clears within a tick or two,
    // and the error gate above hard-blocks any genuine-failure path — so the bounded settling is real,
    // not "eventually". Adding retry-count/backoff machinery would be over-engineering for an edge case
    // the surrounding comment already reasons about, and CvC-only.
    if (autoPlay.running && !autoPlay.timerId && !gameOver && errorLine.textContent === errBefore &&
        gen === moveGeneration && isComputerVsComputer())
      scheduleAutoMove();
  }, remaining);
}

function resumeGameAfterChange() {
  moveGeneration++;
  if (!loaded) return;
  // A user-initiated game-state change (config/selector/rank/sims/sweep/undo) returns
  // the transcript panel to the live game. Guarded so visual-batch between-game resets
  // and finishBatch (both batchMode-gated or re-asserted) keep the batch view.
  if (!autoPlay.batchMode) { viewingBatch = false; updateTranscriptPanel(); }
  if (isOthello()) {
    resolveOthelloTurn();
  } else {
    scheduleNextMove();
  }
}

// --- UI helpers ---
function setError(msg) { errorLine.textContent = msg || ""; }
// Wrap an async DOM click handler so a rejection surfaces on the error line instead of as an
// unhandled promise rejection — matches the inline .catch on the sibling async-to-DOM boundaries
// (autoPauseBtn, the sweep-rank buttons, stepAutoPlay's runMoveWithThinking).
function guardAsync(handler) {
  return (...args) => handler(...args).catch(e => setError(e?.message || String(e)));
}
function setStatus(msg) { statusLine.textContent = msg; }
function setStatusBusy(msg) { setStatus(msg); statusLine.classList.add('status-busy'); }
function clearStatusBusy() { statusLine.classList.remove('status-busy'); }

// Append a message to the rolling status history (newest last), skipping blanks and consecutive
// duplicates, capped at kStatusHistoryLen. Persistent — it's only pushed out by newer messages or a
// new game (clearStatusHistory), so quick moves leave a readable trail instead of vanishing.
function pushStatusHistory(msg) {
  if (!statusHistoryEl || !msg) return;
  if (statusHistory[statusHistory.length - 1] === msg) return;
  statusHistory.push(msg);
  if (statusHistory.length > kStatusHistoryLen) statusHistory.shift();
  statusHistoryEl.replaceChildren(...statusHistory.map((t) => {
    const d = document.createElement("div");
    d.className = "meta-line status-hist";
    d.textContent = t;
    return d;
  }));
}
function clearStatusHistory() {
  statusHistory = [];
  if (statusHistoryEl) statusHistoryEl.replaceChildren();
}
function setGameInfo(msg) { gameInfo.textContent = msg; }
function setModelInfo(msg) { modelInfo.textContent = msg; }
function setGraphStats(msg) { if (graphStats) graphStats.textContent = msg || ""; }
function showThinking(player) {
  pushStatusHistory(statusLine.textContent);  // move the outgoing state (e.g. "Black's turn") into the trail
  setStatusBusy(`${playerName(player)} thinking...`);
  thinkingStart = performance.now();
}

function finishThinking(player) {
  const elapsed = thinkingStart > 0 ? performance.now() - thinkingStart : 0;
  thinkingStart = 0;
  clearStatusBusy();
  if (gameOver || errorLine.textContent) return;
  const timeStr = elapsed >= 1000 ? `${(elapsed / 1000).toFixed(1)}s` : `${Math.round(elapsed)}ms`;
  const msg = `${playerName(player)} moved (${timeStr})`;
  if (isOthello() || isHuman(turn)) {
    // Don't overwrite Othello pass notices or "Your turn" — record the timing in the history trail.
    pushStatusHistory(msg);
  } else {
    setStatus(msg);
  }
}

function resetThinking() {
  clearStatusBusy();
  thinkingStart = 0;
  // History persists across moves (that's the point) — it's only cleared on a new game (resetBoard).
}

// Show thinking indicator, yield for paint, run makeMoveForPlayer, then clear. Async (PLAN §9.2):
// the move may run OFF the main thread (threaded engine), so this awaits it and the
// finishThinking() cleanup fires only AFTER the awaited move (its finally, not a stale synchronous
// one). setSearchInFlight disables mutating controls while a threaded search is live (§9.4).
async function runMoveWithThinking(player, gen) {
  showThinking(player);
  // Only a MODEL move dispatches a pooled coordinator, so only it needs the §9.4 control lock. A
  // heuristic move runs synchronously on the main thread (no pool, no UAF), so locking for it would
  // just flicker the controls disabled/enabled across the rAF for no benefit (a regression vs the old
  // synchronous path). If the config flips model<->heuristic during the rAF it bumps moveGeneration,
  // which the guard below catches BEFORE makeMoveForPlayer, so this captured flag can't desync from
  // the move that actually runs — and the finally releases exactly what was acquired.
  const isModelMove = playerConfig[player]?.type === "model";
  if (isModelMove) setSearchInFlight(true);
  try {
    await new Promise((r) => requestAnimationFrame(r));
    if (gen !== moveGeneration) { resetThinking(); return; }
    try { await makeMoveForPlayer(player); } finally { finishThinking(player); }
  } finally {
    if (isModelMove) setSearchInFlight(false);
  }
}

function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }
function lerp(a, b, t) { return a + (b - a) * t; }

function fmtCycles(c) {
  return c >= 1e6 ? (c / 1e6).toFixed(c % 1e6 === 0 ? 0 : 1) + "M" : (c / 1e3) + "K";
}

function formatNodeType(type) {
  if (type === 0) return "INPUT";
  if (type === 2) return "OUTPUT";
  return "HIDDEN";
}

function formatMoveReference(row, col) {
  if (row < 0 || col < 0) return "pass";
  if (isConnect4()) return `col ${col + 1}`;
  return `r ${row + 1}, c ${col + 1}`;
}

function updateHexPreviewState() {
  if (!boardEl) return;
  if (!isHex() || !loaded || gameOver || !isHuman(turn)) {
    boardEl.dataset.hexPreview = "0";
    return;
  }
  boardEl.dataset.hexPreview = String(turn);
}

function refreshGraphUi() {
  updateGraphStatsForMode();
  updateGraphModeAvailability();
  hideGraphTooltip();
  scheduleGraphRender();
}

function resetModelUiAfterLoadFailure() {
  setModelInfo("");
  if (playInfo) playInfo.textContent = "";
  graphActivationSnapshots = { 1: [], 2: [] };
  graphTopologyStatsText = "No model loaded.";
  updateGraphStatsForMode();
  scheduleGraphRender();
  updateUndoState();
}

// A save-load that FAILED after `_wasm_load_save` already ran leaves the WASM engine state DESTROYED
// (wasm_load.cpp resets cnnNet/isCNN/nets on entry, and SetError sets gState.loaded=false), so the
// previously-loaded game no longer exists. Return the UI to the no-save state: mark unloaded (board
// clicks, New Game, Undo, autoplay all gate on `loaded`, so this neuters interactive play), cancel any
// pending scheduled move, and disable the play controls — but KEEP the file pickers enabled so the user
// can load a valid save. Distinct from a PRE-load failure (bad .zst, unsupported type) where the old
// engine survives and should keep playing; only call this once the destructive C++ load has run.
function enterNoSaveState(msg) {
  loaded = false;
  moveGeneration++;                                    // discard any move scheduled against the dead engine
  if (autoPlay.timerId) { clearTimeout(autoPlay.timerId); autoPlay.timerId = null; }
  autoPlay.running = false;
  autoPlay.batchMode = false;
  autoPlay.batchVisual = false;
  // A load can fail WHILE an autoplay/batch had the config selects + file pickers locked via
  // setControlsDisabledDuringPlay(true). Clearing running/batchMode above stops the play machinery, but
  // the demo's tab-driven load reaches this no-save state on failure WITHOUT routing through
  // pauseAutoPlay()/cancelBatch() (which are the only paths that unlock those controls) — so they would
  // stay stranded-disabled and the user couldn't pick another save. Unlock them here (this is the
  // "keep the file pickers usable" guarantee this state documents), THEN re-disable the play-only
  // buttons below since there is no live engine to play.
  setControlsDisabledDuringPlay(false);
  resetModelUiAfterLoadFailure();
  updateAutoplayVisibility();
  if (newGameButton) newGameButton.disabled = true;
  if (undoButton) undoButton.disabled = true;
  if (swapSidesBtn) swapSidesBtn.disabled = true;
  setError(msg || "Load failed.");
  setStatus("Load failed — load a valid save file.");
}

function failLoad(errorMsg, { clearModelUi = false } = {}) {
  setError(errorMsg || "Load failed.");
  setStatus("Load failed.");
  if (clearModelUi) resetModelUiAfterLoadFailure();
}

// --- Graph activation snapshots (per-player) ---
function getActiveGraphPlayer() {
  if (graphViewPlayer === 1 || graphViewPlayer === 2) return graphViewPlayer;
  return lastModelMovePlayer || (isModel(2) ? 2 : isModel(1) ? 1 : null);
}

function getLatestActivationSnapshot() {
  const p = getActiveGraphPlayer();
  if (!p) return null;
  const arr = graphActivationSnapshots[p];
  return arr?.length ? arr[arr.length - 1] : null;
}

function clearActivationSnapshots() {
  graphActivationSnapshots = { 1: [], 2: [] };
}

function anyModelPlayer() {
  return isModel(1) || isModel(2);
}

function updateGraphStatsForMode() {
  if (!loaded || !Module) {
    graphTopologyStatsText = "No model loaded.";
    setGraphStats(graphTopologyStatsText);
    return;
  }
  if (graphMode !== "activation") {
    setGraphStats(graphTopologyStatsText);
    return;
  }
  if (!anyModelPlayer()) {
    setGraphStats("Activation unavailable (no model player).");
    return;
  }
  const snap = getLatestActivationSnapshot();
  if (!snap) {
    setGraphStats("No model move yet.");
    return;
  }
  const evalLabel = Number.isFinite(snap.eval) ? snap.eval.toFixed(2) : "n/a";
  const pLabel = snap.player ? `P${snap.player}` : "AI";
  setGraphStats(`${pLabel} move #${snap.moveNumber} (${snap.moveRef}): ${snap.sims} sims, eval ${evalLabel}`);
}

function updateGraphModeAvailability() {
  if (!graphModeSelect) return;
  const activationOption = graphModeSelect.querySelector('option[value="activation"]');
  if (!activationOption) return;
  const hasExports = !!Module &&
    typeof Module._wasm_copy_node_activations === "function" &&
    typeof Module._wasm_evaluate_board === "function";
  const activationAllowed = anyModelPlayer() && hasExports;
  activationOption.disabled = !activationAllowed;
  if (!activationAllowed && graphMode === "activation") {
    graphMode = "topology";
    graphModeSelect.value = "topology";
    updateGraphStatsForMode();
    scheduleGraphRender();
  }
}

function updateGraphPlayerSelect() {
  if (!graphPlayerSelect) return;
  const modelCount = (isModel(1) ? 1 : 0) + (isModel(2) ? 1 : 0);
  graphPlayerSelect.style.display = modelCount >= 2 ? "" : "none";
}

// --- Per-player UI controls ---

function getPlayerPanel(player) {
  return document.querySelector(`.player-config[data-player="${player}"]`);
}

function setSelectNumericOptions(selectEl, options, fallback) {
  if (!selectEl) return;
  const previous = selectEl.value === "" ? NaN : Number(selectEl.value);
  selectEl.textContent = "";
  options.forEach((value) => {
    const opt = document.createElement("option");
    opt.value = String(value);
    opt.textContent = (value === 0) ? "Off" : String(value);
    selectEl.appendChild(opt);
  });
  let next = Number.isFinite(previous) && options.includes(previous) ? previous : fallback;
  if (!options.includes(next)) next = options[0];
  selectEl.value = String(next);
}

function updatePlayerControls(player) {
  const panel = getPlayerPanel(player);
  if (!panel) return;
  const cfg = playerConfig[player];
  const type = cfg.type;

  const typeSelect = panel.querySelector(".player-type");
  if (typeSelect && typeSelect.value !== type) typeSelect.value = type;

  // Disable heuristic option for games that don't support it
  const heuristicOpt = typeSelect?.querySelector('option[value="heuristic"]');
  if (heuristicOpt) heuristicOpt.disabled = !canUseHeuristicOpponent();

  const modelParams = panel.querySelector(".model-params");
  const heuristicParams = panel.querySelector(".heuristic-params");

  if (modelParams) modelParams.hidden = type !== "model";
  if (heuristicParams) heuristicParams.hidden = type !== "heuristic";

  if (type === "model") {
    const modelSelect = panel.querySelector(".player-model-select");
    const eloRankInput = panel.querySelector(".player-elo-rank");
    const strengthSelect = modelParams?.querySelector(".player-strength");

    // Model selector: only enable for NEAT saves
    if (modelSelect) {
      modelSelect.disabled = !loaded || !Module || !isNeatSave();
      if (isNeatSave()) {
        modelSelect.value = String(cfg.selector);
      }
      const bvhOpt = modelSelect.querySelector('option[value="2"]');
      if (bvhOpt) bvhOpt.disabled = !canUseBestVsHeuristic();
    }

    // Elo rank: only enable for NEAT + Elo selector
    if (eloRankInput) {
      const rankEnabled = loaded && Module && isNeatSave() && cfg.selector === 0;
      eloRankInput.disabled = !rankEnabled;
      eloRankInput.max = String(maxEloRank);
      eloRankInput.value = String(cfg.eloRank);
    }

    // Strength (MCTS sims)
    if (strengthSelect) {
      const config = getGameConfig();
      let simsOptions = config?.simsOptions || OTHELLO_SIMS_OPTIONS;
      const defaultSims = getDefaultModelSims();
      // Ensure both the default and the player's current sims are available in the dropdown
      for (const v of [defaultSims, cfg.sims]) {
        if (v != null && v >= 0 && !simsOptions.includes(v)) {
          simsOptions = [...simsOptions, v].sort((a, b) => a - b);
        }
      }
      // cfg.sims (config default, capped by getDefaultModelSims, or a restored localStorage pick) is
      // authoritative. Discard any stale value the select still holds from an earlier render so
      // setSelectNumericOptions selects cfg.sims via its `fallback` instead of PRESERVING the stale DOM
      // value — otherwise a pre-load render's uncapped 25600 (config is undefined at gameType 0) is a
      // valid Othello option and survives past the restored/default sims, pinning the dropdown at 25600.
      strengthSelect.value = "";
      setSelectNumericOptions(strengthSelect, simsOptions, cfg.sims ?? defaultSims);
      const parsedSims = Number(strengthSelect.value);
      cfg.sims = Number.isFinite(parsedSims) ? parsedSims : defaultSims;
    }
  }

  if (type === "heuristic") {
    const strengthSelect = heuristicParams?.querySelector(".player-strength");
    if (strengthSelect) {
      const options = getHeuristicPlyOptions();
      const defaultPly = getDefaultHeuristicPly();
      strengthSelect.value = "";  // cfg.ply is authoritative — don't preserve a stale DOM value (see sims above)
      setSelectNumericOptions(strengthSelect, options, cfg.ply ?? defaultPly);
      const parsedPly = Number(strengthSelect.value);
      cfg.ply = Number.isFinite(parsedPly) && parsedPly >= 1 ? parsedPly : defaultPly;
    }
  }

  updatePlayerHeader(player);
}

function updatePlayerHeader(player) {
  const panel = getPlayerPanel(player);
  if (!panel) return;
  const header = panel.querySelector(".player-header");
  if (!header) return;
  const sideLabels = getGameConfig()?.sideLabels;
  const label = sideLabels?.[player] || `Player ${player}`;
  header.textContent = `Player ${player} — ${label}`;
}

function updatePlayInfo() {
  if (!playInfo) return;
  const parts = [];
  for (const p of [1, 2]) {
    const cfg = playerConfig[p];
    if (cfg.type === "heuristic") {
      const plyLabel = cfg.ply <= 1 ? "HEURISTIC (ply 1)" : `NEGAMAX (ply ${cfg.ply})`;
      parts.push(`P${p}: ${plyLabel}`);
    } else if (cfg.type === "model") {
      parts.push(`P${p}: MCTS (${cfg.sims} sims)`);
    }
  }
  playInfo.textContent = parts.length ? parts.join(" | ") : "";
}

function updateAutoplayVisibility() {
  if (!autoplayControlsEl) return;
  autoplayControlsEl.style.display = isComputerVsComputer() && loaded ? "" : "none";
}

function setControlsDisabledDuringPlay(disabled) {
  // Disable player config, New Game, Undo, and file inputs during autoplay/batch
  // But keep batchShowGames enabled so user can toggle visual mode mid-run
  document.querySelectorAll(".player-config select, .player-config input").forEach(el => {
    el.disabled = disabled;
  });
  if (newGameButton) newGameButton.disabled = disabled;
  if (undoButton) undoButton.disabled = disabled;
  if (swapSidesBtn) swapSidesBtn.disabled = disabled;
  if (saveInput) saveInput.disabled = disabled;
  if (sweepFileInput) sweepFileInput.disabled = disabled;
  // Graph-player select and the sweep-champion buttons also mutate the active net (applyModelConfig /
  // wasm_set_elo_rank), so they must be locked while a search is in flight too — else changing them
  // frees the net under a live coordinator (use-after-free). They live outside `.player-config`, so
  // disable them explicitly (§9.4).
  if (graphPlayerSelect) graphPlayerSelect.disabled = disabled;
  if (sweepInfoEl) sweepInfoEl.querySelectorAll("button").forEach(b => { b.disabled = disabled; });
}

// --- Sweep CSV support ---

function parseSweepCsv(text) {
  const lines = text.trim().split("\n");
  if (lines.length < 2) return [];
  const header = lines[0].split(",").map(h => h.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",");
    if (cols.length < 4) continue;
    const row = {};
    for (let j = 0; j < header.length; j++) {
      row[header[j]] = (cols[j] || "").trim();
    }
    rows.push(row);
  }
  return rows;
}

function getSweepChampions(rows, targetCycles) {
  const empty = { champions: [], matchedCycles: 0, latestCycles: 0 };
  const tournamentTypes = new Set(["bvh", "elo", "playoff"]);
  const tournamentRows = rows.filter(r => tournamentTypes.has(r.champion) && Number(r.cycles) > 0);
  if (tournamentRows.length === 0) return empty;
  const allCycles = [...new Set(tournamentRows.map(r => Number(r.cycles)))].sort((a, b) => a - b);
  const latestCycles = allCycles[allCycles.length - 1];
  let matchedCycles;
  if (targetCycles != null) {
    matchedCycles = allCycles.filter(c => c <= targetCycles).pop();
    if (matchedCycles == null) return empty;
  } else {
    matchedCycles = latestCycles;
  }
  const matched = tournamentRows.filter(r => Number(r.cycles) === matchedCycles);
  const best = new Map();
  for (const row of matched) {
    const key = row.champion;
    const pct = Number(row.aggregate_pct) || 0;
    const existing = best.get(key);
    if (!existing || pct > (Number(existing.aggregate_pct) || 0)) {
      best.set(key, row);
    }
  }
  return { champions: Array.from(best.values()), matchedCycles, latestCycles };
}

const sweepChampionLabels = { bvh: "BvH", elo: "Elo", playoff: "Playoff" };
let currentSweepCsvName = ""; // tracks loaded sweep CSV filename for dashboard link
let currentSaveFileName = ""; // last filename passed to loadSaveFile (URL autoload doesn't populate saveInput.files)
let currentSaveFile = null;   // last File passed to loadSaveFile (demo loads a fetched File, not saveInput.files)

// PBT-mode sweep panel renderer. Shows current slot + champion + clickable
// "load slot NN" links. Champion's BvH sims auto-apply to model players when
// the user is on the champion slot (matches the single-agent BvH auto-apply
// path); on other slots the sims still apply as a sensible play default.
function renderPbtSweepInfo(pbt, currentSlot, autoApplySweep, currentSaveName) {
  if (!sweepInfoEl) return;
  const frag = document.createDocumentFragment();
  const fmtSlot = s => "slot " + String(s).padStart(2, "0");
  const isOnChampion = currentSlot != null && currentSlot === pbt.championSlot;
  const headerText = currentSlot != null
    ? `Sweep PBT: on ${fmtSlot(currentSlot)}`
      + (pbt.currentSlotPct != null ? ` (BvH ${pbt.currentSlotPct.toFixed(1)}%)` : "")
      + ` · champion ${fmtSlot(pbt.championSlot)} (BvH ${pbt.championPct.toFixed(1)}% @ ${pbt.championSims})`
    : `Sweep PBT: champion ${fmtSlot(pbt.championSlot)} (BvH ${pbt.championPct.toFixed(1)}% @ ${pbt.championSims})`;
  frag.appendChild(document.createTextNode(headerText));

  // Play champion link (only when not already on the champion slot).
  if (!isOnChampion && currentSaveName) {
    frag.appendChild(document.createTextNode(" "));
    const a = document.createElement("a");
    a.className = "sweep-rank-btn";
    a.textContent = `Play ${fmtSlot(pbt.championSlot)}`;
    a.href = "?save=" + encodeURIComponent(pbtSwitchSaveName(currentSaveName, pbt.championSlot));
    a.title = "Load champion slot";
    frag.appendChild(a);
  }

  // Per-slot quick-load links — let the user jump between slots in one click.
  if (currentSaveName && pbt.slots.length > 1) {
    frag.appendChild(document.createTextNode(" · "));
    pbt.slots.forEach((s, i) => {
      if (s.slot === currentSlot) {
        const span = document.createElement("span");
        span.textContent = fmtSlot(s.slot);
        span.style.fontWeight = "600";
        span.title = `BvH ${s.pct.toFixed(1)}%`;
        frag.appendChild(span);
      } else {
        const a = document.createElement("a");
        a.textContent = fmtSlot(s.slot);
        a.href = "?save=" + encodeURIComponent(pbtSwitchSaveName(currentSaveName, s.slot));
        a.title = `BvH ${s.pct.toFixed(1)}%`;
        a.className = "sweep-rank-link";
        frag.appendChild(a);
      }
      if (i < pbt.slots.length - 1) frag.appendChild(document.createTextNode(" "));
    });
  }

  // Dashboard link (mirrors the single-agent path).
  if (currentSweepCsvName) {
    frag.appendChild(document.createTextNode(" · "));
    const dashLink = document.createElement("a");
    dashLink.className = "sweep-dash-link";
    dashLink.textContent = "Dashboard";
    dashLink.href = `../sweep-dashboard.html?csv=${encodeURIComponent(currentSweepCsvName)}`;
    dashLink.target = "_blank";
    dashLink.title = "Open sweep dashboard for this run";
    frag.appendChild(dashLink);
  }
  sweepInfoEl.appendChild(frag);

  // Auto-apply champion's sims to model players. Same gating as single-agent
  // path: only on save-load, not during autoplay/batch, and only at the start
  // of a fresh game. AZ saves have no Elo rank dimension so we just apply sims.
  if (loaded && Module && !autoPlay.running && !autoPlay.batchMode
      && autoApplySweep && moveHistory.length === 0
      && pbt.championSims > 0) {
    const modelPlayers = [1, 2].filter(p => isModel(p));
    for (const p of modelPlayers) {
      const cfg = playerConfig[p];
      cfg.sims = pbt.championSims;
      updatePlayerControls(p);
      const panel = getPlayerPanel(p);
      const strengthSelect = panel?.querySelector(".model-params .player-strength");
      if (strengthSelect) {
        strengthSelect.value = String(pbt.championSims);
        cfg.sims = Number(strengthSelect.value) || pbt.championSims;
      }
    }
    if (modelPlayers.length > 0) {
      refreshModelSummary(saveInput?.files?.[0]);
      loadGraphData();
      updatePlayInfo();
    }
  }
}

function updateSweepInfo(autoApplySweep = false) {
  if (!sweepInfoEl) return;
  sweepInfoEl.innerHTML = "";
  if (!sweepData || sweepData.length === 0) return;

  // PBT branch: detected by presence of `slot` column on any row. Renders a
  // per-slot panel (Play champion + load-slot links) instead of the single-
  // agent champion buttons.
  const currentSaveName = currentSaveFileName || saveInput?.files?.[0]?.name || "";
  const currentSlot = getCurrentPbtSlot(currentSaveName);
  const pbt = getPbtChampion(sweepData, currentSlot);
  if (pbt) {
    renderPbtSweepInfo(pbt, currentSlot, autoApplySweep, currentSaveName);
    return;
  }

  const raw = (loaded && Module && typeof Module._wasm_get_cycles === "function")
    ? Number(Module._wasm_get_cycles()) : null;
  const saveCycles = (raw != null && !isNaN(raw)) ? raw : null;
  const { champions, matchedCycles, latestCycles } = getSweepChampions(sweepData, saveCycles);
  if (champions.length === 0) return;

  const cyclesStr = fmtCycles(matchedCycles);
  const frag = document.createDocumentFragment();
  const isLatest = saveCycles == null || matchedCycles === latestCycles;
  const prefix = isLatest ? `Sweep ${cyclesStr}: ` : `Sweep ~${cyclesStr} (nearest to loaded save): `;
  frag.appendChild(document.createTextNode(prefix));

  // Determine sweep target player (auto-target sole model, or show P1/P2 buttons)
  const modelPlayers = [1, 2].filter(p => isModel(p));

  champions.forEach((ch, i) => {
    const rank = Number(ch.elo_rank) || 0;
    const pct = Number(ch.aggregate_pct) || 0;
    const label = sweepChampionLabels[ch.champion] || ch.champion;
    const sims = ch.sims || "?";
    const text = `${label} rank ${rank} (${pct}% @ ${sims})`;

    if (rank > 0 && loaded && Module) {
      if (modelPlayers.length === 1) {
        // Auto-target sole model player
        const targetPlayer = modelPlayers[0];
        const btn = document.createElement("button");
        btn.className = "sweep-rank-btn";
        btn.textContent = text;
        btn.title = `Apply to P${targetPlayer}: Elo rank ${rank}`;
        // applySweepRank is async (awaits pool quiescence); a throw past the await would be an
        // unhandled rejection, so surface it on the error line instead.
        btn.addEventListener("click", () => applySweepRank(rank, label, Number(sims) || 0, targetPlayer)
          .catch(e => setError(e?.message || String(e))));
        frag.appendChild(btn);
      } else if (modelPlayers.length === 2) {
        // Show P1/P2 buttons
        for (const tp of modelPlayers) {
          const btn = document.createElement("button");
          btn.className = "sweep-rank-btn";
          btn.textContent = `${text} → P${tp}`;
          btn.title = `Apply to P${tp}: Elo rank ${rank}`;
          btn.addEventListener("click", () => applySweepRank(rank, label, Number(sims) || 0, tp)
            .catch(e => setError(e?.message || String(e))));
          frag.appendChild(btn);
          if (tp === 1) frag.appendChild(document.createTextNode(" "));
        }
      } else {
        const span = document.createElement("span");
        span.textContent = text;
        frag.appendChild(span);
      }
    } else {
      const span = document.createElement("span");
      span.textContent = text;
      frag.appendChild(span);
    }

    if (i < champions.length - 1) {
      frag.appendChild(document.createTextNode(" \u00b7 "));
    }
  });
  // Add dashboard link if we know the sweep CSV name
  if (currentSweepCsvName) {
    frag.appendChild(document.createTextNode(" \u00b7 "));
    const dashLink = document.createElement("a");
    dashLink.className = "sweep-dash-link";
    dashLink.textContent = "Dashboard";
    dashLink.href = `../sweep-dashboard.html?csv=${encodeURIComponent(currentSweepCsvName)}`;
    dashLink.target = "_blank";
    dashLink.title = "Open sweep dashboard for this run";
    frag.appendChild(dashLink);
  }

  sweepInfoEl.appendChild(frag);

  // Auto-apply BvH champion's sims (and rank for NEAT) to model players
  // Only on save-load (not manual sweep pick or during autoplay/batch)
  const bvhChampion = champions.find(ch => ch.champion === "bvh");
  if (bvhChampion && loaded && Module && !autoPlay.running && !autoPlay.batchMode && autoApplySweep && moveHistory.length === 0) {
    // Phase 0: an auto-loaded sweep champion budget must not push interactive sims
    // ABOVE the (lowered) game default — the default is the fast-play ceiling; the
    // slider still lets a user pick max strength manually. A smaller champion budget
    // is kept as-is.
    const rawBvhSims = Number(bvhChampion.sims) || 0;
    const gameDefaultSims = Number(getGameConfig()?.defaultSims) || 0;
    const bvhSims = (rawBvhSims > 0 && gameDefaultSims > 0)
      ? Math.min(rawBvhSims, gameDefaultSims) : rawBvhSims;
    const bvhRank = Number(bvhChampion.elo_rank) || 0;
    for (const p of modelPlayers) {
      const cfg = playerConfig[p];
      if (bvhSims > 0) cfg.sims = bvhSims;
      if (bvhRank > 0 && isNeatSave()) {
        cfg.selector = 0;
        cfg.eloRank = bvhRank;
        applyModelConfig(cfg, p);
      }
      updatePlayerControls(p);
      // Force the strength dropdown to the BvH sims value
      if (bvhSims > 0) {
        const panel = getPlayerPanel(p);
        const strengthSelect = panel?.querySelector(".model-params .player-strength");
        if (strengthSelect) {
          strengthSelect.value = String(bvhSims);
          cfg.sims = Number(strengthSelect.value) || bvhSims;
        }
      }
    }
    if (modelPlayers.length > 0) {
      refreshModelSummary(saveInput?.files?.[0]);
      loadGraphData();
      updatePlayInfo();
    }
  }
}

async function applySweepRank(rank, label, sims, targetPlayer) {
  if (!loaded || !Module || typeof Module._wasm_set_elo_rank !== "function") return;
  if (autoPlay.running || autoPlay.batchMode) return; // don't mutate config during play
  if (rank < 1 || rank > maxEloRank) {
    setError(`Sweep rank ${rank} out of range (max ${maxEloRank}).`);
    return;
  }
  // §9.4: quiesce any in-flight interactive search before applyModelConfig rebuilds the net for the
  // new Elo rank (wasm_set_elo_rank -> RebuildNetForEloRank frees netByElo under a live coordinator).
  // resumeGameAfterChange() below re-drives the cancelled move with the champion config, so no stall.
  await cancelAndQuiesceSearch();
  if (!loaded) return; // a save-load during the quiesce superseded this

  const cfg = playerConfig[targetPlayer];
  cfg.selector = 0;
  cfg.eloRank = rank;
  if (sims > 0) cfg.sims = sims;

  // Apply to WASM
  applyModelConfig(cfg, targetPlayer);

  updatePlayerControls(targetPlayer);

  // Force the strength dropdown to the sweep sims (updatePlayerControls may have preserved old value)
  if (sims > 0) {
    const panel = getPlayerPanel(targetPlayer);
    const strengthSelect = panel?.querySelector(".model-params .player-strength");
    if (strengthSelect) {
      strengthSelect.value = String(sims);
      cfg.sims = Number(strengthSelect.value) || sims;
    }
  }
  refreshModelSummary(saveInput?.files?.[0]);
  loadGraphData();
  resumeGameAfterChange();
  setStatus(`P${targetPlayer}: sweep ${label} champion (rank ${rank}, ${sims} sims).`);
}

// --- Model summary ---
function bestSelectorLabel(player) {
  const cfg = playerConfig[player];
  if (!cfg || cfg.type !== "model") return "";
  if (cfg.selector === 1) return "Best by Playoff";
  if (cfg.selector === 2) return "Best vs Heuristic";
  return cfg.eloRank === 1 ? "Best by Elo" : `Elo Rank ${cfg.eloRank}`;
}

function refreshModelSummary(file) {
  if (!Module || !loaded) {
    setModelInfo("");
    if (trainingParamsEl) trainingParamsEl.textContent = "";
    if (playInfo) playInfo.textContent = "";
    return;
  }

  try {
    const label = getGameName();
    const cycles = Number(Module._wasm_get_cycles());
    const population = Module._wasm_get_population();
    const bestElo = Module._wasm_get_best_elo();
    const bestGames = Module._wasm_get_best_games();
    const bestWins = Module._wasm_get_best_wins();
    const bestDraws = Module._wasm_get_best_draws();
    const bestLosses = Module._wasm_get_best_losses();
    const bestHidden = Module._wasm_get_best_hidden();
    const bestNodes = Module._wasm_get_best_nodes();
    const bestConns = Module._wasm_get_best_connections_total();
    const bestConnsEnabled = Module._wasm_get_best_connections_enabled();
    const bestLayers = Module._wasm_get_best_layers();

    const fileTime = file?.lastModified ? new Date(file.lastModified) : null;
    const timeLabel = fileTime ? fileTime.toLocaleString() : "unknown time";
    const rulesLabel = getGameConfig()?.rulesLabel?.(winLength) || (isOthello() ? "disc majority" : `win ${winLength}`);
    setGameInfo(`${label} \u2022 ${width}x${height} \u2022 ${rulesLabel} \u2022 saved ${timeLabel}`);

    const cyclesLabel = fmtCycles(cycles);
    const modeLabel = trainingMode ? ` \u2022 mode: ${trainingMode}` : "";

    // Show best selector for the first model player
    const modelPlayer = isModel(1) ? 1 : isModel(2) ? 2 : null;
    const bestLabel = modelPlayer ? bestSelectorLabel(modelPlayer) : "";

    let heuristicInfo = "";
    if (modelPlayer && playerConfig[modelPlayer].selector === 2 && typeof Module._wasm_get_heuristic_wins === "function") {
      const heurWins = Module._wasm_get_heuristic_wins();
      const heurTotalGames = typeof Module._wasm_get_heuristic_total_games === "function"
        ? Module._wasm_get_heuristic_total_games() : 40;
      const heurEloRank = typeof Module._wasm_get_heuristic_elo_rank === "function"
        ? Module._wasm_get_heuristic_elo_rank() : 0;
      const safeTotal = heurTotalGames > 0 ? heurTotalGames : 40;
      const winRate = ((heurWins / safeTotal) * 100).toFixed(0);
      heuristicInfo = ` \u2022 vs-heur ${winRate}% (${heurWins}/${safeTotal})`;
      if (heurEloRank > 0) heuristicInfo += ` \u2022 elo-rank #${heurEloRank}`;
    }

    setModelInfo(
      `cycles ${cyclesLabel}${modeLabel} \u2022 pop ${population} \u2022 ${bestLabel} Elo ${bestElo.toFixed(1)} (W/D/L=${bestWins}/${bestDraws}/${bestLosses} of ${bestGames} games)${heuristicInfo} \u2022 hidden ${bestHidden} \u2022 nodes ${bestNodes} \u2022 conns ${bestConnsEnabled}/${bestConns} \u2022 layers ${bestLayers + 1}`
    );

    if (trainingParamsEl) {
      let paramsText = "";
      if (typeof Module._wasm_get_train_sims === "function") {
        const trainSims = Module._wasm_get_train_sims();
        const trainSimsMin = Module._wasm_get_train_sims_min();
        const playSims = Module._wasm_get_play_sims();
        const parsimonyConn = Module._wasm_get_parsimony_conn();
        const parsimonyHidden = Module._wasm_get_parsimony_hidden();
        if (trainSims > 0 || playSims > 0) {
          const trainSimsLabel = trainSimsMin > 0 ? `${trainSimsMin}-${trainSims}` : `${trainSims}`;
          paramsText = `train_sims=${trainSimsLabel} \u2022 play_sims=${playSims} \u2022 parsimony=(conn=${parsimonyConn.toFixed(3)}, hidden=${parsimonyHidden.toFixed(3)})`;
        }
      }
      trainingParamsEl.textContent = paramsText;
    }

    updatePlayInfo();
  } catch (err) {
    console.error("Critical error in refreshModelSummary:", err);
    if (err && err.stack) console.error(err.stack);
  }
}

// --- Graph rendering ---

function scheduleGraphRender() {
  if (!graphCanvas) return;
  if (graphRenderQueued) return;
  graphRenderQueued = true;
  requestAnimationFrame(() => {
    graphRenderQueued = false;
    renderGraph();
  });
}

// Allocate `n` bytes in the WASM heap or throw. On the fixed-heap threaded bundle (ABORTING_MALLOC=0)
// _malloc returns 0 when the heap is full; writing a HEAP view at address 0 then silently corrupts low
// WASM memory. Throwing surfaces the OOM instead — the caller's feature (board/graph render) fails
// visibly and the game plays on. (The big save alloc in loadSaveFile guards the same hazard by hand.)
function wasmMalloc(n) {
  const p = Module._malloc(n);
  if (!p && n > 0) throw new Error(`WASM _malloc(${n}) failed (heap full)`);
  return p;
}

function ensureBoardPtr(size) {
  if (!Module) return;
  if (boardPtr && boardSize === size) return;
  if (boardPtr) { Module._free(boardPtr); boardPtr = 0; }
  boardPtr = wasmMalloc(size * 4);
  boardSize = size;
}

function copyBoardToWasm() {
  ensureBoardPtr(board.length);
  Module.HEAP32.set(board, boardPtr >> 2);
}

function getWasmString(ptr) {
  if (ptr === 0 || !Module) return "";
  try {
    if (typeof Module.UTF8ToString === "function") return Module.UTF8ToString(ptr);
    if (typeof UTF8ToString === "function") return UTF8ToString(ptr);
    let str = "";
    let i = ptr;
    while (Module.HEAPU8[i] !== 0) {
      str += String.fromCharCode(Module.HEAPU8[i++]);
      if (str.length > 2048) break;
    }
    return str;
  } catch (err) {
    console.warn("getWasmString failed:", err);
    return "";
  }
}

// --- Board building ---

function markHexEdgeCells() {
  if (!isHex()) return;
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const idx = row * width + col;
      const cell = cells[idx];
      if (!cell) continue;
      if (row === 0) cell.classList.add("edge-top");
      if (row === height - 1) cell.classList.add("edge-bottom");
      if (col === 0) cell.classList.add("edge-left");
      if (col === width - 1) cell.classList.add("edge-right");
    }
  }
}

function buildBoardGrid() {
  boardEl.innerHTML = "";
  cells = new Array(board.length);
  boardEl.classList.remove("ttt", "c4", "oth", "hex", "gomoku");
  const cssClass = getGameConfig()?.cssClass;
  if (cssClass) boardEl.classList.add(cssClass);

  if (isHex()) {
    boardEl.style.gridTemplateColumns = "";
    boardEl.style.gridTemplateRows = "";
    boardEl.style.display = "block";
    const cellSize = window.innerWidth <= 640 ? 28 : 36;
    const labelPadding = window.innerWidth <= 640 ? 28 : 40;
    const hexHeight = cellSize * 1.1547;
    const horizontalSpacing = cellSize;
    const verticalSpacing = hexHeight * 0.75;
    const rowOffset = cellSize * 0.5;
    const boardWidth = (width + (height - 1) * 0.5) * horizontalSpacing + labelPadding * 2;
    const boardHeight = (height - 1) * verticalSpacing + hexHeight + labelPadding * 2;
    boardEl.style.setProperty("--hex-w", `${cellSize}px`);
    boardEl.style.setProperty("--hex-h", `${hexHeight}px`);
    boardEl.style.position = "relative";
    boardEl.style.width = `${boardWidth}px`;
    boardEl.style.height = `${boardHeight}px`;

    for (let col = 0; col < width; col++) {
      const char = String.fromCharCode(65 + col);
      const topLabel = document.createElement("div");
      topLabel.className = "hex-label hex-label-top";
      topLabel.textContent = char;
      topLabel.style.color = "var(--hex-p1)";
      const tx = (col + (height - 1) * 0.5) * horizontalSpacing + cellSize / 2 + labelPadding;
      topLabel.style.left = `${tx}px`;
      topLabel.style.top = `${labelPadding / 2}px`;
      boardEl.appendChild(topLabel);

      const bottomLabel = document.createElement("div");
      bottomLabel.className = "hex-label hex-label-bottom";
      bottomLabel.textContent = char;
      bottomLabel.style.color = "var(--hex-p1)";
      const bx = col * horizontalSpacing + cellSize / 2 + labelPadding;
      bottomLabel.style.left = `${bx}px`;
      bottomLabel.style.top = `${boardHeight - labelPadding / 2}px`;
      boardEl.appendChild(bottomLabel);
    }

    for (let row = 0; row < height; row++) {
      const labelText = String(row + 1);
      const leftLabel = document.createElement("div");
      leftLabel.className = "hex-label hex-label-left";
      leftLabel.textContent = labelText;
      leftLabel.style.color = "var(--hex-p2)";
      const lx = (height - 1 - row) * rowOffset + labelPadding / 2;
      const ly = row * verticalSpacing + hexHeight / 2 + labelPadding;
      leftLabel.style.left = `${lx}px`;
      leftLabel.style.top = `${ly}px`;
      boardEl.appendChild(leftLabel);

      const rightLabel = document.createElement("div");
      rightLabel.className = "hex-label hex-label-right";
      rightLabel.textContent = labelText;
      rightLabel.style.color = "var(--hex-p2)";
      const rx = (width + (height - 1 - row) * 0.5) * horizontalSpacing + labelPadding * 1.5;
      rightLabel.style.left = `${rx}px`;
      rightLabel.style.top = `${ly}px`;
      boardEl.appendChild(rightLabel);
    }

    for (let row = 0; row < height; row++) {
      for (let col = 0; col < width; col++) {
        const idx = row * width + col;
        const cell = document.createElement("div");
        cell.className = "cell";
        cell.dataset.idx = String(idx);
        cell.dataset.row = String(row);
        cell.dataset.col = String(col);
        const x = col * horizontalSpacing + (height - 1 - row) * rowOffset + labelPadding;
        const y = row * verticalSpacing + labelPadding;
        cell.style.position = "absolute";
        cell.style.left = `${x}px`;
        cell.style.top = `${y}px`;
        cell.style.width = `${cellSize}px`;
        cell.style.height = `${hexHeight}px`;
        cell.style.zIndex = String(100 + row + col);
        const edgeTB = document.createElement("div");
        edgeTB.className = "hex-edge hex-edge-tb";
        cell.appendChild(edgeTB);
        const edgeLR = document.createElement("div");
        edgeLR.className = "hex-edge hex-edge-lr";
        cell.appendChild(edgeLR);
        const tile = document.createElement("div");
        tile.className = "hex-tile";
        cell.appendChild(tile);
        boardEl.appendChild(cell);
        cells[idx] = cell;
      }
    }
    markHexEdgeCells();
  } else if (isGomoku()) {
    boardEl.style.display = "";
    boardEl.style.flexDirection = "";
    boardEl.style.gridTemplateColumns = `repeat(${width}, minmax(0, 1fr))`;
    boardEl.style.gridTemplateRows = `repeat(${height}, minmax(0, 1fr))`;
    boardEl.style.removeProperty("--hex-w");
    boardEl.style.removeProperty("--hex-h");
    boardEl.style.width = "";
    boardEl.style.height = "";
    boardEl.style.position = "";

    const starPoints = new Set();
    if (width >= 13 && height >= 13) {
      const s = 3, m = Math.floor(width / 2), e = width - 4;
      const sr = 3, mr = Math.floor(height / 2), er = height - 4;
      for (const r of [sr, mr, er]) for (const c of [s, m, e]) starPoints.add(r * width + c);
    } else if (width >= 9 && height >= 9) {
      const s = 2, m = Math.floor(width / 2), e = width - 3;
      const sr = 2, mr = Math.floor(height / 2), er = height - 3;
      for (const r of [sr, mr, er]) for (const c of [s, m, e]) starPoints.add(r * width + c);
    }

    for (let row = 0; row < height; row++) {
      for (let col = 0; col < width; col++) {
        const idx = row * width + col;
        const cell = document.createElement("div");
        cell.className = "cell";
        cell.dataset.idx = String(idx);
        cell.dataset.row = String(row);
        cell.dataset.col = String(col);
        if (row === 0) cell.classList.add("gk-top");
        if (row === height - 1) cell.classList.add("gk-bottom");
        if (col === 0) cell.classList.add("gk-left");
        if (col === width - 1) cell.classList.add("gk-right");
        if (starPoints.has(idx)) cell.classList.add("gk-star");
        boardEl.appendChild(cell);
        cells[idx] = cell;
      }
    }
  } else {
    boardEl.style.display = "";
    boardEl.style.flexDirection = "";
    boardEl.style.gridTemplateColumns = `repeat(${width}, minmax(0, 1fr))`;
    boardEl.style.gridTemplateRows = `repeat(${height}, minmax(0, 1fr))`;
    boardEl.style.removeProperty("--hex-w");
    boardEl.style.removeProperty("--hex-h");
    boardEl.style.width = "";
    boardEl.style.height = "";
    boardEl.style.position = "";

    for (let row = 0; row < height; row++) {
      for (let col = 0; col < width; col++) {
        const idx = row * width + col;
        const cell = document.createElement("div");
        cell.className = "cell";
        cell.dataset.idx = String(idx);
        cell.dataset.row = String(row);
        cell.dataset.col = String(col);
        boardEl.appendChild(cell);
        cells[idx] = cell;
      }
    }
  }
  updateHexPreviewState();
}

function updateCell(idx) {
  const cell = cells[idx];
  if (!cell) return;
  cell.classList.toggle("p1", board[idx] === 1);
  cell.classList.toggle("p2", board[idx] === 2);
  if (isHex() || isGomoku()) return;
  const pieceText = getGameConfig()?.pieceText;
  if (pieceText) cell.textContent = pieceText[board[idx]] || "";
}

function updateBoardUI() {
  for (let i = 0; i < board.length; i++) updateCell(i);
}

// --- Othello helpers ---
function othelloPieceName(piece) { return piece === 1 ? "Black" : "White"; }

function countOthelloPieces(arr = board) {
  let black = 0, white = 0;
  for (const cell of arr) {
    if (cell === 1) black++;
    else if (cell === 2) white++;
  }
  return { black, white };
}

// Othello winner (board side) from disc counts: 1=Black, 2=White, 0=draw.
function othelloWinnerFromCounts(black, white) {
  return black > white ? 1 : white > black ? 2 : 0;
}

function updateOthelloScore() {
  if (!scoreLine) return;
  if (!isOthello()) { scoreLine.textContent = ""; updateOthelloScoreBars(); return; }
  const { black, white } = countOthelloPieces();
  scoreLine.textContent = `Black ${black} - White ${white}`;
  updateOthelloScoreBars(black, white);
}

function updateOthelloScoreBars(black = 0, white = 0) {
  if (!othelloScoreBars) return;
  if (!isOthello()) { othelloScoreBars.classList.remove("visible"); return; }
  othelloScoreBars.classList.add("visible");
  const blackBar = othelloScoreBars.querySelector(".black-bar");
  const whiteBar = othelloScoreBars.querySelector(".white-bar");
  const blackCount = othelloScoreBars.querySelector(".black-count");
  const whiteCount = othelloScoreBars.querySelector(".white-count");
  const winnerDisplay = othelloScoreBars.querySelector(".winner-display");
  const maxPieces = width * height;
  const blackPct = (black / maxPieces) * 100;
  const whitePct = (white / maxPieces) * 100;
  if (blackBar) blackBar.style.width = `${blackPct}%`;
  if (whiteBar) whiteBar.style.width = `${whitePct}%`;
  if (blackCount) blackCount.textContent = black;
  if (whiteCount) whiteCount.textContent = white;
  if (winnerDisplay) {
    winnerDisplay.classList.remove("black-wins", "white-wins");
    if (gameOver) {
      if (black > white) { winnerDisplay.textContent = "Black wins!"; winnerDisplay.classList.add("black-wins"); }
      else if (white > black) { winnerDisplay.textContent = "White wins!"; winnerDisplay.classList.add("white-wins"); }
      else { winnerDisplay.textContent = "Draw!"; }
    } else {
      winnerDisplay.textContent = "";
    }
  }
}

function othelloFlipsForMove(row, col, piece) {
  if (board[row * width + col] !== 0) return [];
  const opp = piece === 1 ? 2 : 1;
  const flips = [];
  const dirs = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];
  for (const [dr, dc] of dirs) {
    let r = row + dr, c = col + dc;
    const line = [];
    while (r >= 0 && r < height && c >= 0 && c < width && board[r * width + c] === opp) {
      line.push(r * width + c);
      r += dr; c += dc;
    }
    if (line.length && r >= 0 && r < height && c >= 0 && c < width && board[r * width + c] === piece) {
      flips.push(...line);
    }
  }
  return flips;
}

function computeOthelloLegalMoves(piece) {
  const moves = new Map();
  for (let idx = 0; idx < board.length; idx++) {
    if (board[idx] !== 0) continue;
    const row = Math.floor(idx / width);
    const col = idx % width;
    const flips = othelloFlipsForMove(row, col, piece);
    if (flips.length) moves.set(idx, flips);
  }
  return moves;
}

function updateOthelloLegalHints() {
  if (!isOthello()) return;
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i];
    if (!cell) continue;
    cell.classList.toggle("legal", othelloLegalMoves.has(i) && !gameOver);
  }
}

function applyOthelloMove(idx, piece) {
  const row = Math.floor(idx / width);
  const col = idx % width;
  const flips = othelloLegalMoves.get(idx) || othelloFlipsForMove(row, col, piece);
  if (!flips.length) return [];
  board[idx] = piece;
  updateCell(idx);
  for (const flipIdx of flips) { board[flipIdx] = piece; updateCell(flipIdx); }
  return flips;
}

// Headless Othello helpers (for batch mode — no DOM)
function othelloFlipsForMoveHeadless(boardArr, w, h, row, col, piece) {
  if (boardArr[row * w + col] !== 0) return [];
  const opp = piece === 1 ? 2 : 1;
  const flips = [];
  const dirs = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];
  for (const [dr, dc] of dirs) {
    let r = row + dr, c = col + dc;
    const line = [];
    while (r >= 0 && r < h && c >= 0 && c < w && boardArr[r * w + c] === opp) {
      line.push(r * w + c);
      r += dr; c += dc;
    }
    if (line.length && r >= 0 && r < h && c >= 0 && c < w && boardArr[r * w + c] === piece) {
      flips.push(...line);
    }
  }
  return flips;
}

function computeOthelloLegalMovesHeadless(boardArr, w, h, piece) {
  const moves = new Set();
  for (let idx = 0; idx < boardArr.length; idx++) {
    if (boardArr[idx] !== 0) continue;
    const row = Math.floor(idx / w);
    const col = idx % w;
    if (othelloFlipsForMoveHeadless(boardArr, w, h, row, col, piece).length > 0) {
      moves.add(idx);
    }
  }
  return moves;
}

// --- Othello turn resolution ---
function resolveOthelloTurn(passNotice = "") {
  if (gameOver) return;
  let notice = passNotice;

  while (true) {
    othelloLegalMoves = computeOthelloLegalMoves(turn);
    updateOthelloLegalHints();
    updateOthelloScore();

    if (othelloLegalMoves.size > 0) {
      const msg = `${turnMessage(turn)} (${othelloPieceName(turn)})`;
      setStatus(notice ? `${notice} ${msg}` : msg);
      if (!autoPlay.batchMode) updateTranscriptPanel(); // capture any passes just added
      scheduleNextMove();
      return;
    }

    const opp = turn === 1 ? 2 : 1;
    const oppMoves = computeOthelloLegalMoves(opp);
    if (oppMoves.size === 0) {
      gameOver = true;
      othelloLegalMoves = new Map();
      updateOthelloLegalHints();
      updateOthelloScore();
      const { black, white } = countOthelloPieces();
      if (black === white) {
        setStatus(`Draw. Black ${black} - White ${white}.`);
      } else {
        const winner = black > white ? "Black" : "White";
        setStatus(`${winner} wins ${black} - ${white}.`);
      }
      onGameOver();
      return;
    }

    moveHistory.push({ pass: true, piece: turn });
    const passMsg = `${othelloPieceName(turn)} passes.`;
    notice = notice ? `${notice} ${passMsg}` : passMsg;
    turn = opp;
  }
}

// --- Highlights ---
function clearHighlights() {
  for (const idx of winningCells) {
    const cell = cells[idx];
    if (cell) cell.classList.remove("win");
  }
  winningCells = [];
}

function highlightCells(indices) {
  clearHighlights();
  for (const idx of indices) {
    const cell = cells[idx];
    if (cell) cell.classList.add("win");
  }
  winningCells = indices.slice();
}

// --- Board reset ---
function resetBoard() {
  moveGeneration++; // cancel any pending scheduled moves
  resetThinking();
  clearStatusHistory();
  board = new Array(width * height).fill(0);
  turn = 1;
  gameOver = false;
  moveHistory = [];
  othelloIllegalMoveFallbacks = 0;
  // Reset heuristic opening temperature move counters for new game
  if (Module && typeof Module._wasm_reset_heuristic_move_counts === "function")
    Module._wasm_reset_heuristic_move_counts();
  clearActivationSnapshots();
  lastModelMovePlayer = null;
  updateGraphStatsForMode();
  hideGraphTooltip();
  clearHighlights();
  buildBoardGrid();
  updateUndoState();

  if (isOthello()) {
    const mid = Math.floor(width / 2);
    board[(mid - 1) * width + (mid - 1)] = 2;
    board[mid * width + mid] = 2;
    board[(mid - 1) * width + mid] = 1;
    board[mid * width + (mid - 1)] = 1;
    updateBoardUI();
    updateOthelloScore();
    resolveOthelloTurn();
    return;
  }

  updateBoardUI();
  updateOthelloScore();
  resumeGameAfterChange();
}

// --- Win detection ---
function countDir(lastRow, lastCol, dr, dc, piece) {
  let count = 0;
  let r = lastRow + dr, c = lastCol + dc;
  while (r >= 0 && r < height && c >= 0 && c < width) {
    if (board[r * width + c] !== piece) break;
    count++; r += dr; c += dc;
  }
  return count;
}

function findWinningLine(lastRow, lastCol, piece) {
  const inBounds = (r, c) => r >= 0 && r < height && c >= 0 && c < width;
  const dirs = [[1,0],[0,1],[1,1],[1,-1]];
  for (const [dr, dc] of dirs) {
    const neg = [];
    let r = lastRow - dr, c = lastCol - dc;
    while (inBounds(r, c) && board[r * width + c] === piece) { neg.push([r, c]); r -= dr; c -= dc; }
    const pos = [];
    r = lastRow + dr; c = lastCol + dc;
    while (inBounds(r, c) && board[r * width + c] === piece) { pos.push([r, c]); r += dr; c += dc; }
    const line = neg.reverse().concat([[lastRow, lastCol]], pos);
    if (line.length >= winLength) return line.map(([rr, cc]) => rr * width + cc);
  }
  return [];
}

function checkHexWin(piece) {
  if (!Module || typeof Module._wasm_check_hex_win !== "function") return { winner: 0, path: [] };
  copyBoardToWasm();
  const maxPathLen = width * height;
  let pathPtr = 0, pathLenPtr = 0;
  try {
    pathPtr = wasmMalloc(maxPathLen * 4);   // inside try so a partial-alloc OOM frees via finally
    pathLenPtr = wasmMalloc(4);
    const winner = Module._wasm_check_hex_win(boardPtr, piece, pathPtr, pathLenPtr);
    if (winner === 0) return { winner: 0, path: [] };
    const pathLen = Module.HEAP32[pathLenPtr >> 2];
    const path = [];
    for (let i = 0; i < pathLen; i++) path.push(Module.HEAP32[(pathPtr >> 2) + i]);
    return { winner, path };
  } finally {
    if (pathPtr) Module._free(pathPtr);
    if (pathLenPtr) Module._free(pathLenPtr);
  }
}

function isDraw() { return board.every((cell) => cell !== 0); }

// --- Core game logic ---

function onGameOver() {
  // Visual batch mode: tally result and advance to next game
  if (autoPlay.batchMode && autoPlay.batchVisual) {
    // Determine winner from board state
    let winner = 0;
    if (isOthello()) {
      const { black, white } = countOthelloPieces();
      winner = othelloWinnerFromCounts(black, white);
    } else {
      // Only count as a win if there's a winning line (not a draw)
      const last = moveHistory.length ? moveHistory[moveHistory.length - 1] : null;
      if (last && !last.pass && winningCells.length > 0) winner = last.piece;
    }
    // Visual batch: P1 is always side 1, no side alternation
    tallyResult({ winner }, true);
    recordBatchGame({ moves: moveHistory.slice(), finalBoard: board.slice(), winner }, true);
    autoPlay.batchPlayed++;
    updateBatchDisplay();
    // Live per-game growth while small; throttle once large to avoid O(games²)
    // re-renders (final full render is done by finishBatch). Same metric as the
    // headless path.
    if (autoPlay.batchPlayed <= kBatchTranscriptRefreshInterval ||
        autoPlay.batchPlayed % kBatchTranscriptRefreshInterval === 0) {
      updateTranscriptPanel();
    }

    if (autoPlay.batchPlayed >= autoPlay.batchTotal || !autoPlay.batchMode) {
      finishBatch();
      return;
    }

    // Check if user unchecked "Show" — switch to headless for remaining games
    if (!batchShowGames?.checked) {
      switchToHeadlessBatch();
      return;
    }

    // Start next game after a brief pause (stored in timerId so pause can cancel)
    const gen = moveGeneration;
    autoPlay.timerId = setTimeout(() => {
      autoPlay.timerId = null;
      if (gen !== moveGeneration || !autoPlay.batchMode || !autoPlay.running) return;
      // Re-check Show toggle before starting next game
      if (!batchShowGames?.checked) {
        switchToHeadlessBatch();
        return;
      }
      resetBoard();
      scheduleAutoMove();
    }, 5000);
    return;
  }

  if (autoPlay.batchMode) return; // headless batch manages its own cleanup

  // Normal game-over: reset autoplay state
  if (autoPlay.running) {
    autoPlay.running = false;
    if (autoPlay.timerId) { clearTimeout(autoPlay.timerId); autoPlay.timerId = null; }
  }
  updateAutoplayButtons();
  setControlsDisabledDuringPlay(false);
  updatePlayerControls(1);
  updatePlayerControls(2);
  updateTranscriptPanel(); // show final result + final-position board
}

function finalizeMove(row, col, piece) {
  const idx = row * width + col;
  board[idx] = piece;
  updateCell(idx);
  moveHistory.push({ idx, piece });
  updateUndoState();

  if (isHex()) {
    const hexWinResult = checkHexWin(piece);
    if (hexWinResult.winner !== 0) {
      gameOver = true;
      highlightCells(hexWinResult.path);
      setStatus(winMessage(piece));
      updateHexPreviewState();
      onGameOver();
      return;
    }
  } else {
    const winningLine = findWinningLine(row, col, piece);
    if (winningLine.length >= winLength) {
      gameOver = true;
      highlightCells(winningLine);
      setStatus(winMessage(piece));
      onGameOver();
      return;
    }
    if (isDraw()) {
      gameOver = true;
      setStatus("Draw.");
      onGameOver();
      return;
    }
  }

  turn = turn === 1 ? 2 : 1;
  if (isOthello()) {
    resolveOthelloTurn();
  } else {
    scheduleNextMove();
  }
}

function findDropRow(col) {
  for (let row = height - 1; row >= 0; row--) {
    if (board[row * width + col] === 0) return row;
  }
  return -1;
}

function handleBoardClick(event) {
  if (!loaded || gameOver || !isHuman(turn)) return;
  if (autoPlay.batchMode) return;
  // Interacting with the live board exits batch view; render so the panel matches
  // state (otherwise copy/download could differ from what's shown).
  if (viewingBatch) { viewingBatch = false; updateTranscriptPanel(); }
  const cell = event.target.closest(".cell");
  if (!cell) return;

  const row = Number(cell.dataset.row);
  const col = Number(cell.dataset.col);

  if (isOthello()) {
    const idx = row * width + col;
    if (!othelloLegalMoves.has(idx)) return;
    const flips = applyOthelloMove(idx, turn);
    if (!flips.length) return;
    moveHistory.push({ idx, piece: turn, flips });
    updateUndoState();
    turn = turn === 1 ? 2 : 1;
    resolveOthelloTurn();
    return;
  }

  if (isTicTacToe() || isHex() || isGomoku()) {
    const idx = row * width + col;
    if (board[idx] !== 0) return;
    finalizeMove(row, col, turn);
  } else {
    const dropRow = findDropRow(col);
    if (dropRow < 0) return;
    finalizeMove(dropRow, col, turn);
  }
}

// --- Computer move ---

// Async (PLAN §9.2): the threaded model move runs OFF the main thread via the start/poll shared
// call shape (runModelSearch); the sync fallback resolves immediately. Heuristic moves stay
// synchronous (they are fast and never use the pool). Callers must `await` this (see
// runMoveWithThinking / playHeadlessGame). Stale results are rejected via moveGeneration.
async function makeMoveForPlayer(player) {
  if (!loaded || gameOver) return;
  const cfg = playerConfig[player];
  if (!cfg || cfg.type === "human") return;

  if (cfg.type === "model") {
    applyModelConfig(cfg, player);
  }

  copyBoardToWasm();
  let strength;
  let move = -1;
  // Capture the scheduler generation so a mutation that supersedes this move (new game / undo /
  // config change bumps moveGeneration) is rejected after the await instead of playing stale.
  const gen = moveGeneration;
  // Snapshot the cancel epoch too: a mutation that quiesces the pool (§9.4) bumps it before its
  // await, so a search that resolves SEARCH_OK in the same tick as a cancel is rejected below even
  // though moveGeneration hasn't advanced yet.
  const cancelEpoch = searchCancelEpoch;
  const movePlayerTurn = turn;
  // reviewer-flagged: the move-application block below reads the global `turn` rather than this
  // captured movePlayerTurn. Rejected as a no-op-today change: the `gen !== moveGeneration` guard
  // already discards any move whose turn could have advanced (every path that changes `turn` bumps
  // moveGeneration, and controls are disabled during the await), so global `turn` provably equals
  // movePlayerTurn at every application site. Rewiring only some of the mover-reads to
  // movePlayerTurn — while the turn-flip (`turn = turn===1?2:1`) must still read/write the global —
  // would leave an inconsistent split in the hot move-application path for no current benefit.

  if (cfg.type === "heuristic") {
    if (!canUseHeuristicOpponent()) {
      setError("Heuristic opponent is not available for this game.");
      return;
    }
    if (!Module || typeof Module._wasm_select_move_heuristic !== "function") {
      setError("Heuristic opponent unavailable (rebuild WASM).");
      return;
    }
    strength = Math.max(1, cfg.ply ?? getDefaultHeuristicPly());
    const t0h = performance.now();
    move = Module._wasm_select_move_heuristic(boardPtr, movePlayerTurn, strength);
    console.log(`heuristic move: ${(performance.now() - t0h).toFixed(1)}ms (ply=${strength})`);
  } else {
    strength = Math.max(0, cfg.sims ?? getDefaultModelSims());
    const t0m = performance.now();
    let res;
    try {
      res = await beginModelSearch(movePlayerTurn, strength);
    } catch (err) {
      console.error("[engine] search failed:", err);
      setError("AI search failed.");
      return;
    }
    console.log(`model move: ${(performance.now() - t0m).toFixed(1)}ms (sims=${strength}, thr=${usingThreadedEngine})`);
    // Route the terminal status (pinned-decision C): FATAL -> case-(3) reload; CANCELLED/stale ->
    // ignore (a superseding move / mutation already moved on); OK -> play the move below.
    if (res.status === SEARCH_FATAL) {
      forceFallbackReload("worker OOM / fatal during search");
      return;
    }
    if (res.status === SEARCH_CANCELLED || searchCancelEpoch !== cancelEpoch ||
        gen !== moveGeneration || gameOver) return;
    move = res.move;
  }

  // A mutation between capture and here (heuristic path can't hit this; the model path already
  // re-checked this at the status-routing block above, so for it this is a redundant no-op — but
  // guard uniformly so both paths share one barrier).
  if (gen !== moveGeneration || gameOver) return;

  // For Othello, move < 0 may indicate a pass — don't error out early
  if (move < 0 && !isOthello()) {
    setError("AI could not find a move.");
    return;
  }

  if (isOthello()) {
    if (move === OTH_PASS_MOVE || move < 0) {
      if (cfg.type === "model") captureAiActivationSnapshot(-1, -1, strength, player);
      const passingPiece = turn;
      moveHistory.push({ pass: true, piece: turn });
      updateUndoState();
      turn = turn === 1 ? 2 : 1;
      resolveOthelloTurn(`${othelloPieceName(passingPiece)} passes.`);
      return;
    }

    if (move >= board.length) {
      setError("AI selected an invalid move.");
      return;
    }

    if (!othelloLegalMoves.has(move)) {
      if (othelloIllegalMoveFallbacks < 5) {
        console.warn("AI selected illegal Othello move:", move, "falling back to first legal move");
        othelloIllegalMoveFallbacks++;
      }
      const fallback = othelloLegalMoves.keys().next().value;
      if (fallback === undefined) { setError("AI has no legal moves."); return; }
      move = fallback;
    }

    const row = Math.floor(move / width);
    const col = move % width;
    const flips = applyOthelloMove(move, turn);
    if (!flips.length) { setError("AI selected an invalid move."); return; }
    if (cfg.type === "model") captureAiActivationSnapshot(row, col, strength, player);
    moveHistory.push({ idx: move, piece: turn, flips });
    updateUndoState();
    turn = turn === 1 ? 2 : 1;
    resolveOthelloTurn();
    return;
  }

  if (isTicTacToe() || isHex() || isGomoku()) {
    const row = Math.floor(move / width);
    const col = move % width;
    if (board[row * width + col] !== 0) { setError("AI selected an invalid move."); return; }
    if (cfg.type === "model") captureAiActivationSnapshot(row, col, strength, player);
    finalizeMove(row, col, turn);
  } else {
    const dropRow = findDropRow(move);
    if (dropRow < 0) { setError("AI selected a full column."); return; }
    if (cfg.type === "model") captureAiActivationSnapshot(dropRow, move, strength, player);
    finalizeMove(dropRow, move, turn);
  }
}

// --- Undo ---

function updateUndoState() {
  if (!undoButton) return;
  undoButton.disabled = !loaded || moveHistory.length === 0 || autoPlay.batchMode;
  // Keep the transcript in sync for live play (batch updates via its own paths).
  if (!autoPlay.batchMode) updateTranscriptPanel();
}

function undoSingleMove() {
  const last = moveHistory.pop();
  if (!last) return;
  if (isOthello()) {
    if (!last.pass) {
      board[last.idx] = 0;
      updateCell(last.idx);
      const opp = last.piece === 1 ? 2 : 1;
      for (const flipIdx of last.flips || []) { board[flipIdx] = opp; updateCell(flipIdx); }
    }
  } else {
    board[last.idx] = 0;
    updateCell(last.idx);
  }
  // Decrement heuristic opening-temperature move counter for this player
  const cfg = playerConfig[last.piece];
  if (cfg?.type === "heuristic" && (!isOthello() || !last.pass) &&
      Module && typeof Module._wasm_decrement_heuristic_move_count === "function")
    Module._wasm_decrement_heuristic_move_count(last.piece);
  // Pop activation snapshot if this was a model player's move
  if (isModel(last.piece)) {
    const arr = graphActivationSnapshots[last.piece];
    if (arr?.length) {
      arr.pop();
      updateGraphStatsForMode();
      scheduleGraphRender();
    }
  }
}

function undoLastTurn() {
  if (!moveHistory.length) return;
  moveGeneration++;
  if (autoPlay.running) {
    autoPlay.running = false;
    if (autoPlay.timerId) { clearTimeout(autoPlay.timerId); autoPlay.timerId = null; }
    updateAutoplayButtons();
  }

  clearHighlights();
  gameOver = false;

  if (soleHuman() !== null) {
    // Human-vs-AI: undo AI move + human move pair
    const last = moveHistory[moveHistory.length - 1];
    if (last && !isHuman(last.piece)) {
      undoSingleMove();
      // Also undo trailing passes
      while (moveHistory.length && moveHistory[moveHistory.length - 1].pass) undoSingleMove();
      // Now undo the human move
      if (moveHistory.length && isHuman(moveHistory[moveHistory.length - 1].piece)) {
        undoSingleMove();
      }
    } else {
      undoSingleMove();
    }
  } else {
    // CvC or hotseat: undo one logical turn (placement + trailing passes)
    // First remove trailing passes
    while (moveHistory.length && moveHistory[moveHistory.length - 1].pass) undoSingleMove();
    // Then remove the actual placement
    if (moveHistory.length) undoSingleMove();
  }

  updateUndoState();
  // Derive turn from last history entry
  if (moveHistory.length > 0) {
    const lastEntry = moveHistory[moveHistory.length - 1];
    turn = lastEntry.piece === 1 ? 2 : 1;
  } else {
    turn = 1;
  }

  if (isOthello()) {
    resolveOthelloTurn();
  } else {
    resumeGameAfterChange();
  }
}

// --- Activation snapshot ---

function captureAiActivationSnapshot(row, col, sims, player) {
  if (!loaded || !Module) return;
  if (!isModel(player)) return;
  if (!graphNodes.length) return;
  if (typeof Module._wasm_evaluate_board !== "function") return;
  if (typeof Module._wasm_copy_node_activations !== "function") return;

  // Ensure WASM has the correct network active for this player
  applyModelConfig(playerConfig[player], player);

  const evalValue = Module._wasm_evaluate_board(boardPtr, player);
  const activations = copyNodeActivationsFromWasm(graphNodes.length);
  if (!activations || activations.length !== graphNodes.length) return;

  const arr = graphActivationSnapshots[player] || [];
  const snapshot = {
    moveNumber: arr.length + 1,
    moveRef: formatMoveReference(row, col),
    sims,
    eval: evalValue,
    activations,
    player,
  };
  arr.push(snapshot);
  graphActivationSnapshots[player] = arr;
  lastModelMovePlayer = player;

  updateGraphStatsForMode();
  if (graphMode === "activation") scheduleGraphRender();
}

// --- Graph data & rendering ---

function getTypeOrder(type) {
  if (type === 0) return 0;
  if (type === 2) return 2;
  return 1;
}

function updateGraphControls(maxWeight) {
  if (!graphMinWeight || !graphMinWeightValue || !graphShowDisabled) return;
  const rounded = Math.max(0.5, Math.ceil(maxWeight * 10) / 10);
  graphMinWeight.max = rounded.toFixed(1);
  graphMinWeight.value = "0";
  graphMinWeightValue.textContent = "0.00";
  graphShowDisabled.checked = true;
}

function loadGraphData() {
  graphNodes = [];
  graphConnections = [];
  graphMaxAbsWeight = 0;
  graphActivationIndexByNodeId = new Map();
  // Don't clear activation snapshots on graph reload — they are per-player

  if (!Module || !loaded) {
    graphTopologyStatsText = "No model loaded.";
    updateGraphStatsForMode();
    scheduleGraphRender();
    return;
  }

  if (typeof Module._wasm_get_node_count !== "function" ||
      typeof Module._wasm_get_connection_count !== "function" ||
      typeof Module._wasm_copy_nodes !== "function" ||
      typeof Module._wasm_copy_connections !== "function") {
    graphTopologyStatsText = "Graph exports missing (rebuild wasm).";
    updateGraphStatsForMode();
    scheduleGraphRender();
    return;
  }

  let nodeCount = 0, connCount = 0;
  try {
    nodeCount = Module._wasm_get_node_count();
    connCount = Module._wasm_get_connection_count(0);
  } catch (err) {
    console.error(err);
    graphTopologyStatsText = "Graph load failed. See console.";
    updateGraphStatsForMode();
    scheduleGraphRender();
    return;
  }
  if (nodeCount <= 0) {
    graphTopologyStatsText = "No graph data.";
    updateGraphStatsForMode();
    scheduleGraphRender();
    return;
  }

  let idsPtr = 0, typesPtr = 0, layersPtr = 0, biasPtr = 0;
  let nodeWritten = 0;
  try {
    idsPtr = wasmMalloc(nodeCount * 4);      // inside try so a partial-alloc OOM frees via finally
    typesPtr = wasmMalloc(nodeCount * 4);
    layersPtr = wasmMalloc(nodeCount * 4);
    biasPtr = wasmMalloc(nodeCount * 4);
    nodeWritten = Module._wasm_copy_nodes(idsPtr, typesPtr, layersPtr, biasPtr, nodeCount);
    const idsView = Module.HEAP32.subarray(idsPtr >> 2, (idsPtr >> 2) + nodeWritten);
    const typesView = Module.HEAP32.subarray(typesPtr >> 2, (typesPtr >> 2) + nodeWritten);
    const layersView = Module.HEAP32.subarray(layersPtr >> 2, (layersPtr >> 2) + nodeWritten);
    const biasView = Module.HEAPF32.subarray(biasPtr >> 2, (biasPtr >> 2) + nodeWritten);
    for (let i = 0; i < nodeWritten; i++) {
      graphNodes.push({ id: idsView[i], type: typesView[i], layer: layersView[i], bias: biasView[i] });
    }
    graphActivationIndexByNodeId = new Map(graphNodes.map((node, idx) => [node.id, idx]));
  } finally {
    if (idsPtr) Module._free(idsPtr);
    if (typesPtr) Module._free(typesPtr);
    if (layersPtr) Module._free(layersPtr);
    if (biasPtr) Module._free(biasPtr);
  }

  let fromPtr = 0, toPtr = 0, weightPtr = 0, enabledPtr = 0;
  let connWritten = 0;
  try {
    fromPtr = wasmMalloc(connCount * 4);     // inside try so a partial-alloc OOM frees via finally
    toPtr = wasmMalloc(connCount * 4);
    weightPtr = wasmMalloc(connCount * 4);
    enabledPtr = wasmMalloc(connCount * 4);
    connWritten = Module._wasm_copy_connections(fromPtr, toPtr, weightPtr, enabledPtr, connCount, 0);
    const fromView = Module.HEAP32.subarray(fromPtr >> 2, (fromPtr >> 2) + connWritten);
    const toView = Module.HEAP32.subarray(toPtr >> 2, (toPtr >> 2) + connWritten);
    const weightView = Module.HEAPF32.subarray(weightPtr >> 2, (weightPtr >> 2) + connWritten);
    const enabledView = Module.HEAP32.subarray(enabledPtr >> 2, (enabledPtr >> 2) + connWritten);
    for (let i = 0; i < connWritten; i++) {
      const weight = weightView[i];
      graphConnections.push({ from: fromView[i], to: toView[i], weight, enabled: enabledView[i] === 1 });
      const absWeight = Math.abs(weight);
      if (absWeight > graphMaxAbsWeight) graphMaxAbsWeight = absWeight;
    }
  } finally {
    if (fromPtr) Module._free(fromPtr);
    if (toPtr) Module._free(toPtr);
    if (weightPtr) Module._free(weightPtr);
    if (enabledPtr) Module._free(enabledPtr);
  }

  updateGraphControls(graphMaxAbsWeight);
  const enabledCount = graphConnections.reduce((sum, conn) => sum + (conn.enabled ? 1 : 0), 0);
  const hiddenCount = graphNodes.filter(n => n.type === 1).length;
  graphTopologyStatsText = `Nodes ${graphNodes.length} (${hiddenCount} hidden) | Conns ${enabledCount}/${graphConnections.length}`;
  updateGraphStatsForMode();
  scheduleGraphRender();
}

// --- Graph tooltip ---

function ensureGraphTooltip() {
  if (graphTooltipEl) return graphTooltipEl;
  graphTooltipEl = document.createElement("div");
  graphTooltipEl.className = "graph-tooltip";
  document.body.appendChild(graphTooltipEl);
  return graphTooltipEl;
}

function hideGraphTooltip() {
  if (!graphTooltipEl) return;
  graphTooltipEl.classList.remove("visible");
}

function showGraphTooltip(clientX, clientY, lines) {
  const el = ensureGraphTooltip();
  el.textContent = "";
  for (const line of lines) {
    const div = document.createElement("div");
    div.textContent = line;
    el.appendChild(div);
  }
  el.style.left = `${clientX + 12}px`;
  el.style.top = `${clientY + 12}px`;
  el.classList.add("visible");
}

function handleGraphMouseMove(event) {
  if (!graphCanvas || !graphLayoutCache || !graphLayoutCache.positions || !graphNodes.length) {
    hideGraphTooltip();
    return;
  }
  const rect = graphCanvas.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  let bestNode = null, bestDist2 = Infinity;
  for (const node of graphNodes) {
    const pos = graphLayoutCache.positions.get(node.id);
    if (!pos) continue;
    const r = nodeRadiusForType(node.type) + 4;
    const dx = x - pos.x, dy = y - pos.y;
    const d2 = dx * dx + dy * dy;
    if (d2 <= r * r && d2 < bestDist2) { bestDist2 = d2; bestNode = node; }
  }
  if (!bestNode) { hideGraphTooltip(); return; }
  const lines = [
    `id ${bestNode.id} \u2022 ${formatNodeType(bestNode.type)}`,
    `layer ${bestNode.layer} \u2022 bias ${Number(bestNode.bias).toFixed(3)}`,
  ];
  if (graphMode === "activation") {
    const act = activationForNodeId(bestNode.id);
    if (act !== null && act !== undefined) lines.push(`activation ${Number(act).toFixed(3)}`);
  }
  showGraphTooltip(event.clientX, event.clientY, lines);
}

function nodeRadiusForType(type) { return type === 2 ? 7 : 6; }

function activationToColor(value) {
  const v = clamp(value, -1, 1);
  const t = Math.abs(v);
  const baseNeg = { r: 42, g: 125, b: 170 };
  const basePos = { r: 196, g: 78, b: 58 };
  const neutral = { r: 245, g: 240, b: 232 };
  const base = v >= 0 ? basePos : baseNeg;
  const r = Math.round(lerp(neutral.r, base.r, t));
  const g = Math.round(lerp(neutral.g, base.g, t));
  const b = Math.round(lerp(neutral.b, base.b, t));
  return `rgb(${r}, ${g}, ${b})`;
}

function computeGraphLayout(rect) {
  const layerMap = new Map();
  for (const node of graphNodes) {
    if (!layerMap.has(node.layer)) layerMap.set(node.layer, []);
    layerMap.get(node.layer).push(node);
  }
  const layers = Array.from(layerMap.keys()).sort((a, b) => a - b);
  for (const layer of layers) {
    layerMap.get(layer).sort((a, b) => {
      const typeDiff = getTypeOrder(a.type) - getTypeOrder(b.type);
      if (typeDiff !== 0) return typeDiff;
      return a.id - b.id;
    });
  }
  const margin = 24;
  const usableWidth = Math.max(1, rect.width - margin * 2);
  const usableHeight = Math.max(1, rect.height - margin * 2);
  const layerCount = layers.length;
  const xSpacing = layerCount > 1 ? usableWidth / (layerCount - 1) : 0;
  const positions = new Map();
  layers.forEach((layer, layerIndex) => {
    const nodes = layerMap.get(layer);
    const count = nodes.length;
    const ySpacing = count > 1 ? usableHeight / (count - 1) : 0;
    nodes.forEach((node, idx) => {
      const x = margin + layerIndex * xSpacing;
      const y = count > 1 ? margin + idx * ySpacing : rect.height / 2;
      positions.set(node.id, { x, y });
    });
  });
  return { positions };
}

function activationForNodeId(nodeId) {
  const snap = getLatestActivationSnapshot();
  if (!snap) return null;
  const idx = graphActivationIndexByNodeId.get(nodeId);
  if (idx === undefined || idx === null) return null;
  return snap.activations?.[idx] ?? null;
}

function copyNodeActivationsFromWasm(nodeCount) {
  if (!Module || typeof Module._wasm_copy_node_activations !== "function") return null;
  if (nodeCount <= 0) return null;
  const ptr = wasmMalloc(nodeCount * 4);
  try {
    const written = Module._wasm_copy_node_activations(ptr, nodeCount);
    if (written <= 0) return null;
    const view = Module.HEAPF32.subarray(ptr >> 2, (ptr >> 2) + written);
    return new Float32Array(view);
  } finally {
    Module._free(ptr);
  }
}

function renderGraph() {
  if (!graphCanvas) return;
  const ctx = graphCanvas.getContext("2d");
  const rect = graphCanvas.getBoundingClientRect();
  if (!ctx) { setGraphStats("Graph canvas unavailable."); return; }
  if (rect.width < 2 || rect.height < 2) { scheduleGraphRender(); return; }
  try {
    const dpr = window.devicePixelRatio || 1;
    const widthPx = Math.max(1, Math.floor(rect.width * dpr));
    const heightPx = Math.max(1, Math.floor(rect.height * dpr));
    graphCanvas.width = widthPx;
    graphCanvas.height = heightPx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);

    if (!graphNodes.length) {
      ctx.fillStyle = "#7a8088";
      ctx.font = "14px IBM Plex Sans, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("Load a save file to view the model graph.", rect.width / 2, rect.height / 2);
      graphLayoutCache = null;
      return;
    }

    const activationSnapshot = graphMode === "activation" ? getLatestActivationSnapshot() : null;
    if (graphMode === "activation") {
      if (!anyModelPlayer()) {
        ctx.fillStyle = "#7a8088";
        ctx.font = "14px IBM Plex Sans, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("Activation unavailable (no model player).", rect.width / 2, rect.height / 2);
        graphLayoutCache = null;
        return;
      }
      if (!activationSnapshot) {
        ctx.fillStyle = "#7a8088";
        ctx.font = "14px IBM Plex Sans, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("No model move yet.", rect.width / 2, rect.height / 2);
        graphLayoutCache = null;
        return;
      }
    }

    const { positions } = computeGraphLayout(rect);
    graphLayoutCache = { positions, width: rect.width, height: rect.height };
    const minWeight = graphMinWeight ? Number(graphMinWeight.value || 0) : 0;
    const showDisabled = graphShowDisabled ? graphShowDisabled.checked : true;

    for (const conn of graphConnections) {
      if (!showDisabled && !conn.enabled) continue;
      if (Math.abs(conn.weight) < minWeight) continue;
      const from = positions.get(conn.from);
      const to = positions.get(conn.to);
      if (!from || !to) continue;
      ctx.setLineDash(conn.enabled ? [] : [4, 4]);
      if (graphMode !== "activation") {
        const absWeight = Math.abs(conn.weight);
        const w = 0.6 + Math.min(2.8, absWeight * 1.4);
        const alpha = conn.enabled ? 0.6 : 0.25;
        ctx.lineWidth = w;
        ctx.strokeStyle = conn.weight >= 0 ? `rgba(42, 125, 170, ${alpha})` : `rgba(196, 78, 58, ${alpha})`;
      } else {
        const fromIdx = graphActivationIndexByNodeId.get(conn.from);
        const fromAct = fromIdx === undefined ? 0 : activationSnapshot.activations[fromIdx] ?? 0;
        const signal = fromAct * conn.weight;
        const absSignal = Math.abs(signal);
        const w = 0.6 + Math.min(3.2, absSignal * 2.2);
        const alphaBase = conn.enabled ? 0.20 : 0.14;
        const alpha = clamp(alphaBase + absSignal * 0.55, alphaBase, 0.78);
        ctx.lineWidth = w;
        ctx.strokeStyle = signal >= 0 ? `rgba(196, 78, 58, ${alpha})` : `rgba(42, 125, 170, ${alpha})`;
      }
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
      ctx.stroke();
    }

    const typeColors = { 0: "#2a9d8f", 1: "#e07a5f", 2: "#6a994e" };
    for (let i = 0; i < graphNodes.length; i++) {
      const node = graphNodes[i];
      const pos = positions.get(node.id);
      if (!pos) continue;
      const radius = nodeRadiusForType(node.type);
      if (graphMode !== "activation") {
        ctx.fillStyle = typeColors[node.type] || "#999";
      } else {
        const act = activationSnapshot.activations?.[i] ?? 0;
        ctx.fillStyle = activationToColor(act);
      }
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = "rgba(20, 20, 20, 0.35)";
      ctx.stroke();
    }
  } catch (err) {
    console.error(err);
    setGraphStats("Graph render failed. See console.");
  }
}

// --- Auto-play ---

function updateAutoplayButtons() {
  const headlessBusy = autoPlay.batchMode && !autoPlay.batchVisual;
  if (autoPlayBtn) autoPlayBtn.disabled = autoPlay.running || headlessBusy; // enabled when visual batch is paused
  if (autoPauseBtn) autoPauseBtn.disabled = !autoPlay.running;
  if (autoStepBtn) autoStepBtn.disabled = autoPlay.running || autoPlay.batchMode;
  if (batchBtn) {
    if (autoPlay.batchMode) {
      batchBtn.disabled = false;
      batchBtn.textContent = "Cancel";
    } else {
      batchBtn.disabled = autoPlay.running;
      batchBtn.textContent = "Batch";
    }
  }
}

// Lock the Play/Step/Pause/Batch controls. They sit OUTSIDE .player-config (so
// setControlsDisabledDuringPlay does not cover them) and each starts a path (startAutoPlay /
// startBatch / runMoveWithThinking) that rebuilds/frees the net WITHOUT quiescing first — clicking
// one while a coordinator is live, OR while a cancel is mid-quiesce, would free the net under a live
// worker (§9.4 UAF). Callers re-arm the correct states via updateAutoplayButtons() afterward.
function disableAutoplayControls() {
  if (autoPlayBtn) autoPlayBtn.disabled = true;
  if (autoStepBtn) autoStepBtn.disabled = true;
  if (autoPauseBtn) autoPauseBtn.disabled = true;
  if (batchBtn) batchBtn.disabled = true;
}

function startAutoPlay() {
  if (!loaded || !isComputerVsComputer()) return;

  // If resuming a paused visual batch and the current game ended, start next game
  if (autoPlay.batchMode && autoPlay.batchVisual && gameOver) {
    autoPlay.running = true;
    updateAutoplayButtons();
    // Trigger the next game — same logic as onGameOver's "start next" path
    resetBoard();
    scheduleAutoMove();
    return;
  }

  if (gameOver) return;
  viewingBatch = false; // a fresh CvC watch game replaces any batch view
  updateTranscriptPanel(); // switch to the live game now, not after the first move
  autoPlay.running = true;
  updateAutoplayButtons();
  setControlsDisabledDuringPlay(true);
  scheduleAutoMove();
}

function restoreBatchDelay() {
  if (autoPlay.batchPrevDelay != null) {
    autoPlay.delay = autoPlay.batchPrevDelay;
    autoPlay.batchPrevDelay = null;
    if (speedSlider) { speedSlider.value = String(autoPlay.delay); }
    if (speedLabel) { speedLabel.textContent = `${autoPlay.delay}ms`; }
  }
}

async function cancelBatch() {
  if (autoPlay.timerId) { clearTimeout(autoPlay.timerId); autoPlay.timerId = null; }
  resetThinking();
  // Preserve a visual batch's in-progress (cancelled) game so its moves stay in the
  // transcript after the batchMode/batchVisual flags are cleared below (the in-progress
  // append in buildTranscriptDoc is gated on those flags).
  if (autoPlay.batchMode && autoPlay.batchVisual && !gameOver && moveHistory.length &&
      batchTranscripts.length < kMaxBatchTranscriptGames) {
    batchTranscripts.push({ moves: moveHistory.slice(), finalBoard: board.slice(), winner: 0, p1GoesFirst: true, inProgress: true });
  }
  // Setting batchMode=false causes the headless loop to break on next iteration
  autoPlay.batchMode = false;
  autoPlay.batchVisual = false;
  autoPlay.running = false;
  // §9.4: invalidate any move already queued in runMoveWithThinking's initial rAF. A visual-batch move
  // can be waiting THERE before its search is live (activeSearch still null), so cancelAndQuiesceSearch
  // below — which no-ops on a null activeSearch — wouldn't stop it; the pending callback would then
  // start a search under freshly-re-enabled controls. Bumping the generation makes that callback bail.
  moveGeneration++;
  restoreBatchDelay();
  updateBatchDisplay();
  // §9.4: a headless/visual batch move may still be running on the pool — quiesce it BEFORE
  // re-enabling ANY control, else a config change (or a new Batch/Play) frees the net under the live
  // coordinator (use-after-free). Keep the Play/Step/Batch start controls DISABLED across the await
  // (they sit outside setControlsDisabledDuringPlay's set) so no new run can start a net rebuild
  // mid-quiesce; updateAutoplayButtons() restores them after. This also cancels the in-flight search
  // so the headless loop unwinds promptly (playHeadlessGame returns {cancelled}).
  disableAutoplayControls();
  await cancelAndQuiesceSearch();
  // Backstop: the start controls are locked above, so a new Batch/Play cannot begin during the await;
  // keep this guard anyway so any future re-entrancy can't re-enable controls over a fresh run.
  if (autoPlay.running || autoPlay.batchMode) return;
  setControlsDisabledDuringPlay(false);
  updatePlayerControls(1);
  updatePlayerControls(2);
  updateAutoplayButtons(); // restore Play/Step/Batch to their correct idle states post-quiesce
  updateTranscriptPanel(); // show the full partial batch (throttling may have skipped recent games)
}

async function pauseAutoPlay() {
  autoPlay.running = false;
  if (autoPlay.timerId) { clearTimeout(autoPlay.timerId); autoPlay.timerId = null; }
  resetThinking();
  // §9.4: invalidate any move already queued in runMoveWithThinking's initial rAF. A CvC/visual-batch
  // move can be waiting THERE before its search is live (activeSearch still null), so
  // cancelAndQuiesceSearch below no-ops and wouldn't stop it — it would then start a search AFTER
  // pause with controls re-enabled (config-change use-after-free). Bumping the generation makes that
  // pending callback bail; it also discards an in-flight move whose result would otherwise land post-pause.
  moveGeneration++;
  if (!autoPlay.batchMode) {
    // §9.4: a CvC model move may still be running on the pool. Quiesce it BEFORE re-enabling the
    // config/rank/selector controls — otherwise a config change (applyModelConfig / wasm_set_elo_rank
    // -> RebuildNetForEloRank) frees the net under the live coordinator = use-after-free. Keep the
    // Play/Step/Batch start controls DISABLED across the await too (a new run's applyModelConfig would
    // free the net mid-quiesce); updateAutoplayButtons() restores them after quiescence.
    disableAutoplayControls();
    await cancelAndQuiesceSearch();
    // Backstop: the start controls are locked above, so a Play/Batch cannot begin during the await;
    // keep this guard for any future re-entrancy that could re-enable controls over a fresh search.
    if (autoPlay.running || autoPlay.batchMode) return;
    setControlsDisabledDuringPlay(false);
    updatePlayerControls(1);
    updatePlayerControls(2);
    updateAutoplayButtons();
  } else {
    // Visual-batch pause: keep batchMode so Play can resume; just refresh the button states (Play
    // becomes enabled). No cross-await quiesce here — the batch stays armed and resumes via startAutoPlay.
    updateAutoplayButtons();
  }
}

function stepAutoPlay() {
  if (!loaded || gameOver || !isComputerVsComputer()) return;
  viewingBatch = false;
  updateTranscriptPanel(); // switch to the live game now, not after the step resolves
  moveGeneration++; // invalidate any prior pending step
  runMoveWithThinking(turn, moveGeneration).catch(e => setError(e?.message || String(e)));
}

function updateBatchDisplay() {
  if (!batchScoreEl) return;
  if (!autoPlay.batchMode && autoPlay.batchPlayed === 0) {
    batchScoreEl.textContent = "";
    return;
  }
  const { p1, draws, p2 } = autoPlay.score;
  const total = p1 + draws + p2;
  const pct = total > 0 ? (n) => `${((n / total) * 100).toFixed(0)}%` : () => "";
  const progress = autoPlay.batchMode ? ` (${autoPlay.batchPlayed}/${autoPlay.batchTotal})` : "";
  batchScoreEl.textContent = total > 0
    ? `P1: ${p1} (${pct(p1)}) / Draw: ${draws} (${pct(draws)}) / P2: ${p2} (${pct(p2)})${progress}`
    : "";
}

// --- Batch mode ---

function startBatch(numGames, visual) {
  autoPlay.batchMode = true;
  autoPlay.batchVisual = visual;
  autoPlay.batchTotal = numGames;
  autoPlay.batchPlayed = 0;
  autoPlay.score = { p1: 0, draws: 0, p2: 0 };
  autoPlay.batchPrevDelay = autoPlay.delay;
  // Fresh batch transcript; the panel now tracks the batch instead of a live game.
  batchTranscripts = [];
  batchOmittedGames = 0;
  viewingBatch = true;
  updateTranscriptPanel();
  updateAutoplayButtons();
  setControlsDisabledDuringPlay(true);
  updateBatchDisplay();

  if (visual) {
    switchToVisualBatch();
  } else {
    runHeadlessBatch();
  }
}

function switchToVisualBatch() {
  autoPlay.batchVisual = true;
  autoPlay.running = true;
  updateAutoplayButtons();
  setControlsDisabledDuringPlay(true);
  resetBoard();
  // resetBoard → resumeGameAfterChange → scheduleNextMove → scheduleAutoMove
}

function switchToHeadlessBatch() {
  autoPlay.batchVisual = false;
  autoPlay.running = false;
  if (autoPlay.timerId) { clearTimeout(autoPlay.timerId); autoPlay.timerId = null; }
  updateAutoplayButtons();
  runHeadlessBatch();
}

async function runHeadlessBatch() {
  try {
    while (autoPlay.batchPlayed < autoPlay.batchTotal && autoPlay.batchMode) {
      // Check if user toggled "Show" on — switch to visual
      if (batchShowGames?.checked) {
        switchToVisualBatch();
        return; // control continues via onGameOver callbacks
      }
      const p1GoesFirst = (autoPlay.batchPlayed % 2 === 0);
      const result = await playHeadlessGame(p1GoesFirst);
      // A cancelled game (mutation quiesced the pool mid-search, §9.4) or a FATAL (worker OOM →
      // forceFallbackReload pending) is not a real result — stop the batch immediately WITHOUT
      // tallying or arming another game (the finally re-finalizes UI; a FATAL reload supersedes it).
      if (result.cancelled || result.fatal) return;
      tallyResult(result, p1GoesFirst);
      recordBatchGame(result, p1GoesFirst);
      autoPlay.batchPlayed++;
      updateBatchDisplay();
      // Live growth while the list is small, then throttle (mirrors the visual path);
      // avoids the panel sitting on "(Batch starting…)" through the first N games.
      if (autoPlay.batchPlayed <= kBatchTranscriptRefreshInterval ||
          autoPlay.batchPlayed % kBatchTranscriptRefreshInterval === 0) updateTranscriptPanel();
      await new Promise(r => setTimeout(r, 0));
    }
  } finally {
    // Only finalize if we're still in headless mode (not switched to visual).
    // finishBatch() does the final transcript render.
    if (!autoPlay.batchVisual) {
      finishBatch();
    }
  }
}

function finishBatch() {
  autoPlay.batchMode = false;
  autoPlay.batchVisual = false;
  autoPlay.running = false;
  restoreBatchDelay();
  // A load that failed destructively mid-batch calls enterNoSaveState (loaded=false, engine destroyed);
  // runHeadlessBatch's finally then races HERE afterward. Without the `loaded` guard, restoring the play
  // controls / running resetBoard would revive New Game, Swap and the config selects over a dead engine
  // (mirrors the setSearchInFlight release guard). Skip the UI-restore tail when unloaded — the no-save
  // state owns the controls; the partial-batch transcript below still renders either way.
  if (loaded) {
    updateAutoplayButtons();
    setControlsDisabledDuringPlay(false);
    updatePlayerControls(1);
    updatePlayerControls(2);
    updateBatchDisplay();
    resetBoard();
  }
  // resetBoard (non-Othello) clears viewingBatch via resumeGameAfterChange; re-assert so
  // the completed batch transcript stays visible/copyable, then do the final render.
  viewingBatch = true;
  updateTranscriptPanel();
}

async function playHeadlessGame(p1GoesFirst) {
  // Reset the global board for the headless game
  board = new Array(width * height).fill(0);
  // Reset heuristic opening temperature counters
  if (Module && typeof Module._wasm_reset_heuristic_move_counts === "function")
    Module._wasm_reset_heuristic_move_counts();

  // Othello initial setup
  if (isOthello()) {
    const mid = Math.floor(width / 2);
    board[(mid - 1) * width + (mid - 1)] = 2;
    board[mid * width + mid] = 2;
    board[(mid - 1) * width + mid] = 1;
    board[mid * width + (mid - 1)] = 1;
  }

  // Map UI slots to board sides
  // If p1GoesFirst: P1 config = side 1, P2 config = side 2
  // If !p1GoesFirst: P1 config = side 2, P2 config = side 1
  const sideToSlot = p1GoesFirst ? { 1: 1, 2: 2 } : { 1: 2, 2: 1 };

  let currentTurn = 1;
  let moveCount = 0;
  const maxMoves = 300; // safety guard (Othello: up to ~60 placements + passes)

  // Collect a transcript of this game (board-side moves) for the transcript panel.
  const moves = [];
  const done = (winner) => ({ winner, moves, finalBoard: board.slice() });

  while (moveCount < maxMoves) {
    const slot = sideToSlot[currentTurn];
    const cfg = playerConfig[slot];

    if (cfg.type === "model") applyModelConfig(cfg, slot);

    copyBoardToWasm();
    let move;

    if (cfg.type === "heuristic") {
      const strength = Math.max(1, cfg.ply ?? getDefaultHeuristicPly());
      move = Module._wasm_select_move_heuristic(boardPtr, currentTurn, strength);
    } else {
      const strength = Math.max(0, cfg.sims ?? getDefaultModelSims());
      // Route through the shared async call shape so the threaded engine runs OFF the main thread
      // here too (a headless batch otherwise freezes the tab per move). beginModelSearch registers
      // the in-flight search so a mid-batch save-load awaits pool quiescence (§9.4).
      const cancelEpoch = searchCancelEpoch;
      const res = await beginModelSearch(currentTurn, strength);
      if (res.status === SEARCH_FATAL) {
        forceFallbackReload("worker OOM / fatal during headless search");
        // Sentinel (not done(0)): the reload supersedes the game, but returning a {winner:0} result
        // would make runHeadlessBatch tally a phantom draw + bump batchPlayed before the page
        // unloads. The batch driver bails on {fatal:true} the same way it does on {cancelled:true}.
        return { fatal: true };
      }
      // A CANCELLED search — or an OK result whose cancel epoch advanced during the await — means a
      // mutation is quiescing the pool (save-load / cancelBatch / New Game). res.move is a
      // degraded/superseded value — playing it would push a false Othello pass and the loop could
      // arm ANOTHER search before wasm_load_save frees the net (the UAF the §9.4 barrier must
      // prevent). Abort this game and signal the batch driver to stop WITHOUT tallying, mirroring
      // makeMoveForPlayer's bail on CANCELLED (app.js §makeMoveForPlayer).
      if (res.status === SEARCH_CANCELLED || searchCancelEpoch !== cancelEpoch)
        return { cancelled: true };
      move = res.move;
    }

    if (isOthello()) {
      // Handle pass (OTH_PASS_MOVE) or engine error (negative)
      if (move < 0) {
        console.warn("Headless Othello: engine returned", move, "for side", currentTurn);
        // Treat as pass — the legal move check below would handle it anyway
      }
      if (move === OTH_PASS_MOVE || move < 0) {
        moves.push({ pass: true, piece: currentTurn });
        // Check if opponent has moves
        const opp = currentTurn === 1 ? 2 : 1;
        const oppMoves = computeOthelloLegalMovesHeadless(board, width, height, opp);
        if (oppMoves.size === 0) {
          // Double pass — game over
          const { black, white } = countOthelloPieces();
          return done(othelloWinnerFromCounts(black, white));
        }
        currentTurn = opp;
        moveCount++;
        continue;
      }

      // Validate and apply
      const legal = computeOthelloLegalMovesHeadless(board, width, height, currentTurn);
      if (!legal.has(move)) {
        // Fall back to first legal move
        const fallback = legal.values().next().value;
        if (fallback === undefined) {
          // No legal moves — pass
          moves.push({ pass: true, piece: currentTurn });
          currentTurn = currentTurn === 1 ? 2 : 1;
          moveCount++;
          continue;
        }
        move = fallback;
      }

      const row = Math.floor(move / width);
      const col = move % width;
      const flips = othelloFlipsForMoveHeadless(board, width, height, row, col, currentTurn);
      board[move] = currentTurn;
      for (const f of flips) board[f] = currentTurn;
      moves.push({ idx: move, piece: currentTurn });
      currentTurn = currentTurn === 1 ? 2 : 1;
      moveCount++;

      // Check if next player or either player can move
      const nextMoves = computeOthelloLegalMovesHeadless(board, width, height, currentTurn);
      if (nextMoves.size === 0) {
        const otherMoves = computeOthelloLegalMovesHeadless(board, width, height, currentTurn === 1 ? 2 : 1);
        if (otherMoves.size === 0) {
          // Game over
          const { black, white } = countOthelloPieces();
          return done(othelloWinnerFromCounts(black, white));
        }
        // Current player passes, switch to other
        moves.push({ pass: true, piece: currentTurn });
        currentTurn = currentTurn === 1 ? 2 : 1;
      }
      continue;
    }

    // Non-Othello games
    if (move < 0) return done(0); // shouldn't happen

    let row, col;
    if (isConnect4()) {
      // move is a column for C4
      col = move;
      row = -1;
      for (let r = height - 1; r >= 0; r--) {
        if (board[r * width + col] === 0) { row = r; break; }
      }
      if (row < 0) return done(0); // full column
    } else {
      row = Math.floor(move / width);
      col = move % width;
    }

    board[row * width + col] = currentTurn;
    moves.push({ idx: row * width + col, piece: currentTurn });
    moveCount++;

    // Check win
    if (isHex()) {
      copyBoardToWasm();
      const hexResult = checkHexWin(currentTurn);
      if (hexResult.winner !== 0) return done(currentTurn);
    } else {
      // Check winning line
      const inBounds = (r, c) => r >= 0 && r < height && c >= 0 && c < width;
      const dirs = [[1,0],[0,1],[1,1],[1,-1]];
      let won = false;
      for (const [dr, dc] of dirs) {
        let count = 1;
        let r = row + dr, c = col + dc;
        while (inBounds(r, c) && board[r * width + c] === currentTurn) { count++; r += dr; c += dc; }
        r = row - dr; c = col - dc;
        while (inBounds(r, c) && board[r * width + c] === currentTurn) { count++; r -= dr; c -= dc; }
        if (count >= winLength) { won = true; break; }
      }
      if (won) return done(currentTurn);

      // Check draw
      if (board.every(cell => cell !== 0)) return done(0);
    }

    currentTurn = currentTurn === 1 ? 2 : 1;
  }

  // Max moves reached
  if (isOthello()) {
    const { black, white } = countOthelloPieces();
    return done(othelloWinnerFromCounts(black, white));
  }
  return done(0);
}

function tallyResult(result, p1GoesFirst) {
  if (result.winner === 0) {
    autoPlay.score.draws++;
  } else {
    // Map board-side winner to UI slot
    const winnerSlot = p1GoesFirst
      ? (result.winner === 1 ? 1 : 2)  // P1 was side 1
      : (result.winner === 1 ? 2 : 1); // P1 was side 2
    if (winnerSlot === 1) autoPlay.score.p1++;
    else autoPlay.score.p2++;
  }
}

// --- Game transcript ---
//
// Builds a self-describing, LLM-friendly text log of the game(s). A game record
// is { moves, finalBoard, winner, p1GoesFirst, winLine?, inProgress? } where:
//   moves      : array of { piece, idx } | { piece, pass: true } (piece = board side 1/2)
//   finalBoard : snapshot of board[] at game end
//   winner     : board side 1/2, or 0 for a draw
//   p1GoesFirst: true if UI Player 1's config played board side 1 this game
// Coordinates: column letter a.. left→right, row number 1.. top→bottom (a1 = top-left).

// Bijective base-26 column label (a, b, ..., z, aa, ...). Boards are small so
// this is single-letter in practice, but handle wider boards safely.
function colLabel(col) {
  let s = "";
  let n = col + 1;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(97 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function cellLabel(idx) {
  const row = Math.floor(idx / width);
  const col = idx % width;
  return `${colLabel(col)}${row + 1}`;
}

// UI slot (1/2) that played a given board side this game.
function slotForSide(side, p1GoesFirst) {
  if (p1GoesFirst) return side;
  return side === 1 ? 2 : 1;
}

// Full description of a player config for the header.
function transcriptPlayerDescriptor(slot) {
  const cfg = playerConfig[slot];
  if (!cfg) return `Player ${slot}`;
  if (cfg.type === "human") return "Human";
  if (cfg.type === "heuristic") {
    return `Heuristic (ply ${cfg.ply ?? getDefaultHeuristicPly()})`;
  }
  // model
  const sims = cfg.sims ?? getDefaultModelSims();
  const file = currentSaveFileName || "(loaded save)";
  return `Model — ${file} [${bestSelectorLabel(slot)}, ${sims} sims]`;
}

// Rich one-line summary of the loaded save (cycles / mode / topology / Elo).
function transcriptSaveLine() {
  if (!Module || !loaded) return "";
  const bits = [];
  try {
    if (typeof Module._wasm_get_cycles === "function")
      bits.push(`cycles ${fmtCycles(Number(Module._wasm_get_cycles()))}`);
    if (trainingMode) bits.push(`mode ${trainingMode}`);
    if (typeof Module._wasm_get_population === "function")
      bits.push(`pop ${Module._wasm_get_population()}`);
    if (typeof Module._wasm_get_best_elo === "function")
      bits.push(`best Elo ${Number(Module._wasm_get_best_elo()).toFixed(1)}`);
    if (typeof Module._wasm_get_best_hidden === "function")
      bits.push(`hidden ${Module._wasm_get_best_hidden()}`);
    if (typeof Module._wasm_get_best_nodes === "function") {
      const ce = typeof Module._wasm_get_best_connections_enabled === "function"
        ? Module._wasm_get_best_connections_enabled() : "?";
      const ct = typeof Module._wasm_get_best_connections_total === "function"
        ? Module._wasm_get_best_connections_total() : "?";
      const layers = typeof Module._wasm_get_best_layers === "function"
        ? Module._wasm_get_best_layers() + 1 : "?";
      bits.push(`nodes ${Module._wasm_get_best_nodes()}`, `conns ${ce}/${ct}`, `layers ${layers}`);
    }
  } catch (err) {
    console.warn("transcriptSaveLine failed:", err);
  }
  return bits.join(" • ");
}

function transcriptHeader() {
  const gcfg = getGameConfig();
  const rule = gcfg?.rulesLabel?.(winLength) || (isOthello() ? "disc majority" : `win ${winLength}`);
  const lines = [];
  lines.push(`# learnTTT game transcript`);
  lines.push(`# Generated ${new Date().toLocaleString()}`);
  lines.push(`Game: ${getGameName()} — ${width}x${height}, ${rule}`);
  const saveLine = transcriptSaveLine();
  if (saveLine) lines.push(`Save: ${currentSaveFileName || "(loaded save)"} • ${saveLine}`);
  lines.push(`Player 1: ${transcriptPlayerDescriptor(1)}`);
  lines.push(`Player 2: ${transcriptPlayerDescriptor(2)}`);
  lines.push(`Coords: column letter a-${colLabel(width - 1)} left->right, row 1-${height} top->bottom (a1 = top-left). Side 1 always moves first.`);
  if (isOthello()) lines.push(`Othello: "pass" = no legal move; game ends on two consecutive passes.`);
  return lines.join("\n");
}

// ASCII render of a final/current position. X = board side 1, O = board side 2.
function renderBoardAscii(arr, p1GoesFirst, label) {
  const slotSide1 = slotForSide(1, p1GoesFirst);
  const slotSide2 = slotForSide(2, p1GoesFirst);
  const lines = [];
  lines.push(`${label} (X = side 1 ${sideColorName(1)}/P${slotSide1}, O = side 2 ${sideColorName(2)}/P${slotSide2}, . = empty):`);
  const rowNumW = String(height).length;
  const colW = colLabel(width - 1).length; // widest column label (1 for boards ≤26 wide)
  let header = " ".repeat(rowNumW + 1);
  for (let c = 0; c < width; c++) header += colLabel(c).padEnd(colW) + " ";
  lines.push(header.replace(/\s+$/, ""));
  for (let r = 0; r < height; r++) {
    let row = String(r + 1).padStart(rowNumW) + " ";
    for (let c = 0; c < width; c++) {
      const v = arr[r * width + c];
      row += (v === 1 ? "X" : v === 2 ? "O" : ".").padEnd(colW) + " ";
    }
    lines.push(row.replace(/\s+$/, ""));
  }
  return lines.join("\n");
}

function transcriptResultLine(rec) {
  const w = rec.winner;
  const othelloScore = () => {
    const { black, white } = countOthelloPieces(rec.finalBoard);
    return `Black ${black}, White ${white}`;
  };
  if (!w) {
    return isOthello() ? `Draw — ${othelloScore()}` : "Draw";
  }
  const slot = slotForSide(w, rec.p1GoesFirst);
  const who = `P${slot} (${sideColorName(w)})`;
  if (isOthello()) return `${who} wins — ${othelloScore()}`;
  const lineInfo = rec.winLine?.length ? ` — line ${rec.winLine.map(cellLabel).join("-")}` : "";
  return `${who} wins${lineInfo}`;
}

function composeGameSection(rec, index, total) {
  const lines = [];
  const slotSide1 = slotForSide(1, rec.p1GoesFirst);
  const slotSide2 = slotForSide(2, rec.p1GoesFirst);
  if (total > 1) lines.push(`=== Game ${index + 1} of ${total} ===`);
  lines.push(`P${slotSide1} (${sideColorName(1)}) moves first vs P${slotSide2} (${sideColorName(2)})`);

  const numW = String(Math.max(1, rec.moves.length)).length;
  rec.moves.forEach((m, i) => {
    const slot = slotForSide(m.piece, rec.p1GoesFirst);
    const label = `P${slot} (${sideColorName(m.piece)})`;
    const coord = m.pass ? "pass" : cellLabel(m.idx);
    lines.push(`  ${String(i + 1).padStart(numW)}. ${label.padEnd(13)} ${coord}`);
  });
  if (rec.moves.length === 0) lines.push("  (no moves yet)");

  if (rec.inProgress) {
    lines.push("Result: (game in progress)");
    lines.push(renderBoardAscii(rec.finalBoard, rec.p1GoesFirst, "Current position"));
  } else {
    lines.push(`Result: ${transcriptResultLine(rec)}`);
    lines.push(renderBoardAscii(rec.finalBoard, rec.p1GoesFirst, "Final position"));
  }
  return lines.join("\n");
}

// Build a record for the current live (non-batch) game from global state.
function liveGameRecord() {
  let winner = 0;
  let winLine = null;
  if (gameOver) {
    if (isOthello()) {
      const { black, white } = countOthelloPieces();
      winner = othelloWinnerFromCounts(black, white);
    } else if (winningCells.length) {
      const lastPlaced = [...moveHistory].reverse().find(m => !m.pass);
      winner = lastPlaced ? lastPlaced.piece : 0;
      winLine = winningCells.slice();
    }
  }
  return {
    moves: moveHistory.slice(),
    finalBoard: board.slice(),
    winner,
    p1GoesFirst: true, // live interactive game: P1 config is always board side 1
    winLine,
    inProgress: !gameOver,
  };
}

function buildTranscriptDoc() {
  if (!loaded) return "No save loaded.";
  let records;
  if (viewingBatch) {
    records = batchTranscripts.slice();
    // Append the in-progress visual-batch game so the panel stays live mid-game.
    if (autoPlay.batchMode && autoPlay.batchVisual && !gameOver && moveHistory.length) {
      records.push({ moves: moveHistory.slice(), finalBoard: board.slice(), winner: 0, p1GoesFirst: true, inProgress: true });
    }
    if (records.length === 0) return transcriptHeader() + "\n\n(Batch starting…)";
  } else {
    records = [liveGameRecord()];
  }
  const total = records.length;
  const sections = records.map((r, i) => composeGameSection(r, i, total));
  let doc = `${transcriptHeader()}\n\n${sections.join("\n\n")}`;
  if (viewingBatch && batchOmittedGames > 0) {
    doc += `\n\n(… ${batchOmittedGames} further game(s) played but omitted; transcript capped at ${kMaxBatchTranscriptGames} games.)`;
  }
  return doc;
}

function updateTranscriptPanel() {
  if (!transcriptTextEl) return;
  const doc = buildTranscriptDoc();
  transcriptTextEl.textContent = doc;
  const hasContent = loaded && doc && doc !== "No save loaded.";
  if (copyTranscriptBtn) copyTranscriptBtn.disabled = !hasContent;
  if (downloadTranscriptBtn) downloadTranscriptBtn.disabled = !hasContent;
}

// Record one finished game into the batch transcript collection.
function recordBatchGame(result, p1GoesFirst) {
  if (batchTranscripts.length >= kMaxBatchTranscriptGames) {
    batchOmittedGames++;
    return;
  }
  batchTranscripts.push({
    moves: result.moves ? result.moves.slice() : [],
    finalBoard: result.finalBoard ? result.finalBoard.slice() : board.slice(),
    winner: result.winner ?? 0,
    p1GoesFirst,
  });
}

function flashTranscriptButton(btn, msg) {
  if (!btn) return;
  if (btn.dataset.flashTimer) clearTimeout(Number(btn.dataset.flashTimer));
  if (!btn.dataset.label) btn.dataset.label = btn.textContent;
  btn.textContent = msg;
  btn.dataset.flashTimer = String(setTimeout(() => {
    btn.textContent = btn.dataset.label;
    delete btn.dataset.flashTimer;
  }, 1200));
}

async function copyTranscript() {
  const text = buildTranscriptDoc();
  try {
    await navigator.clipboard.writeText(text);
    flashTranscriptButton(copyTranscriptBtn, "Copied!");
  } catch (err) {
    // Fallback for non-secure contexts / older browsers
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch (_) { ok = false; }
    document.body.removeChild(ta);
    flashTranscriptButton(copyTranscriptBtn, ok ? "Copied!" : "Copy failed");
  }
}

function transcriptFilename() {
  const base = (currentSaveFileName || "game").replace(/\.sav(?:\.zst)?$/i, "").replace(/[^\w.-]+/g, "_");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `transcript-${base}-${stamp}.txt`;
}

function downloadTranscript() {
  const text = buildTranscriptDoc();
  const blob = new Blob([text], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = transcriptFilename();
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// --- Save loading ---

async function loadSaveFile(file) {
  // Defense-in-depth (§9.4): invalidate any pending scheduled move and stop the autoplay timer up
  // front, BEFORE the async decode below (file.arrayBuffer / the fzstd import await). A control left
  // live across those awaits could otherwise arm a fresh coordinator on the OLD gState.cnnNet, which
  // wasm_load_save then frees/replaces — a use-after-free. Callers today also gate this (saveInput is
  // disabled during play), so this makes loadSaveFile self-safe rather than relying on that invariant.
  // Staleness token: a SECOND loadSaveFile (a quick re-pick) bumps moveGeneration, so this load bails
  // after each of its awaits below rather than interleaving two loads into mismatched engine/UI/filename
  // state. (cancelAndQuiesceSearch bumps searchCancelEpoch, not moveGeneration, so it won't false-fire.)
  const gen = ++moveGeneration;
  if (autoPlay.timerId) { clearTimeout(autoPlay.timerId); autoPlay.timerId = null; }
  // PLAN §9.4: quiesce any in-flight threaded search BEFORE replacing gState.cnnNet via
  // wasm_load_save — calling it under a live worker would be a use-after-free. Awaiting the search
  // Promise means every worker has destroyed its per-move Clone() and released gState.cnnNet.
  await cancelAndQuiesceSearch();
  if (gen !== moveGeneration) return { ok: false, stale: true };  // a later file pick superseded this load during the quiesce

  // Clear any auto-loaded-name indicators from URL loads
  document.querySelectorAll(".auto-loaded-name").forEach(el => el.remove());

  // Track the loaded filename — URL autoload doesn't populate saveInput.files,
  // so callers can't rely on saveInput?.files?.[0]?.name to find it.
  currentSaveFileName = file?.name || "";
  currentSaveFile = file || null;

  const buffer = await file.arrayBuffer();
  if (gen !== moveGeneration) return { ok: false, stale: true };  // superseded during the file read
  let data = new Uint8Array(buffer);
  // .sav.zst snapshots are zstd-compressed (deploy/run-sweep.sh). The WASM loader
  // only understands raw .sav bytes, and the browser's native DecompressionStream
  // has no zstd, so inflate here — magic 28 B5 2F FD — before handing bytes to WASM.
  // The zstd decoder is imported lazily so uncompressed .sav loads never fetch it.
  if (data.length >= 4 &&
      data[0] === 0x28 && data[1] === 0xB5 && data[2] === 0x2F && data[3] === 0xFD) {
    try {
      const { decompress } = await import("./fzstd.js");
      data = decompress(data);
    } catch (err) {
      console.error(err);
      const msg = `Failed to decompress .zst save: ${err?.message || err}`;
      failLoad(msg, { clearModelUi: true });
      return { ok: false, error: msg };
    }
  }
  if (gen !== moveGeneration) return { ok: false, stale: true };  // superseded during the lazy decompressor import / inflate
  // A decompressed .sav.zst can be many times its on-disk size, so this alloc can
  // fail on a large save. _malloc returns 0 on failure — writing HEAPU8 at address
  // 0 would corrupt WASM memory — so guard it and surface a normal failLoad. A
  // zero-length request may legitimately return 0, so only treat 0 as OOM when
  // data is non-empty (an empty save falls through to wasm_load_save's own error).
  let ptr = 0;
  try {
    ptr = Module._malloc(data.length);
    if (!ptr && data.length > 0) throw new Error(`could not allocate ${data.length} bytes`);
    Module.HEAPU8.set(data, ptr);
  } catch (err) {
    console.error(err);
    if (ptr) Module._free(ptr);
    // §8.3 case (2): on the fixed-heap THREADED bundle a too-large save's _malloc returns null
    // (ABORTING_MALLOC=0). No N helps — recover by reloading into the growable non-threaded bundle,
    // where the save fits. On the growable fallback bundle this is a genuine OOM -> normal failLoad.
    if (usingThreadedEngine) {
      forceFallbackReload(`save too large for fixed heap (${data.length} bytes)`);
      return { ok: false, error: "save too large for fixed heap", reloading: true };
    }
    const msg = `Out of memory loading save (${data.length} bytes): ${err?.message || err}`;
    failLoad(msg, { clearModelUi: true });
    return { ok: false, error: msg };
  }
  // §9.4: the barrier at the top of loadSaveFile quiesced the pool BEFORE the `await file.arrayBuffer()`
  // / lazy-decompressor-import awaits above — but during those awaits `loaded` stays true and the board
  // is still interactive, so a human move (or a re-armed CvC/autoplay move) can start a FRESH pool
  // search after that first barrier. wasm_load_save below frees/replaces gState.cnnNet, so quiesce AGAIN
  // here — with no await between this and the synchronous _wasm_load_save call, no new search can slip
  // in — else that load would free the net under a live worker (the UAF this barrier prevents).
  await cancelAndQuiesceSearch();
  if (gen !== moveGeneration) { Module._free(ptr); return { ok: false, stale: true }; }  // superseded during the final quiesce; drop the alloc
  let res = -1;
  try {
    if (typeof Module._wasm_load_save !== "function") throw new Error("WASM export missing: wasm_load_save");
    res = Module._wasm_load_save(ptr, data.length);
  } catch (err) {
    console.error(err);
    Module._free(ptr);
    // §8.3 case (2): a bad_alloc thrown while wasm_load_save DESERIALIZES the network on the fixed-heap
    // threaded bundle is another save-too-large OOM — the same fixed-heap failure the input-buffer
    // _malloc guard above recovers, just surfaced later. Route it through the growable-bundle reload
    // too (on the non-threaded bundle usingThreadedEngine is false -> genuine failure, normal failLoad).
    if (usingThreadedEngine) {
      forceFallbackReload(`save deserialization OOM/fatal on fixed heap: ${err?.message || err}`);
      return { ok: false, error: "save deserialization OOM on fixed heap", reloading: true };
    }
    // _wasm_load_save already destroyed the old engine state (destructive on entry) → no-save state,
    // not a plain failLoad that would leave `loaded` true and the board playing a dead engine (major).
    const msg = err?.message || "Failed to call WASM loader.";
    enterNoSaveState(msg);
    return { ok: false, error: msg, handled: true };  // enterNoSaveState already ran — don't double-invoke it in the coordinator
  }
  Module._free(ptr);

  if (res !== 0) {
    let err = "";
    try { err = Module.ccall('wasm_get_last_error', 'string', [], []); }
    catch (e) { err = getWasmString(Module._wasm_get_last_error()); }
    // _wasm_load_save ran and failed to parse → it already wiped the old engine state, so return to the
    // no-save state instead of failLoad (which would leave `loaded` true, the board interactive against a
    // destroyed engine: threaded bundle hangs the next move, fallback bundle plays false Othello passes).
    const msg = err || "Failed to load save file.";
    enterNoSaveState(msg);
    return { ok: false, error: msg, handled: true };  // enterNoSaveState already ran — don't double-invoke it in the coordinator
  }

  refreshWasmConstants();
  gameType = Module._wasm_get_game_type();
  width = Module._wasm_get_board_width();
  height = Module._wasm_get_board_height();
  winLength = Module._wasm_get_win_length();
  loaded = !!getGameConfig();
  if (!loaded) {
    failLoad("Unsupported game type.", { clearModelUi: true });
    return { ok: false, error: "Unsupported game type." };
  }

  // A prior oversized-save OOM pins this tab to the non-threaded bundle via the sessionStorage flag
  // (forceFallbackReload). Now that a save has loaded successfully on that fallback bundle, clear the
  // pin so a LATER full-page reload can retry the threaded bundle again — otherwise the whole tab
  // session stays single-threaded even for smaller saves that would fit the fixed heap. The flag only
  // needs to survive the ONE reload from OOM to a successful fallback load; a still-too-large save on
  // a subsequent reload just re-sets it and reloads once more (no infinite loop). No-op on the
  // threaded bundle (the flag is provably false there, else this bundle wouldn't have been selected).
  if (!usingThreadedEngine) {
    try { window.sessionStorage.removeItem(kForceFallbackKey); } catch (e) { /* ignore */ }
    // Symmetry with the sessionStorage clear: forceFallbackReload's private-mode branch (sessionStorage
    // unavailable) pins the fallback via a ?nothreads=oom URL param, which isFallbackForced() also reads.
    // Strip ONLY that transient OOM carry now that a save loaded on the fallback bundle, so a LATER
    // full-page reload can retry the threaded bundle — else private-mode users stay single-threaded for
    // the whole tab session. A user-set ?nothreads=1 (the documented escape hatch) is deliberately left
    // intact so an isolated-host dev who forced single-thread mode stays forced across reloads.
    try {
      const url = new URL(window.location.href);
      if (url.searchParams.get("nothreads") === kNoThreadsOomValue) {
        url.searchParams.delete("nothreads");
        window.history.replaceState(null, "", url.toString());
      }
    } catch (e) { /* ignore */ }
  }

  // Read training mode
  trainingMode = "";
  isCnnModel = false;
  if (typeof Module._wasm_get_training_mode === "function") {
    try { trainingMode = Module.ccall('wasm_get_training_mode', 'string', [], []); }
    catch (e) {
      const p = Module._wasm_get_training_mode();
      trainingMode = getWasmString(p);
    }
  }
  // Classify CNN by the direct export, once, so isFixedTopologySave()/isNeatSave() are correct for the
  // rest of this load (selector coercion, UI gating) without re-calling into wasm on every render.
  isCnnModel = (typeof Module._wasm_is_cnn === "function") ? !!Module._wasm_is_cnn() : false;

  // Initialize max elo rank
  if (typeof Module._wasm_get_max_elo_rank === "function") {
    maxEloRank = Module._wasm_get_max_elo_rank();
  } else {
    maxEloRank = Module._wasm_get_population();
  }

  // Reset player configs to defaults
  const defaultSims = getDefaultModelSims();
  const defaultPly = getDefaultHeuristicPly();
  playerConfig[1] = { type: "human", sims: defaultSims, selector: 0, eloRank: 1, ply: defaultPly };
  playerConfig[2] = { type: "model", sims: defaultSims, selector: 0, eloRank: 1, ply: defaultPly };

  // Restore from localStorage if available
  restorePlayerConfigFromStorage();

  // Apply restored config to WASM (so summary/graph reflect the correct network)
  invalidateModelConfigCache();
  const firstModel = isModel(2) ? 2 : isModel(1) ? 1 : null;
  if (firstModel) {
    applyModelConfig(playerConfig[firstModel], firstModel);
  } else if (typeof Module._wasm_set_best_selector === "function") {
    Module._wasm_set_best_selector(0);
  }

  // Update all UI
  updatePlayerControls(1);
  updatePlayerControls(2);
  updateAutoplayVisibility();
  updateGraphPlayerSelect();
  refreshModelSummary(file);
  sweepData = null; // clear stale sweep data; tryAutoLoadSweepCsv will repopulate
  currentSweepCsvName = "";
  if (sweepInfoEl) sweepInfoEl.innerHTML = ""; // clear immediately (avoid stale buttons)
  setError("");
  newGameButton.disabled = false;
  setStatus("Save loaded.");

  // Stop any running autoplay or batch (await: they quiesce the pool before re-enabling controls)
  if (autoPlay.batchMode) {
    await cancelBatch();
  } else {
    await pauseAutoPlay();
  }
  autoPlay.batchPlayed = 0;
  autoPlay.score = { p1: 0, draws: 0, p2: 0 };
  updateBatchDisplay();
  // Discard any prior batch transcript; the panel tracks the freshly loaded game.
  batchTranscripts = [];
  batchOmittedGames = 0;
  viewingBatch = false;

  resetBoard();
  loadGraphData();

  // Hide graph panel for fixed-topology strategies (AZ, TD-Lambda)
  const graphPanel = document.querySelector(".graph-panel");
  if (graphPanel) {
    graphPanel.style.display = isFixedTopologySave() ? "none" : "";
  }

  // Auto-load matching sweep CSV (try ../saves/<basename>-sweep.csv). Skipped in demo mode: its
  // `../saves/` fetch is exactly the sibling coupling the demo severs (the gate lives inside
  // tryAutoLoadSweepCsv, so it holds no matter which caller reaches this tail, §2).
  tryAutoLoadSweepCsv(file.name);
  // Explicit success signal the demo controller awaits (§2): loadSaveFile otherwise returns undefined
  // on BOTH success and every failure path, so success can't be inferred from state.
  return { ok: true };
}

// PBT slot id from a per-slot save filename (e.g. `-pbt03.sav` → 3). Returns
// null when the filename isn't a PBT slot save. Uses `\d+` so slot ≥ 100 is
// handled (DerivePbtSlotSavePath uses {:02} minimum-width formatting).
function getCurrentPbtSlot(filename) {
  if (!filename) return null;
  // Tolerate an optional trailing `.zst` so compressed per-slot snapshots
  // (`-pbtNN.sav.zst`) are still recognized as PBT slots.
  const m = filename.match(/-pbt(\d+)\.sav(?:\.zst)?$/);
  return m ? parseInt(m[1], 10) : null;
}

// Group a parsed sweep CSV by slot, returning latest BvH row per slot, plus the
// champion (max latest aggregate_pct) and the loaded slot's row if present.
// Returns null when the CSV has no rows with a `slot` column populated (so the
// caller falls through to the single-agent path). When some slots have samples
// but the currently-loaded slot does not, returns a populated object with
// `currentSlotPct: null` — the panel still renders so the user can navigate
// to a champion or another slot.
function getPbtChampion(sweepRows, currentSlot) {
  if (!Array.isArray(sweepRows) || sweepRows.length === 0) return null;
  const slotRows = sweepRows.filter(
    r => r.slot !== undefined && r.slot !== "" && r.champion === "bvh");
  if (slotRows.length === 0) return null;
  // Latest-cycle row per slot.
  const bySlot = new Map();
  for (const r of slotRows) {
    const slot = Number(r.slot);
    if (!Number.isFinite(slot)) continue;
    const cycles = Number(r.cycles) || 0;
    const existing = bySlot.get(slot);
    if (!existing || cycles > (Number(existing.cycles) || 0)) bySlot.set(slot, r);
  }
  if (bySlot.size === 0) return null;
  let championSlot = null;
  let championPct = -Infinity;
  const slots = [];
  for (const [slot, row] of bySlot) {
    const pct = Number(row.aggregate_pct) || 0;
    slots.push({
      slot,
      pct,
      cycles: Number(row.cycles) || 0,
      sims: Number(row.sims) || 0,
    });
    // Tie-break by lower slot id (consistent with dashboard champion choice).
    if (pct > championPct || (pct === championPct && (championSlot === null || slot < championSlot))) {
      championSlot = slot;
      championPct = pct;
    }
  }
  slots.sort((a, b) => a.slot - b.slot);
  const currentRow = currentSlot != null ? bySlot.get(Number(currentSlot)) : null;
  return {
    championSlot,
    championPct,
    championSims: Number(bySlot.get(championSlot).sims) || 0,
    currentSlotPct: currentRow ? (Number(currentRow.aggregate_pct) || 0) : null,
    slots,
  };
}

// Given a per-slot save filename and a target slot, return the corresponding
// `-pbtNN.sav` filename (preserves any directory component the caller passed in).
function pbtSwitchSaveName(filename, slot) {
  const slotStr = String(slot).padStart(2, "0");
  // Preserve an optional trailing `.zst` so navigating between compressed
  // per-slot snapshots keeps resolving to real `-pbtNN.sav.zst` files.
  return filename.replace(/-pbt\d+\.sav(\.zst)?$/, "-pbt" + slotStr + ".sav$1");
}

async function tryAutoLoadSweepCsv(saveName) {
  if (!saveName) return;
  // Demo mode severs the `../saves/` sibling coupling: never fetch the dev-app sweep CSV. The gate
  // lives HERE (not at the call site) because loadSaveFile() calls this unconditionally at its tail,
  // and the demo must call loadSaveFile() (§2).
  if (demoMode) return;
  // Strip .sav, then strip checkpoint suffix like -005.0M or -5M.
  // Strip .sav (and an optional trailing .zst for compressed snapshots), then
  // strip a checkpoint suffix like -005.0M or -5M.
  let base = saveName.replace(/\.sav(?:\.zst)?$/, "").replace(/-\d+(?:\.\d+)?M$/, "");
  // PBT per-slot save: rewrite `<base>-pbtNN` → `<base>-pbt`. Population-level
  // sweep CSV is `<base>-pbt-sweep.csv`. `\d+` (not `\d{2}`) so slot 100+ is
  // handled correctly. Falls through to the single-agent path otherwise.
  base = base.replace(/-pbt\d+$/, "-pbt");
  const sweepName = base + "-sweep.csv";
  const sweepPath = "../saves/" + sweepName;
  const gen = moveGeneration; // guard against stale fetch if user loads another save
  try {
    const resp = await fetch(sweepPath);
    if (!resp.ok) return; // no sweep file — that's fine
    if (gen !== moveGeneration) return; // stale — a new save was loaded
    const text = await resp.text();
    if (gen !== moveGeneration) return; // stale
    sweepData = parseSweepCsv(text);
    currentSweepCsvName = sweepName;
    // §9.4: updateSweepInfo(true) may auto-apply the BvH champion, which for NEAT saves rebuilds the
    // active net (applyModelConfig -> wasm_set_elo_rank). This runs after an async fetch, so a model
    // opening-move search may already be in flight — quiesce it first so the net isn't freed under a
    // live coordinator. If we cancelled a pending opening move, re-drive it with the champion config.
    const hadInFlightSearch = activeSearch != null;
    await cancelAndQuiesceSearch();
    if (gen !== moveGeneration) return; // stale — a new save loaded during the quiesce
    updateSweepInfo(true); // auto-apply BvH champion on save-load
    if (hadInFlightSearch && loaded && !gameOver) resumeGameAfterChange();
    // Show the auto-loaded sweep filename
    if (sweepFileInput) {
      const label = sweepFileInput.closest("label");
      if (label) {
        let nameEl = label.querySelector(".auto-loaded-name");
        if (!nameEl) {
          nameEl = document.createElement("span");
          nameEl.className = "auto-loaded-name";
          label.appendChild(nameEl);
        }
        nameEl.textContent = sweepName;
      }
    }
  } catch (e) {
    // Sweep CSV auto-load is best-effort
  }
}

// --- localStorage persistence ---

function savePlayerConfigToStorage() {
  try {
    for (const p of [1, 2]) {
      const cfg = playerConfig[p];
      localStorage.setItem(lsKey(`learntttP${p}Type`), cfg.type);
      localStorage.setItem(lsKey(`learntttP${p}Sims`), String(cfg.sims));
      localStorage.setItem(lsKey(`learntttP${p}Selector`), String(cfg.selector));
      localStorage.setItem(lsKey(`learntttP${p}EloRank`), String(cfg.eloRank));
      // ply is not persisted — it's game-specific and uses the game config default
    }
    localStorage.setItem(lsKey("learntttAutoDelay"), String(autoPlay.delay));
  } catch (e) { /* localStorage unavailable */ }
}

function restorePlayerConfigFromStorage() {
  try {
    // Legacy-key migration reads AND deletes the dev app's UN-namespaced keys, so it must NOT run in
    // demo mode (it would mutate the dev app's storage, §2). A fresh demo namespace has no legacy keys
    // anyway, so skipping it is a pure no-op there.
    if (!demoMode) {
      const oldOpponent = localStorage.getItem("learntttOpponentMode");
      const oldSelector = localStorage.getItem("learntttBestSelector");
      if (oldOpponent !== null && localStorage.getItem("learntttP2Type") === null) {
        const type = Number(oldOpponent) === 1 ? "heuristic" : "model";
        localStorage.setItem("learntttP2Type", type);
      }
      if (oldSelector !== null && localStorage.getItem("learntttP2Selector") === null) {
        localStorage.setItem("learntttP2Selector", oldSelector);
      }
      // Clean up old keys
      localStorage.removeItem("learntttBestSelector");
      localStorage.removeItem("learntttOpponentMode");
    }

    // One-shot per-version migration for the built-in default sim budgets. A stored
    // `learntttP{p}Sims` would otherwise pin an OLD default forever; when
    // SIMS_DEFAULTS_VERSION is bumped we clear ONLY the stored sims once so the new
    // default applies. Everything else (type/selector/eloRank) is preserved. There is
    // no provenance on the stored value, so a genuinely deliberate high pick is also
    // cleared and must be re-picked once (slider retained) — accepted tradeoff.
    if (Number(localStorage.getItem(lsKey("learntttSimsDefaultsVersion"))) !== SIMS_DEFAULTS_VERSION) {
      localStorage.removeItem(lsKey("learntttP1Sims"));
      localStorage.removeItem(lsKey("learntttP2Sims"));
      localStorage.setItem(lsKey("learntttSimsDefaultsVersion"), String(SIMS_DEFAULTS_VERSION));
    }

    for (const p of [1, 2]) {
      const type = localStorage.getItem(lsKey(`learntttP${p}Type`));
      if (type === "human" || type === "model" || type === "heuristic") {
        // Coerce: no heuristic for TTT
        if (type === "heuristic" && !canUseHeuristicOpponent()) {
          playerConfig[p].type = "model";
        } else {
          playerConfig[p].type = type;
        }
      }
      const simsStr = localStorage.getItem(lsKey(`learntttP${p}Sims`));
      if (simsStr !== null) {
        const sims = Number(simsStr);
        if (Number.isFinite(sims) && sims >= 0) playerConfig[p].sims = sims;
      }
      const selector = Number(localStorage.getItem(lsKey(`learntttP${p}Selector`)));
      if (selector >= 0 && selector <= 2) playerConfig[p].selector = selector;
      // Coerce: no selector for AZ/TD
      if (!isNeatSave()) playerConfig[p].selector = 0;
      const rank = Number(localStorage.getItem(lsKey(`learntttP${p}EloRank`)));
      if (rank >= 1 && rank <= maxEloRank) playerConfig[p].eloRank = rank;
      // Don't restore ply from localStorage — it's game-specific and should use the
      // game config default (e.g. Othello=4, Hex=1). A stored value from a different
      // game would silently apply the wrong default.

      // Sync savedEloRank for switching back to Elo mode
      savedEloRank[p] = playerConfig[p].eloRank;
    }

    const delay = Number(localStorage.getItem(lsKey("learntttAutoDelay")));
    if (delay >= 10 && delay <= 1000) autoPlay.delay = delay;
  } catch (e) { /* localStorage unavailable */ }
}

// --- Demo API (window.__demo) — the thin, additive seam demo.js drives (§7 Phase 2) ---
// Every method is a wrapper over existing engine functions; the surface is intentionally tiny so
// demo.js couples to as few app.js internals as possible. window.__demo itself is assembled in init()
// (so `ready` can derive from the real ModulePromise).

// Shared serializing load coordinator. BOTH the tab-driven load (__demo.loadModel) and the Advanced
// picker's loadSaveFile() handler route through this one chain, so a fast tab switch or a manual
// Advanced load can't overlap and clobber each other's wasm write. The token guards the ENTIRE
// loadSaveFile op — loadSaveFile awaits arrayBuffer() + lazy decompression AFTER the fetch, so a bare
// fetch-generation counter would be insufficient (a stale load could still reach wasm) (§7 Phase 2).
let demoLoadChain = Promise.resolve();
// Monotonic request token, bumped when a load is REQUESTED (not when queued work starts). A newer
// request supersedes any still-queued older one, so an obsolete load is skipped before it does expensive
// work (deserialize a large model, trigger a fixed-heap fallback reload) that the latest request undoes.
// loadSaveFile's own moveGeneration token only advances once a load STARTS, so it can't mark a queued
// predecessor stale — this request-time token can (§7 Phase 2).
let demoLoadRequestSeq = 0;
// reviewer-flagged (#6 "Set-based pub/sub for a single always-one subscriber — could be a nullable
// callback"): KEPT as a Set. onLoadResult is part of the published window.__demo seam (a documented,
// stable contract), and returning an unsubscribe from a general observer registration is the conventional
// shape. Collapsing to one nullable callback would make a second subscribeToLoads() silently REPLACE the
// first instead of coexisting — a subtle footgun — for zero functional gain (the reviewer notes it is not
// a bug). The Set + copy-on-iterate + per-callback try/catch cost is trivial.
const demoLoadSubscribers = new Set();

function notifyDemoLoadResult(source, result) {
  for (const cb of [...demoLoadSubscribers]) {
    try { cb({ source, result }); } catch (e) { console.error("demo onLoadResult subscriber threw:", e); }
  }
}

// Run `loadFn` (which resolves to loadSaveFile()'s explicit result) serialized behind any in-flight
// load, normalize the result, invalidate play on a genuine failure, and fire the result subscription.
// `source` is 'tab' | 'advanced' | 'url'.
function runCoordinatedLoad(loadFn, source) {
  const token = ++demoLoadRequestSeq;
  const run = demoLoadChain.then(async () => {
    // A newer load was requested while this one waited its turn in the queue — skip the obsolete one
    // rather than deserialize a model / trip a fallback reload the latest request would just supersede.
    if (token !== demoLoadRequestSeq) {
      const stale = { ok: false, stale: true };
      notifyDemoLoadResult(source, stale);
      return stale;
    }
    let result;
    try {
      result = await loadFn();
    } catch (err) {
      // loadFn's own handled failures RETURN a result object; reaching this catch means an UNEXPECTED
      // throw (e.g. file.arrayBuffer() rejected). Outside demo mode there is no result subscriber and the
      // enterNoSaveState path below is gated off, so folding the throw into a resolved result would
      // silently swallow it — re-throw so the Advanced/URL caller's own error handling (or the runtime's
      // unhandledrejection) still fires, matching the documented "plain serialized loadSaveFile()"
      // behavior outside demo mode. In demo mode, convert it to a failure result the subscriber +
      // enterNoSaveState surface (§7 Phase 2).
      if (!demoMode) throw err;
      result = { ok: false, error: err?.message || String(err) };
    }
    // reviewer-flagged (#4 "unreachable dead code — every loadSaveFile return path is a well-formed
    // object today"), NOT taken: runCoordinatedLoad takes a GENERIC `loadFn` param, and this line is the
    // one place that guarantees `result` is an object before the downstream `result.ok/stale/reloading/
    // handled` reads and the notifyDemoLoadResult subscriber contract. Kept as intentional defense for a
    // non-object loadFn resolution — a cheap invariant, consistent with this seam's defensive style.
    if (!result || typeof result !== "object") result = { ok: result === true };
    // A newer load was REQUESTED while this one was in flight (awaiting arrayBuffer()/decompression —
    // PAST the queue-time check above). loadFn has already written to wasm, but the superseding request
    // runs next in this chain and overwrites it, so treat this now-obsolete result as stale: don't apply
    // its matchup and don't trip enterNoSaveState on a failure the newer load will replace anyway. This
    // mirrors the queued-but-not-started supersession skip above (§7 Phase 2).
    if (token !== demoLoadRequestSeq) {
      const stale = { ok: false, stale: true };
      notifyDemoLoadResult(source, stale);
      return stale;
    }
    // On a genuine failure — not a stale/superseded no-op, not a page-reloading fixed-heap recovery, and
    // not a destructive path that ALREADY entered the no-save state (result.handled) — invalidate all
    // in-flight play work and disable play. loadSaveFile's PRE-destructive failLoad paths (bad .zst, OOM,
    // unsupported type) don't call enterNoSaveState, so do it here. Gated to demo mode so the dev app
    // keeps its "old model survives a pre-load failure" behavior (§2/§7 Phase 2 — the demo deliberately
    // does not roll back to the prior model on failure).
    if (demoMode && result.ok === false && !result.stale && !result.reloading && !result.handled) {
      // §9.4: a PRE-WASM failure (bad .zst / OOM / rejected read) returns from loadSaveFile BEFORE its
      // second quiescence barrier (that barrier only runs on the success path, just above wasm_load_save).
      // A human/CvC move could have started a FRESH pool search on the still-interactive old board during
      // loadSaveFile's earlier awaits (file.arrayBuffer / lazy zstd import). enterNoSaveState below unlocks
      // the controls (graph selector etc.) SYNCHRONOUSLY, so without draining that worker first the graph
      // selector could rebuild/free the net under a live search (the UAF §9.4 guards). Quiesce here — a
      // superseding load, if any, runs next in this chain and overwrites the no-save state anyway.
      await cancelAndQuiesceSearch();
      enterNoSaveState(result.error || "Load failed.");
    }
    notifyDemoLoadResult(source, result);
    return result;
  });
  // Keep the chain alive regardless of this load's outcome — the `() => {}` rejection handler absorbs
  // the demo-mode captured results AND the re-thrown non-demo unexpected rejection so the NEXT queued
  // load still runs (the caller still sees that rejection via `return run`).
  // reviewer-flagged (#20 "demoLoadChain grows unbounded, retaining closures for page lifetime"), NOT
  // taken: this REASSIGNS demoLoadChain to a fresh promise each call — it does not append to a growing
  // list. Once a load settles, nothing references its predecessor promise (the new demoLoadChain only
  // holds the latest `run`), so each loadFn closure + its captured file are released as loads complete.
  // There is no retained-for-page-lifetime chain to prune; the premise misreads reassignment as growth.
  demoLoadChain = run.then(() => {}, () => {});
  return run;
}

// Apply the manifest matchup AFTER a successful, validated load so it wins over the localStorage restore
// (§2 ordering hazard). Sets per-side type/sims/ply (+ the NEAT champion-member pin for TTT), refreshes
// the existing controls, and starts a new game. Returns {ok} / {ok:false,error}.
function demoApplyMatchup(matchup) {
  if (!loaded) return { ok: false, error: "no model loaded" };
  const m = matchup || {};
  const coerceType = (t) => {
    if (t === "heuristic" && !canUseHeuristicOpponent()) return "model";  // TTT has no heuristic opponent
    return (t === "human" || t === "model" || t === "heuristic") ? t : "model";
  };
  for (const p of [1, 2]) {
    playerConfig[p].type = coerceType(p === 1 ? m.p1 : m.p2);
    if (typeof m.sims === "number" && m.sims >= 0) playerConfig[p].sims = m.sims;
    if (typeof m.ply === "number" && m.ply >= 1) playerConfig[p].ply = m.ply;
    // NEAT champion-member pin (TTT): overrides the localStorage-restored selector/eloRank that would
    // otherwise seat a stale member for a returning visitor (§3.1/§5). Fixed-topology nets omit it.
    // reviewer-flagged (#22 "applied to both players regardless of type"), NOT taken: seating the
    // champion member on BOTH sides is intentional — if the user later switches the human side to a
    // model the champion is already pinned; guarding on type==='model' would drop that. Selector/eloRank
    // are never read for a human player, so writing them is harmless (the finding agrees).
    if (m.neatMember && isNeatSave()) {
      if (Number.isInteger(m.neatMember.selector)) playerConfig[p].selector = m.neatMember.selector;
      if (Number.isInteger(m.neatMember.eloRank)) playerConfig[p].eloRank = m.neatMember.eloRank;
      savedEloRank[p] = playerConfig[p].eloRank;
    }
  }
  moveGeneration++;  // discard any move scheduled under the previous matchup
  invalidateModelConfigCache();
  const firstModel = isModel(2) ? 2 : isModel(1) ? 1 : null;
  if (firstModel) {
    applyModelConfig(playerConfig[firstModel], firstModel);
  } else if (typeof Module._wasm_set_best_selector === "function") {
    // Mirror loadSaveFile's config-apply else-branch: with NO model side (e.g. a Human-vs-Heuristic
    // matchup) reset the wasm best-selector to 0 so a stale selector from a prior model load can't
    // leak into a later side-flip. Inert for today's human+model manifest matchups, correct if one
    // ever ships without a model side.
    Module._wasm_set_best_selector(0);
  }
  updatePlayerControls(1);
  updatePlayerControls(2);
  updateAutoplayVisibility();
  updateGraphPlayerSelect();
  // The pin may have re-seated the NEAT champion member (selector/eloRank) AFTER loadSaveFile already
  // populated the summary + graph for the localStorage-restored member, so refresh both to show the
  // topology / statistics of the member that will actually play. Also re-evaluate activation-graph
  // availability now that player types may have flipped (e.g. all-human -> model play). Mirrors the
  // refresh applySweepRank does after an eloRank change; pass the retained File so the game-info "saved"
  // time stays accurate (the demo loads a fetched File, so saveInput.files is empty).
  refreshModelSummary(currentSaveFile || saveInput?.files?.[0]);
  loadGraphData();
  updateGraphModeAvailability();
  updatePlayInfo();
  resetBoard();  // fresh game under the applied matchup
  return { ok: true };
}

// Cross-check the loaded net against the manifest's declared game type + board variant (§5). A load can
// succeed yet be the WRONG net (mis-curation), so on a mismatch INVALIDATE the load and disable play —
// the same play-work cancellation as a failed load, but a distinct outcome from the load result itself.
// winLength is compared only where the game uses it (expected winLength > 0: TTT/C4/Gomoku).
// Returns {ok} / {ok:false, mismatch:[...]}.
function demoVerifyModel(expected) {
  const e = expected || {};
  if (!loaded) return { ok: false, mismatch: ["no model loaded"] };
  const mism = [];
  if (Number.isInteger(e.gameType) && gameType !== e.gameType) mism.push(`gameType ${gameType}!=${e.gameType}`);
  if (Number.isInteger(e.boardWidth) && width !== e.boardWidth) mism.push(`boardWidth ${width}!=${e.boardWidth}`);
  if (Number.isInteger(e.boardHeight) && height !== e.boardHeight) mism.push(`boardHeight ${height}!=${e.boardHeight}`);
  if (Number.isInteger(e.winLength) && e.winLength > 0 && winLength !== e.winLength) mism.push(`winLength ${winLength}!=${e.winLength}`);
  if (mism.length) {
    enterNoSaveState(`Model variant mismatch: ${mism.join(", ")}`);
    return { ok: false, mismatch: mism };
  }
  return { ok: true };
}

// The loaded net's identity metadata (Module is private to app.js, so demo.js can't call the getters).
function demoModelMeta() {
  return { loaded, gameType, boardWidth: width, boardHeight: height, winLength, isCnn: isCnnModel, trainingMode };
}

// --- Initialization ---

function logDetailedError(prefix, err) {
  console.error(prefix, err);
  if (err === null) console.error(prefix, "is null");
  else if (err === undefined) console.error(prefix, "is undefined");
  else {
    console.error(prefix, "Stringified:", String(err));
    if (err.stack) console.error(prefix, "Stack:", err.stack);
    if (err.message) console.error(prefix, "Message:", err.message);
    try {
      const keys = Object.getOwnPropertyNames(err);
      const details = {};
      keys.forEach(k => details[k] = err[k]);
      console.error(prefix, "Property Details:", JSON.stringify(details, null, 2));
    } catch (e) {
      console.error(prefix, "Failed to extract properties:", e);
    }
  }
}

// --- Two-bundle capability-detect loader (PLAN §8.3) ---------------------------------------------

// A case-(2)/(3) OOM reload carries this flag so the reloaded page skips the threaded upgrade.
function isFallbackForced() {
  try {
    // "1" = sticky user escape hatch; kNoThreadsOomValue = transient private-mode OOM carry.
    const nt = new URLSearchParams(window.location.search).get("nothreads");
    if (nt === "1" || nt === kNoThreadsOomValue) return true;
    return window.sessionStorage.getItem(kForceFallbackKey) === "1";
  } catch (e) { return false; }
}

// §8.3 case (2)/(3): recover a fixed-heap OOM (save too large, or N×forward-scratch OOM) by a
// GENUINE full-page reload carrying the forced-fallback flag — NOT an in-page Module swap (which
// would strand the pthread pool + shared heap and the JS-cached boardPtr / HEAP* views). The
// reloaded loader reads the flag and loads the growable non-threaded bundle, where the save/search
// fits. A URL-autoloaded save re-fetches on reload; a user-dropped File does not survive (accepted).
function forceFallbackReload(reason) {
  console.warn(`[engine] reloading into single-thread fallback bundle: ${reason}`);
  let persisted = false;
  try { window.sessionStorage.setItem(kForceFallbackKey, "1"); persisted = true; } catch (e) { /* fall through */ }
  if (persisted) { window.location.reload(); return; }
  // sessionStorage unavailable — carry the flag in the URL instead, else the reloaded page re-selects
  // the threaded bundle, re-OOMs, and loops reload->OOM forever. Use the DISTINCT ?nothreads=oom value
  // (not the user escape hatch ?nothreads=1) so a later successful fallback load can strip THIS carry
  // without clobbering a user-set opt-in. isFallbackForced() honours it, so it's a sufficient one-way
  // fallback.
  try {
    const url = new URL(window.location.href);
    url.searchParams.set("nothreads", kNoThreadsOomValue);
    window.location.replace(url.toString());
  } catch (e) {
    const sep = window.location.search ? "&" : "?";
    window.location.href =
      window.location.pathname + window.location.search + sep + "nothreads=" + kNoThreadsOomValue +
      window.location.hash;
  }
}

// Capture the engine capabilities the moment the bundle is chosen, then render the #capabilities
// indicator. `caps` is createEngineModule's feature-detect snapshot; `threadedFailed` is true only
// when the threaded bundle was selected but its instantiation/pool-init threw (so we degraded).
function updateEngineCapabilities(caps, threadedFailed) {
  const cores = (typeof navigator !== "undefined" && navigator.hardwareConcurrency) || POOL_FALLBACK_CORES;
  engineCapabilities = {
    threaded: usingThreadedEngine,
    crossOriginIsolated: caps.crossOriginIsolated === true,
    sharedArrayBuffer: caps.hasSharedArrayBuffer === true,
    forcedFallback: caps.forcedFallback === true,
    threadedFailed: !!threadedFailed,
    cores,
    // Max per-move workers = pool-1 = min(POOL_CEILING, cores); the actual N per move is <= this,
    // scaled by the sim budget (computeWorkerCount, §9.3). Shown as an "up to" ceiling.
    maxWorkers: Math.min(POOL_CEILING, Math.max(1, Math.floor(cores))),
    override: mctsThreadOverride,
  };
  renderEngineCapabilities();
}

// Why the app is single-threaded, in one human phrase (only meaningful when !threaded). Most-specific
// cause first so the message names the actual blocker the user can fix (usually: enable isolation).
function singleThreadReason(c) {
  if (c.threadedFailed) return "threaded engine failed to start";
  if (c.forcedFallback) return "forced single-thread (memory pressure or ?nothreads)";
  if (!c.crossOriginIsolated) return "cross-origin isolation not enabled by the host";
  if (!c.sharedArrayBuffer) return "SharedArrayBuffer unavailable in this browser";
  return "single-thread";
}

// Render the user-visible engine-capabilities indicator (#capabilities). Answers "what is the engine
// using": multi-thread state + worker ceiling, plus the optional capabilities the WASM build depends
// on (wasm SIMD — always compiled in; cross-origin isolation + SharedArrayBuffer — the threading
// enablers) and the detected core count. Informational only; never affects search behaviour.
function renderEngineCapabilities() {
  const el = document.getElementById("capabilities");
  if (!el || !engineCapabilities) return;
  const c = engineCapabilities;
  const yn = (b) => (b ? "✓" : "✗"); // ✓ / ✗
  let head;
  if (c.threaded) {
    const n = c.override != null ? `${c.override} (override)` : `up to ${c.maxWorkers}`;
    head = `⚙ Multi-threaded engine — ${n} worker${c.override === 1 ? "" : "s"}`;
    el.classList.add("cap-threaded");
    el.classList.remove("cap-single");
    el.title = `Multi-threaded tree-parallel MCTS active (up to ${c.maxWorkers} workers; ${c.cores} logical cores detected).`;
  } else {
    head = `⚙ Single-thread engine — ${singleThreadReason(c)}`;
    el.classList.add("cap-single");
    el.classList.remove("cap-threaded");
    el.title = "Playing single-threaded. Serve web/ with COOP/COEP headers (cross-origin isolation) "
             + "to enable the multi-core engine — see web/HOSTING.md.";
  }
  const detail = `wasm SIMD ${yn(true)} · isolated ${yn(c.crossOriginIsolated)} `
               + `· SharedArrayBuffer ${yn(c.sharedArrayBuffer)} · ${c.cores} cores`;
  el.textContent = `${head}   ·   ${detail}`;
}

// Optional one-line "multi-core acceleration unavailable" note (§8.3), shown when isolation was
// present/wanted but the app ended up single-threaded (threaded load/instantiation failed, or a
// forced-fallback reload). Never shown on a plainly non-isolated host (no multi-core was promised).
function showMultiCoreUnavailableNote() {
  try {
    if (document.getElementById("mcNote")) return;
    const note = document.createElement("div");
    note.id = "mcNote";
    note.className = "mc-note";
    note.textContent = "Multi-core acceleration unavailable — playing single-threaded.";
    const anchor = document.querySelector(".app header") || document.body;
    anchor.appendChild(note);
  } catch (e) { /* non-fatal cosmetic note */ }
}

// Dynamically inject an emscripten MODULARIZE=1 factory script (defines self.LearntttModule) and
// resolve once it has loaded. With MODULARIZE=1 the <script> only DEFINES the factory; instantiation
// stays explicit (instantiateEngineFactory), so this is a load-time bundle CHOICE, not a premature
// instantiation.
function loadBundleScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`Failed to load engine bundle: ${src}`));
    document.head.appendChild(s);
  });
}

function instantiateEngineFactory() {
  // Compile the WebAssembly.Module ONCE on the main thread (PLAN §9.3); the emscripten pthread
  // runtime pre-spawns the pool from it, so warm-up pays 1x compile, not Nx.
  return self.LearntttModule({
    locateFile: (path) => new URL(path, import.meta.url).toString(),
    print: (text) => console.log("[WASM]", text),
    printErr: (text) => console.error("[WASM ERROR]", text),
  });
}

// Feature-detect isolation + SAB FIRST, then fetch the chosen factory and instantiate it (§8.3).
// Wrap the threaded path in try/catch: on ANY failure WITH isolation present (worker spawn blocked,
// pool-init failure — isolation does NOT imply threads work) instantiate the non-threaded bundle.
async function createEngineModule() {
  const caps = {
    crossOriginIsolated: self.crossOriginIsolated === true,
    hasSharedArrayBuffer: typeof SharedArrayBuffer !== "undefined",
    forcedFallback: isFallbackForced(),
  };
  const bundle = selectEngineBundle(caps);
  let threadedFailed = false; // true if the threaded bundle was chosen but its init threw (→ degraded)
  if (bundle === "learnttt-threaded.js") {
    try {
      await loadBundleScript(bundle);
      // Race instantiation against kThreadedInitTimeoutMs so a HUNG pool spawn (emcc 3.1.58 routes a
      // worker load/MIME error to worker.onerror WITHOUT rejecting the module-ready Promise) still
      // degrades to the single-thread bundle via the catch below, instead of hanging init forever.
      let initTimer = null;
      const mod = await Promise.race([
        instantiateEngineFactory().then((m) => { clearTimeout(initTimer); return m; }),
        new Promise((_, reject) => {
          initTimer = setTimeout(
            () => reject(new Error(`threaded engine init timed out after ${kThreadedInitTimeoutMs}ms`)),
            kThreadedInitTimeoutMs);
        }),
      ]);
      usingThreadedEngine = true;
      console.log("[engine] multi-threaded bundle active");
      updateEngineCapabilities(caps, false);
      return mod;
    } catch (err) {
      console.warn("[engine] threaded bundle unavailable; using single-thread fallback:", err);
      threadedFailed = true;
      showMultiCoreUnavailableNote();
      // Fall through: load + instantiate the non-threaded bundle (overwrites self.LearntttModule).
      // ACCEPTED LEAK: if instantiateEngineFactory() threw AFTER partially initializing (pool spawn
      // begun / heap allocated), that half-born threaded module is abandoned, not torn down —
      // emscripten pthread pools aren't cleanly GC-able, so stranded pool threads + a shared heap can
      // persist for the tab's life. Not a UAF (the failed module is never used again); if leaked pool
      // threads ever show up in dev/CI when isolation is present but threading is broken, this is why.
    }
  } else if (caps.forcedFallback && (caps.crossOriginIsolated || caps.hasSharedArrayBuffer)) {
    // Isolated but a prior OOM reload forced the fallback — note the degrade.
    showMultiCoreUnavailableNote();
  }
  await loadBundleScript("learnttt.js");
  usingThreadedEngine = false;
  updateEngineCapabilities(caps, threadedFailed);
  return instantiateEngineFactory();
}

// Read the advanced `?mcts-threads=N` benchmarking override (§9.3). Auto (null) otherwise.
function readMctsThreadOverride() {
  try {
    const v = new URLSearchParams(window.location.search).get("mcts-threads");
    if (v == null) return;
    const n = Number(v);
    if (Number.isFinite(n) && n >= 1) mctsThreadOverride = Math.floor(n);
  } catch (e) { /* ignore */ }
}

// --- Async move-search orchestration (PLAN §9.2) ------------------------------------------------

// Poll cadence (ms) used when the tab is BACKGROUNDED. Browsers PAUSE requestAnimationFrame entirely
// in a hidden tab, which would otherwise stall a threaded search's poll — and with it any CvC /
// autoplay batch run that keeps going in the background — until the tab is foregrounded again (a
// regression vs the old synchronous path, which blocked but still completed). NOTE: this is the
// REQUESTED setTimeout delay; browsers clamp background timers to >=1s, so the EFFECTIVE hidden-tab
// poll cadence is ~1s. That still completes the search — it just polls less often — so 250 is a
// requested floor, not a guaranteed period.
const kHiddenPollMs = 250;

// Schedule the next search poll. Races an rAF (smooth, ~16ms, when the tab is visible) against a
// setTimeout (still fires when the tab is hidden, throttled to ~1s); whichever fires first wins and
// cancels the other, so polling continues in a backgrounded tab. §9.2 allows "rAF or a postMessage
// done-flag"; this is the rAF path with a hidden-tab timer backstop. Falls back to setTimeout-only
// where rAF is absent (headless — though headless callers poll directly, not via this path).
function scheduleSearchPoll(fn) {
  if (typeof requestAnimationFrame !== "function") { setTimeout(fn, kHiddenPollMs); return; }
  let fired = false;
  const run = () => { if (fired) return; fired = true; clearTimeout(timer); fn(); };
  const raf = requestAnimationFrame(run);
  const timer = setTimeout(() => { if (fired) return; fired = true; cancelAnimationFrame(raf); fn(); }, kHiddenPollMs);
}

// ONE shared call shape so the threaded and fallback paths stay interchangeable and the fallback is
// exercised by the same code. Threaded: non-blocking start/poll OFF the main thread (dispatches the
// pooled coordinator). Fallback: synchronous wasm_select_move wrapped in a resolved Promise. Returns
// Promise<{status, move}> with status one of SEARCH_OK / SEARCH_CANCELLED / SEARCH_FATAL.
// Returns { promise, inFlight }. `inFlight` is true ONLY when a real coordinator was armed on the
// pool — the sole case cancelAndQuiesceSearch() must await (and the sole case beginModelSearch
// registers as activeSearch). A busy-rejection / spawn-fatal / synchronous fallback resolves without
// a live pool search, so it must NOT clobber the handle to an actually-running coordinator.
function runModelSearch(turnSide, strength) {
  if (usingThreadedEngine && typeof Module._wasm_start_search === "function") {
    // Threaded bundle: ALWAYS start/poll (even a runtime N=1 runs on the pool, PLAN §9.1) — never
    // the synchronous export, which would run on gState.cnnNet on the main thread, freezing the tab
    // AND racing a live coordinator/worker on that same net.
    const cores = (typeof navigator !== "undefined" && navigator.hardwareConcurrency) || POOL_FALLBACK_CORES;
    const n = computeWorkerCount(strength, cores, mctsThreadOverride);
    const started = Module._wasm_start_search(boardPtr, turnSide, strength, n);
    if (started === 1) {
      const promise = new Promise((resolve) => {
        const outPtr = Module._malloc(4);
        if (!outPtr) {
          // Result-slot alloc failed — a fixed-heap OOM at the search boundary (ABORTING_MALLOC=0).
          // The coordinator IS armed and running, so cancel it and then AWAIT quiescence (poll to
          // `done`) BEFORE resolving FATAL. Resolving immediately would let cancelAndQuiesceSearch()
          // treat a still-live coordinator/worker pool as quiesced and mutate gState under it (§9.4
          // UAF). Poll with a NULL out-slot (wasm_poll_result tolerates it) — we report FATAL
          // regardless of the move, so no second _malloc is needed. §8.3 case-3 reload follows.
          try { Module._wasm_cancel_search(); } catch (e) { /* best effort */ }
          const pollFatal = () => {
            let status;
            try {
              status = Module._wasm_poll_result(0);
            } catch (err) {
              // poll threw: the whole module (pool included) is dead — the reload IS the teardown.
              resolve({ status: SEARCH_FATAL, move: -1 });
              return;
            }
            if (status === SEARCH_RUNNING) { scheduleSearchPoll(pollFatal); return; }
            resolve({ status: SEARCH_FATAL, move: -1 });
          };
          scheduleSearchPoll(pollFatal);
          return;
        }
        const poll = () => {
          let status;
          try {
            status = Module._wasm_poll_result(outPtr);
          } catch (err) {
            // A poll that itself throws is a module-level abort — the whole instance (workers
            // included) is dead, so FATAL routes the caller to a full page reload, which IS the
            // ultimate pool teardown / quiescence. Best-effort cancel first in case a worker lives.
            console.error("[engine] poll threw:", err);
            try { Module._wasm_cancel_search(); } catch (e) { /* module already dead */ }
            // _free can throw too on a dead module. This runs inside an rAF/setTimeout callback, so
            // an uncaught throw here would escape and skip resolve() — the Promise would hang forever
            // and every cancelAndQuiesceSearch() awaiting it (before each mutating action) would
            // freeze. Guard it so resolve() always runs.
            try { Module._free(outPtr); } catch (e) { /* module already dead */ }
            resolve({ status: SEARCH_FATAL, move: -1 });
            return;
          }
          if (status === SEARCH_RUNNING) { scheduleSearchPoll(poll); return; }
          const move = Module.HEAP32[outPtr >> 2];
          Module._free(outPtr);
          resolve({ status, move });
        };
        // Poll off the event loop (never blocks, never Atomics.wait — PLAN §9.2) so any
        // main-thread-proxied worker spawn is serviced. scheduleSearchPoll keeps firing even when the
        // tab is backgrounded (rAF alone would pause), so CvC/autoplay batch runs don't stall.
        scheduleSearchPoll(poll);
      });
      return { promise, inFlight: true };
    }
    // start !== 1: the return code alone distinguishes FATAL from a busy-reject — do NOT poll here.
    // (The old code polled wasm_poll_result once to probe status, but that clears `busy` on any
    // terminal read and could steal the result slot of the search that IS running.) -1 = a spawn /
    // board-snapshot FATAL: the coordinator never armed (§8.3 case-3, must reload). 0 = a benign
    // busy-rejection (another coordinator still running) or bad-args — a spurious double-trigger.
    if (started === -1) {
      // Never armed a coordinator (inFlight:false); the caller reloads on FATAL.
      return { promise: Promise.resolve({ status: SEARCH_FATAL, move: -1 }), inFlight: false };
    }
    // Busy-rejection: a spurious double-trigger. Do NOT run the sync export (it would race the live
    // coordinator on gState.cnnNet) and do NOT register as activeSearch (that would clobber the real
    // running search's handle, breaking quiescence). The scheduler re-drives the move if needed.
    console.warn("[engine] wasm_start_search rejected; ignoring this trigger");
    return { promise: Promise.resolve({ status: SEARCH_CANCELLED, move: -1 }), inFlight: false };
  }
  // Non-threaded fallback bundle: synchronous main-thread search (no pool, no coordinator, no race).
  const move = Module._wasm_select_move(boardPtr, turnSide, strength);
  return { promise: Promise.resolve({ status: SEARCH_OK, move }), inFlight: false };
}

// Begin a model search and register a REAL in-flight pool search as the active search so
// cancelAndQuiesceSearch() can await pool quiescence before any gState mutation (used by BOTH
// interactive and headless callers). A busy-rejected / spawn-fatal / synchronous result is not
// registered — it has no live coordinator to await, and registering it would overwrite the handle to
// the coordinator that IS running (breaking the §9.4 use-after-free barrier).
function beginModelSearch(turnSide, strength) {
  const { promise, inFlight } = runModelSearch(turnSide, strength);
  if (inFlight) {
    activeSearch = promise;
    const clear = () => { if (activeSearch === promise) activeSearch = null; };
    promise.then(clear, clear);
  }
  return promise;
}

// PLAN §9.4: flip the cancel flag then AWAIT the in-flight search Promise (pool fully quiesced)
// BEFORE any synchronous gState-mutating call — else deleting cnnNet under a live worker is a
// use-after-free. The UAF invariant is pinned on Promise-resolution: when `activeSearch` resolves,
// every worker has destroyed its per-move Clone() and holds no reference into gState.cnnNet.
async function cancelAndQuiesceSearch() {
  const search = activeSearch;
  if (!search) return;
  // Invalidate any in-flight move BEFORE the await: if its coordinator publishes SEARCH_OK in the
  // microtask just before the cancel flag flips, its makeMoveForPlayer/playHeadlessGame continuation
  // (registered on this same promise, and it runs before our own await continuation) would otherwise
  // apply that now-superseded move. Bumping the epoch here makes those continuations reject it.
  searchCancelEpoch++;
  if (usingThreadedEngine && Module && typeof Module._wasm_cancel_search === "function") {
    Module._wasm_cancel_search();
  }
  try { await search; } catch (e) { /* a fatal search still quiesces the pool */ }
}

// §9.4 "simplest safe form": disable board/config-mutating controls while a THREADED search is in
// flight (re-enable on resolve/reject). The sync fallback blocks the main thread, so it needs no
// lock. The lock DEPTH is maintained UNCONDITIONALLY (even during autoplay/batch) so a mid-search
// autoplay-state change can never strand the counter — an early `return` on the release side would
// skip the matching decrement, leaving every LATER standalone search unable to disable its controls.
// The UI TOGGLE, by contrast, only fires for a standalone interactive search (Step / human-vs-model):
// autoplay/batch already own these controls for their whole duration via updateAutoplayButtons(), so
// we don't fight them there.
function setSearchInFlight(on) {
  if (!usingThreadedEngine) return;
  if (on) {
    const wasIdle = searchLockDepth++ === 0;
    if (wasIdle && !autoPlay.batchMode && !autoPlay.running) {
      setControlsDisabledDuringPlay(true);
      // Lock Play/Step/Pause/Batch too — they live OUTSIDE .player-config and start paths
      // (startAutoPlay / startBatch → playHeadlessGame's applyModelConfig, wasm_set_elo_rank) that
      // rebuild/free the net WITHOUT quiescing first; clicking one mid-search would free the net under
      // this live coordinator (§9.4 UAF). updateAutoplayButtons() restores them on release.
      // reviewer-flagged (#10, Pause isn't a mutating control), NOT taken: this branch runs only when
      // !autoPlay.running, where Pause is inert (nothing to pause) and already disabled by
      // updateAutoplayButtons() — so disabling it here is a no-op with no observable effect, restored
      // correctly on release. Locking all autoplay controls uniformly during a live coordinator reads
      // clearer than carving out one button for zero behavioural gain.
      disableAutoplayControls();
    }
  } else if (searchLockDepth > 0 && --searchLockDepth === 0) {
    // Only RE-ENABLE play controls if a model is still loaded. A load that failed destructively during
    // this search's awaits calls enterNoSaveState (loaded=false, New Game/Undo disabled); a stale
    // runMoveWithThinking's `finally` then releases this lock, and without the `loaded` guard its restore
    // would re-enable New Game & co. with no valid model — leaving play controls live over a dead engine
    // (§9.4). The lock still decrements either way, so the counter stays balanced.
    if (loaded && !autoPlay.batchMode && !autoPlay.running) {
      setControlsDisabledDuringPlay(false);
      updatePlayerControls(1);
      updatePlayerControls(2);
      updateAutoplayButtons(); // restore Play/Step/Batch to their correct idle states
    }
  }
}

function init() {
  console.log("Initializing app...");
  window.onerror = function(msg, url, line, col, error) {
    console.error("Global Error:", msg, "at", url, line, ":", col, "Error object:", error);
    setError("Critical error: " + msg);
    return false;
  };

  // Top-level Demo <-> Advanced switch. Present in BOTH modes (demo.js can't own it — it no-ops
  // outside ?demo=1), so app.js wires it here. Toggling only flips the `demo` param and preserves any
  // others (?save=, nothreads, mcts-threads); the reload is intentional — demoMode is captured once at
  // load and drives DOM injection + localStorage keying, so navigating is the clean way to switch.
  const modeToggle = document.getElementById("modeToggle");
  if (modeToggle) {
    const toggled = new URLSearchParams(window.location.search);
    // The Pages deployment defaults a query-less root to demo mode. Keep an
    // explicit demo=0 when switching away so that defaulting does not bounce
    // the visitor straight back into the showcase.
    if (demoMode) toggled.set("demo", "0"); else toggled.set("demo", "1");
    const qs = toggled.toString();
    modeToggle.href = window.location.pathname + (qs ? "?" + qs : "");
    modeToggle.textContent = demoMode ? "Advanced view" : "Demo view";
    modeToggle.title = demoMode
      ? "Switch to the full app — load your own saves and the sweep-CSV dashboard"
      : "Switch to the bundled 5-game demo";
    modeToggle.hidden = false;
  }

  // In demo mode the "load a save file" subtitle is wrong (you pick a game tab), so swap in the demo
  // help copy carried in the markup (data-demo). Synchronous here so there's no flash of dev copy.
  if (demoMode) {
    const subtitle = document.getElementById("pageSubtitle");
    if (subtitle && subtitle.dataset.demo) subtitle.textContent = subtitle.dataset.demo;
  }

  readMctsThreadOverride();
  // §8.3: feature-detect isolation + SAB, then dynamically fetch the chosen factory (threaded vs
  // fallback) and instantiate it — with try/catch fallback to the non-threaded bundle inside
  // createEngineModule(). Replaces the old static <script src="learnttt.js"> + direct factory call.
  ModulePromise = createEngineModule().catch((err) => {
    logDetailedError("Engine load error:", err);
    setError("Failed to load WASM module: " + (err?.message || "Check console"));
    setStatus("Engine load failed.");
    return Promise.reject(err);
  });
  ModulePromise.then((mod) => {
    Module = mod;
    refreshGraphUi();
  }).catch(() => { /* engine-load error already surfaced by the .catch above; avoid unhandledrejection */ });

  // Demo API (§7 Phase 2). Assembled here so `ready` derives from the real ModulePromise (never a new
  // one), so a demo-driven load can never fire before the module is up. Always defined (demo.js
  // self-gates on ?demo=1) so demo.js can rely on window.__demo existing after app.js evaluates.
  // Resolves once the engine module is instantiated (or rejects if it failed to load). Setting Module
  // here too guarantees it is non-null for the caller that awaits ready before loadModel().
  const demoReady = ModulePromise.then((mod) => { Module = mod; return mod; });
  // Defensive no-op catch so an engine-load failure doesn't surface as an unhandledrejection when
  // nobody awaits ready (the dev app, where demo.js self-gates out). demo.js's own await still sees it.
  demoReady.catch(() => {});
  window.__demo = {
    isDemo: demoMode,
    ready: demoReady,
    loadModel: (file) => runCoordinatedLoad(() => loadSaveFile(file), "tab"),
    onLoadResult: (cb) => { demoLoadSubscribers.add(cb); return () => demoLoadSubscribers.delete(cb); },
    getModelMeta: demoModelMeta,
    verifyModel: demoVerifyModel,
    applyMatchup: demoApplyMatchup,
    // Whether the multi-threaded engine bundle actually loaded (NOT merely that the page is cross-origin-
    // isolated). demo.js ANDs this with self.crossOriginIsolated so it only picks the threaded sim budget
    // when threading is truly live — a ?nothreads=1 / OOM-fallback / timed-out threaded init leaves an
    // isolated page single-threaded, where the larger budget would only slow moves down (§6.1). A getter
    // (not a captured boolean) because usingThreadedEngine is resolved during engine init, after __demo is
    // assembled.
    usingThreadedEngine: () => usingThreadedEngine,
    // Disable play + enter the no-save state. The demo controller calls this when a post-load step throws
    // AFTER a successful load (leaving a loaded-but-broken engine the coordinator never invalidated), so a
    // displayed failure can't leave play enabled against a partially-configured model. Idempotent — safe to
    // call when play is already disabled (load/verify failures already ran enterNoSaveState).
    invalidate: (msg) => enterNoSaveState(msg || "Load failed."),
  };

  // Board clicks
  boardEl.addEventListener("click", handleBoardClick);

  // New Game
  newGameButton.addEventListener("click", guardAsync(async () => {
    if (!loaded) return;
    // §9.4: pause/cancel await pool quiescence (cancelAndQuiesceSearch) internally before re-enabling
    // controls; awaiting them here also guarantees no in-flight move races the board/turn reset below
    // (the trailing quiesce is then a no-op belt-and-suspenders).
    if (autoPlay.batchMode) await cancelBatch();
    else await pauseAutoPlay();
    await cancelAndQuiesceSearch();
    viewingBatch = false; // fresh interactive game replaces any batch view
    resetBoard();
  }));

  // Swap sides
  if (swapSidesBtn) {
    swapSidesBtn.addEventListener("click", guardAsync(async () => {
      if (!loaded) return;
      // Pause/cancel quiesce the pool internally; await them so no in-flight move races the config
      // swap + board reset (§9.4). The trailing cancelAndQuiesceSearch is then a no-op backstop.
      if (autoPlay.batchMode) await cancelBatch();
      else await pauseAutoPlay();
      await cancelAndQuiesceSearch();
      const tmp = playerConfig[1];
      playerConfig[1] = playerConfig[2];
      playerConfig[2] = tmp;
      const tmpRank = savedEloRank[1];
      savedEloRank[1] = savedEloRank[2];
      savedEloRank[2] = tmpRank;
      lastAppliedConfig = { selector: -1, eloRank: -1, player: -1 };
      // Clear DOM select values so updatePlayerControls uses swapped config
      // values instead of stale DOM state
      for (const p of [1, 2]) {
        getPlayerPanel(p)?.querySelectorAll(".player-strength").forEach(s => { s.value = ""; });
      }
      updatePlayerControls(1);
      updatePlayerControls(2);
      updateAutoplayVisibility();
      updateGraphPlayerSelect();
      viewingBatch = false;
      resetBoard();
    }));
  }

  // Undo
  if (undoButton) {
    undoButton.addEventListener("click", guardAsync(async () => {
      if (!loaded) return;
      await cancelAndQuiesceSearch(); // §9.4: quiesce before mutating moveHistory / board / turn
      undoLastTurn();
    }));
  }

  // Per-player type/strength/selector/rank change handlers
  for (const player of [1, 2]) {
    const panel = getPlayerPanel(player);
    if (!panel) continue;

    const typeSelect = panel.querySelector(".player-type");
    const modelSelect = panel.querySelector(".player-model-select");
    const eloRankInput = panel.querySelector(".player-elo-rank");
    const modelStrength = panel.querySelector(".model-params .player-strength");
    const heuristicStrength = panel.querySelector(".heuristic-params .player-strength");

    if (typeSelect) {
      typeSelect.addEventListener("change", () => {
        let type = typeSelect.value;
        if (type === "heuristic" && !canUseHeuristicOpponent()) {
          type = "model";
          typeSelect.value = "model";
          setError("Heuristic not available for this game.");
        }
        playerConfig[player].type = type;
        moveGeneration++;
        updatePlayerControls(player);
        updateAutoplayVisibility();
        updateGraphPlayerSelect();
        updateGraphModeAvailability();
        updatePlayInfo();
        savePlayerConfigToStorage();
        resumeGameAfterChange();
      });
    }

    if (modelSelect) {
      modelSelect.addEventListener("change", () => {
        if (!loaded || !Module) return;
        moveGeneration++; // invalidate any pending async selector completions
        const oldSelector = playerConfig[player].selector;
        let selected = Number(modelSelect.value);
        if (selected === 2 && !canUseBestVsHeuristic()) {
          setError("Best vs Heuristic not available for this game.");
          selected = 0;
          modelSelect.value = "0";
        }

        // Save/restore elo rank when switching
        if (oldSelector === 0 && selected !== 0) {
          savedEloRank[player] = playerConfig[player].eloRank;
        } else if (oldSelector !== 0 && selected === 0) {
          playerConfig[player].eloRank = savedEloRank[player];
        }

        playerConfig[player].selector = selected;
        invalidateModelConfigCache();

        const finishSelection = () => {
          updatePlayerControls(player);
          refreshModelSummary(saveInput?.files?.[0]);
          loadGraphData();
          updatePlayInfo();
          savePlayerConfigToStorage();
          resumeGameAfterChange();
        };

        if (typeof Module._wasm_set_best_selector === "function" && (selected === 1 || selected === 2)) {
          const statusMsg = selected === 1 ? "Running playoff tournament..." : "Running heuristic tournament...";
          setStatusBusy(statusMsg);
          const gen = moveGeneration;
          setTimeout(() => {
            if (gen !== moveGeneration) { clearStatusBusy(); return; } // stale
            const result = Module._wasm_set_best_selector(selected);
            clearStatusBusy();
            if (result < 0) {
              playerConfig[player].selector = 0;
              modelSelect.value = "0";
            }
            invalidateModelConfigCache();
            finishSelection();
          }, 10);
        } else {
          applyModelConfig(playerConfig[player], player);
          finishSelection();
        }
      });
    }

    if (eloRankInput) {
      eloRankInput.addEventListener("change", () => {
        if (!loaded || !Module) return;
        let newRank = Number(eloRankInput.value);
        if (isNaN(newRank) || newRank < 1) newRank = 1;
        if (newRank > maxEloRank) newRank = maxEloRank;
        eloRankInput.value = String(newRank);
        playerConfig[player].eloRank = newRank;
        playerConfig[player].selector = 0; // Force Elo mode
        invalidateModelConfigCache();
        applyModelConfig(playerConfig[player], player);
        updatePlayerControls(player);
        refreshModelSummary(saveInput?.files?.[0]);
        loadGraphData();
        savePlayerConfigToStorage();
        resumeGameAfterChange();
      });
    }

    if (modelStrength) {
      modelStrength.addEventListener("change", () => {
        const sims = Number(modelStrength.value);
        playerConfig[player].sims = Number.isFinite(sims) && sims >= 0 ? sims : getDefaultModelSims();
        updatePlayInfo();
        savePlayerConfigToStorage();
        resumeGameAfterChange();
      });
    }

    if (heuristicStrength) {
      heuristicStrength.addEventListener("change", () => {
        const ply = Number(heuristicStrength.value);
        playerConfig[player].ply = Number.isFinite(ply) && ply >= 1 ? ply : getDefaultHeuristicPly();
        updatePlayInfo();
        savePlayerConfigToStorage();
        resumeGameAfterChange();
      });
    }
  }

  // Autoplay controls
  if (autoPlayBtn) autoPlayBtn.addEventListener("click", startAutoPlay);
  // pauseAutoPlay is async (it awaits cancelAndQuiesceSearch); wrap like the other async-to-DOM
  // boundaries (runMoveWithThinking / stepAutoPlay) so a rejection surfaces via setError instead of
  // as an unhandled Promise rejection.
  if (autoPauseBtn) autoPauseBtn.addEventListener("click", () => pauseAutoPlay().catch(e => setError(e?.message || String(e))));
  if (autoStepBtn) autoStepBtn.addEventListener("click", stepAutoPlay);

  if (copyTranscriptBtn) copyTranscriptBtn.addEventListener("click", copyTranscript);
  if (downloadTranscriptBtn) downloadTranscriptBtn.addEventListener("click", downloadTranscript);
  // Hook for automated extraction (e.g. from a console / harness): returns the
  // current transcript text exactly as shown in the panel.
  window.learntttTranscript = () => buildTranscriptDoc();

  if (speedSlider && speedLabel) {
    speedSlider.value = String(autoPlay.delay);
    speedLabel.textContent = `${autoPlay.delay}ms`;
    speedSlider.addEventListener("input", () => {
      autoPlay.delay = Number(speedSlider.value);
      // If user adjusts during batch, adopt as the new baseline (don't revert on finish)
      if (autoPlay.batchMode) autoPlay.batchPrevDelay = autoPlay.delay;
      speedLabel.textContent = `${autoPlay.delay}ms`;
      try { localStorage.setItem(lsKey("learntttAutoDelay"), String(autoPlay.delay)); } catch (e) {}
      if (autoPlay.running && isComputerVsComputer() && !gameOver) scheduleAutoMove();
    });
  }

  if (batchBtn) {
    batchBtn.addEventListener("click", guardAsync(async () => {
      if (!loaded) return;
      if (autoPlay.batchMode) {
        // Cancel running batch (awaits pool quiescence before re-enabling controls, §9.4)
        await cancelBatch();
        return;
      }
      const count = Math.max(1, Math.min(10000, Number(batchCountInput?.value) || 100));
      const visual = batchShowGames?.checked ?? false;
      startBatch(count, visual);
    }));
  }

  // Graph player select
  if (graphPlayerSelect) {
    graphPlayerSelect.addEventListener("change", () => {
      graphViewPlayer = Number(graphPlayerSelect.value);
      // Reload graph data for the selected player's network
      if (graphViewPlayer > 0 && isModel(graphViewPlayer)) {
        applyModelConfig(playerConfig[graphViewPlayer], graphViewPlayer);
        invalidateModelConfigCache(); // force reload on next move
        loadGraphData();
      }
      updateGraphStatsForMode();
      scheduleGraphRender();
    });
  }

  // Save file
  // The picker defaults to .sav (canonical saves only). Ticking "Show checkpoints"
  // widens the accept filter to also list compressed .zst snapshots, which
  // loadSaveFile() transparently decompresses. Default stays .sav so the common
  // case isn't buried under the many per-cycle checkpoints.
  if (showCheckpointsToggle) {
    showCheckpointsToggle.addEventListener("change", () => {
      saveInput.setAttribute("accept", showCheckpointsToggle.checked ? ".sav,.zst" : ".sav");
    });
  }

  saveInput.addEventListener("change", async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    if (!ModulePromise) return;
    if (!Module) {
      setStatusBusy("Loading engine...");
      try {
        Module = await ModulePromise;
        clearStatusBusy();
      } catch (err) {
        console.error(err);
        setError("Failed to load WASM module.");
        setStatus("Engine load failed.");
        return;
      }
    }
    setError("");
    setStatusBusy("Loading save...");
    // Route the Advanced manual load through the SAME shared load coordinator as the demo tabs (§7
    // Phase 2), so a manual load and a tab-driven load serialize instead of overlapping, and demo.js
    // learns of this load it did not initiate via the coordinator's result subscription (source:
    // 'advanced'). Outside demo mode this is a plain serialized loadSaveFile() — same behavior as before.
    await runCoordinatedLoad(() => loadSaveFile(file), "advanced");
    clearStatusBusy();
  });

  // Sweep file
  if (sweepFileInput) {
    sweepFileInput.addEventListener("change", async (event) => {
      const file = event.target.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        sweepData = parseSweepCsv(text);
        currentSweepCsvName = file.name;
        updateSweepInfo();
      } catch (err) {
        console.error("Failed to load sweep CSV:", err);
        setError("Failed to load sweep CSV.");
      }
    });
  }

  // Clear save selection on re-open
  const clearSaveSelection = () => { saveInput.value = ""; };
  const saveLabel = saveInput.closest("label");
  if (saveLabel) {
    saveLabel.addEventListener("pointerdown", clearSaveSelection, { capture: true });
    saveLabel.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") clearSaveSelection();
    }, { capture: true });
  }
  saveInput.addEventListener("pointerdown", clearSaveSelection);
  saveInput.addEventListener("click", clearSaveSelection);

  // Error handling
  window.addEventListener("unhandledrejection", (event) => {
    logDetailedError("Unhandled Rejection:", event.reason);
    if (!errorLine.textContent) {
      const msg = event.reason?.message || (typeof event.reason === 'string' ? event.reason : "Check console for details");
      setError("Unhandled rejection: " + msg);
      setStatus("Error.");
    }
  });

  // Graph controls
  if (graphMinWeight && graphMinWeightValue) {
    graphMinWeight.addEventListener("input", () => {
      graphMinWeightValue.textContent = Number(graphMinWeight.value || 0).toFixed(2);
      scheduleGraphRender();
    });
  }

  if (graphModeSelect) {
    try {
      const storedMode = window.localStorage.getItem(lsKey("learntttGraphMode"));
      if (storedMode === "topology" || storedMode === "activation") graphMode = storedMode;
    } catch (e) { /* localStorage unavailable */ }
    graphModeSelect.value = graphMode;
    refreshGraphUi();
    graphModeSelect.addEventListener("change", () => {
      graphMode = graphModeSelect.value === "activation" ? "activation" : "topology";
      try { window.localStorage.setItem(lsKey("learntttGraphMode"), graphMode); } catch (e) {}
      refreshGraphUi();
    });
  }

  if (graphShowDisabled) {
    graphShowDisabled.addEventListener("change", () => scheduleGraphRender());
  }

  if (graphCanvas) {
    graphCanvas.addEventListener("mousemove", handleGraphMouseMove);
    graphCanvas.addEventListener("mouseleave", hideGraphTooltip);
  }

  window.addEventListener("resize", () => {
    if (graphNodes.length) scheduleGraphRender();
  });

  // Initial UI
  updatePlayerControls(1);
  updatePlayerControls(2);
  updateAutoplayVisibility();
  scheduleGraphRender();

  // Auto-load save file from URL param. Skipped in demo mode: the demo controls loading itself (via the
  // tab strip + window.__demo), and this `../saves/` fetch is exactly the sibling coupling it severs (§2).
  const urlParams = new URLSearchParams(window.location.search);
  const autoSave = urlParams.get("save");
  if (autoSave && !demoMode) {
    const savePath = "../saves/" + autoSave;
    ModulePromise.then(async (mod) => {
      Module = mod;
      setStatusBusy("Loading save from URL...");
      try {
        // Capture the coordinator's request token BEFORE the network fetch by doing the fetch INSIDE the
        // loadFn (runCoordinatedLoad bumps the token synchronously at call time). If we fetched FIRST and
        // only THEN called runCoordinatedLoad, a manual Advanced pick that started AFTER this autoload but
        // whose fast local load finished during our fetch would register an OLDER token — and these stale
        // URL bytes would then clobber the user's pick. Fetching inside loadFn means a later manual pick
        // always gets the newer token and wins; a superseded URL load is skipped at the coordinator's queue
        // / in-flight token check instead of overwriting. enterNoSaveState-on-failure stays gated to demo
        // mode inside the coordinator, so the dev app's behavior is otherwise unchanged (§7 Phase 2).
        const res = await runCoordinatedLoad(async () => {
          const resp = await fetch(savePath);
          if (!resp.ok) throw new Error(`Failed to fetch ${savePath}: ${resp.status}`);
          const blob = await resp.blob();
          const file = new File([blob], autoSave, { lastModified: Date.now() });
          return loadSaveFile(file);
        }, "url");
        // loadSaveFile auto-loads sweep CSV and shows filename indicators.
        // Show the save filename too (can't set input.value for security) — but ONLY when this URL load
        // actually took effect. A newer manual pick supersedes it (res.stale / res.ok false); labeling the
        // picker with the URL's filename then would misname the user's chosen save.
        if (res && res.ok === true && saveInput) {
          const label = saveInput.closest("label");
          if (label) {
            let nameEl = label.querySelector(".auto-loaded-name");
            if (!nameEl) {
              nameEl = document.createElement("span");
              nameEl.className = "auto-loaded-name";
              label.appendChild(nameEl);
            }
            nameEl.textContent = autoSave;
          }
        }
      } catch (err) {
        console.error("Auto-load save failed:", err);
        setError("Failed to auto-load save: " + (err.message || err));
      }
      clearStatusBusy();
    }).catch(() => { /* engine-load rejection already surfaced by createEngineModule's .catch */ });
  }
}

init();
