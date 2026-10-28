#!/usr/bin/env bash
# Build the BRK Modal ABI factory from the GPL sources in BRKTRK.
# Emscripten 4.0.23 is the pinned toolchain from the original Modal build.
# This stages local JS/WASM only; it does not publish a catalog or package.
set -euo pipefail

command -v emcmake >/dev/null 2>&1 || {
  echo 'Emscripten SDK is required (emcmake unavailable).' >&2
  exit 1
}
command -v emcc >/dev/null 2>&1 || {
  echo 'Emscripten compiler emcc is unavailable.' >&2
  exit 1
}

build_dir="${BRKTRK_MODAL_WASM_BUILD_DIR:-build/brk-modal-wasm}"
jobs="${BRKTRK_BUILD_JOBS:-2}"
emcmake cmake -S abi -B "$build_dir" \
  -DCMAKE_BUILD_TYPE=Release \
  -DBRK_MODAL_BUILD_LEGACY_WORKLET=OFF
cmake --build "$build_dir" --parallel "$jobs" --target brk_modal_wasm
test -s "$build_dir/brk_modal_module.js"
test -s "$build_dir/brk_modal_module.wasm"
printf 'Modal native-to-WASM build complete: %s (NOT packaged or published)\n' "$build_dir"
