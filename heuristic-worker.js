// Runs built-in heuristic moves off the page's main thread, so a deep search (a Gomoku ply 5 move
// can take tens of seconds) doesn't freeze the page. The worker hosts its own copy of the single-thread
// engine (learnttt.js) and loads no save. Each request carries the game settings, the board and the
// side's heuristic move count, which the page's own module owns (web/app.js requestHeuristicMove).
//
// Request:  { id, gameType, width, height, winLength, board: Int32Array, turn, ply, moveCount }
// Response: { id, move, counted } or { id, error }
"use strict";

importScripts("learnttt.js");

const kInt32Bytes = 4;

let modulePromise = null;
let boardPtr = 0;
let boardCells = 0;
let countedPtr = 0;

function getModule() {
  if (!modulePromise) {
    modulePromise = self.LearntttModule({
      print: (text) => console.log("[WASM heuristic worker]", text),
      printErr: (text) => console.error("[WASM heuristic worker ERROR]", text),
    });
  }
  return modulePromise;
}

function mallocOrThrow(M, bytes) {
  const ptr = M._malloc(bytes);
  if (!ptr) throw new Error(`heuristic worker could not allocate ${bytes} bytes`);
  return ptr;
}

self.onmessage = async (e) => {
  const req = e.data;
  try {
    const M = await getModule();
    const cells = req.board.length;
    if (cells > boardCells) {
      if (boardPtr) M._free(boardPtr);
      boardPtr = 0;
      boardCells = 0;
      boardPtr = mallocOrThrow(M, cells * kInt32Bytes);
      boardCells = cells;
    }
    if (!countedPtr) countedPtr = mallocOrThrow(M, kInt32Bytes);
    M.HEAP32.set(req.board, boardPtr / kInt32Bytes);
    const move = M._wasm_heuristic_move_for(req.gameType, req.width, req.height, req.winLength, boardPtr,
                                            req.turn, req.ply, req.moveCount, countedPtr);
    // Read HEAP32 again after the call: a heap growth during the search replaces the view.
    const counted = M.HEAP32[countedPtr / kInt32Bytes] === 1;
    self.postMessage({ id: req.id, move, counted });
  } catch (err) {
    self.postMessage({ id: req.id, error: String(err?.message ?? err) });
  }
};
