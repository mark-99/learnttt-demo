// Runs built-in heuristic moves off the page's main thread, so a deep search (a Gomoku ply 5 move
// can take tens of seconds) doesn't freeze the page. The worker hosts its own copy of the single-thread
// engine (learnttt.js) and loads no save. Each request carries the game settings, the board and the
// side's heuristic move count, which the page's own module owns (web/app.js requestHeuristicMove).
//
// Request:  { id, gameType, width, height, winLength, board: Int32Array, turn, ply, moveCount }
// Response: { id, move, counted } or { id, error }
"use strict";

importScripts("learnttt.js", "worker-common.js");

const kTag = "heuristic";
const getModule = createEngineLoader(kTag);
const copyBoard = createBoardBuffer(kTag);
let countedPtr = 0;

self.onmessage = async (e) => {
  const req = e.data;
  try {
    const M = await getModule();
    const boardPtr = copyBoard(M, req.board);
    if (!countedPtr) countedPtr = mallocOrThrow(M, kInt32Bytes, kTag);
    const move = M._wasm_heuristic_move_for(req.gameType, req.width, req.height, req.winLength, boardPtr,
                                            req.turn, req.ply, req.moveCount, countedPtr);
    // Read HEAP32 again after the call: a heap growth during the search replaces the view.
    const counted = M.HEAP32[countedPtr / kInt32Bytes] === 1;
    self.postMessage({ id: req.id, move, counted });
  } catch (err) {
    self.postMessage({ id: req.id, error: String(err?.message ?? err) });
  }
};
