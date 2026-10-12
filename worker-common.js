// Helpers shared by the page's search workers (heuristic-worker.js and model-worker.js). Each worker
// loads this file with importScripts after learnttt.js, so these names are worker globals.
"use strict";

const kInt32Bytes = 4;

// Returns a function that instantiates the worker's single-thread engine once, on first use.
function createEngineLoader(tag) {
  let modulePromise = null;
  return () => {
    if (!modulePromise) {
      modulePromise = self.LearntttModule({
        print: (text) => console.log(`[WASM ${tag} worker]`, text),
        printErr: (text) => console.error(`[WASM ${tag} worker ERROR]`, text),
      });
    }
    return modulePromise;
  };
}

function mallocOrThrow(M, bytes, tag) {
  const ptr = M._malloc(bytes);
  if (!ptr) throw new Error(`${tag} worker could not allocate ${bytes} bytes`);
  return ptr;
}

// Returns a function that copies a board (Int32Array) into a grow-only buffer in the engine heap and
// returns its address.
function createBoardBuffer(tag) {
  let ptr = 0;
  let cells = 0;
  return (M, board) => {
    if (board.length > cells) {
      if (ptr) M._free(ptr);
      ptr = 0;
      cells = 0;
      ptr = mallocOrThrow(M, board.length * kInt32Bytes, tag);
      cells = board.length;
    }
    M.HEAP32.set(board, ptr / kInt32Bytes);
    return ptr;
  };
}
