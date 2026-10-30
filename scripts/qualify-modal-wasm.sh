#!/usr/bin/env bash
# BRK Modal native-vs-WASM comparison using the exact imported GPL ABI.
# Requires npm run build:modal-wasm (Emscripten) to have completed.
# No external BRKSNTH checkout, secrets, preset ZIPs, or public publication.
set -euo pipefail

module_dir="${BRKTRK_MODAL_WASM_BUILD_DIR:-build/brk-modal-wasm}"
native_dir="${BRKTRK_MODAL_NATIVE_BUILD_DIR:-build/brk-modal-native-fixture}"
fixture_dir="${BRKTRK_MODAL_FIXTURE_DIR:-build/brk-modal-fixtures}"
test -s "$module_dir/brk_modal_module.js"
test -s "$module_dir/brk_modal_module.wasm"
mkdir -p "$fixture_dir"

cmake -S abi -B "$native_dir" \
  -DCMAKE_BUILD_TYPE=Release \
  -DBRK_MODAL_ENABLE_VECTOR=OFF
cmake --build "$native_dir" --parallel 2 --target \
  brk_module_runtime_test brk_p4_factory_state_fixture

"$native_dir/brk_module_runtime_test" "$fixture_dir/native-golden.bin"
"$native_dir/brk_p4_factory_state_fixture" "$fixture_dir/state.bin"
test -s "$fixture_dir/native-golden.bin"
test -s "$fixture_dir/state.bin"
node abi/typescript/test_wasm_module.mjs \
  "$module_dir/brk_modal_module.js" \
  "$fixture_dir/native-golden.bin" \
  "$fixture_dir/state.bin"
echo 'BRK_MODAL_NATIVE_WASM_PARITY=PASS'
