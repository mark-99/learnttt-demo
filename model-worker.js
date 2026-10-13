// Runs CNN model moves for the single-thread engine off the page's main thread, so a long search (a
// 13x13 Gomoku move at 3,200 sims takes about half a minute on one thread) doesn't freeze the page.
// The worker hosts its own copy of the single-thread engine (learnttt.js) and loads its own copy of
// the page's CNN save. The page (web/app.js requestWorkerModelMove) posts the save once per worker,
// tagged with the page's save generation, and every search names the generation it expects.
//
// Messages are handled one at a time in arrival order, so a search posted after a load runs on that
// save.
//
// Request:  { type: "load", gen, save: Blob }  (no reply; a failure is reported by the next search)
//           { type: "search", id, gen, board: Int32Array, turn, sims, settings }
//           (settings = { fpuReduction, firstMoveRadius }, each null when clear; fpuReduction is the
//           first-play urgency and firstMoveRadius the TEMPORARY demo opening rule, see
//           docs/web-demo.md "Opening rule")
// Response: { id, move, settings } or { id, error }  (settings = the values applied, -1 when clear)
"use strict";

importScripts("learnttt.js", "worker-common.js");

const kTag = "model";
const getModule = createEngineLoader(kTag);
const copyBoard = createBoardBuffer(kTag);
let loadedGen = -1;
let loadError = "";
let queue = Promise.resolve();

function lastError(M) {
  try { return M.ccall("wasm_get_last_error", "string", [], []); } catch (e) { return ""; }
}

async function load(req) {
  loadedGen = -1;
  loadError = "";
  try {
    const M = await getModule();
    const bytes = new Uint8Array(await req.save.arrayBuffer());
    const ptr = mallocOrThrow(M, bytes.length, kTag);
    let res;
    try {
      M.HEAPU8.set(bytes, ptr);
      res = M._wasm_load_save(ptr, bytes.length);
    } finally {
      M._free(ptr);
    }
    if (res !== 0) throw new Error(lastError(M) || `wasm_load_save returned ${res}`);
    if (M._wasm_is_cnn() !== 1) throw new Error("the save is not a CNN save");
    loadedGen = req.gen;
  } catch (err) {
    loadError = String(err?.message ?? err);
  }
}

async function search(req) {
  try {
    if (req.gen !== loadedGen)
      throw new Error(loadError ? `save not loaded: ${loadError}` : `save generation ${req.gen} not loaded`);
    const M = await getModule();
    M._wasm_set_fpu_reduction(req.settings?.fpuReduction ?? -1);
    M._wasm_set_first_move_radius(req.settings?.firstMoveRadius ?? -1);
    const move = M._wasm_select_move(copyBoard(M, req.board), req.turn, req.sims);
    const settings = { fpuReduction: M._wasm_get_fpu_reduction(), firstMoveRadius: M._wasm_get_first_move_radius() };
    self.postMessage({ id: req.id, move, settings });
  } catch (err) {
    self.postMessage({ id: req.id, error: String(err?.message ?? err) });
  }
}

self.onmessage = (e) => {
  const req = e.data;
  queue = queue.then(() => (req.type === "load" ? load(req) : search(req)));
};
