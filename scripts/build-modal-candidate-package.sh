#!/usr/bin/env bash
# Build & verify unpublished BRK Modal package without modifying the public
# engine store. Requires a prebuilt pinned Emscripten JS/WASM factory.
set -euo pipefail
root="${BRKTRK_MODAL_CANDIDATE_BUILD_DIR:-build/brk-modal-candidate}"
mkdir -p "$root"
root="$(cd "$root" && pwd)"
bash scripts/build-modal-factory-presets.sh
cmake -S abi -B "$root/native" -DCMAKE_BUILD_TYPE=Release
cmake --build "$root/native" --parallel 2 --target brk_parameter_descriptor_fixture
"$root/native/brk_parameter_descriptor_fixture" "$root/parameters.bin"
python3 scripts/build-modal-candidate-package.py \
  --repo . \
  --wasm-dir build/brk-modal-wasm \
  --presets build/brk-modal-factory/presets \
  --descriptor-fixture "$root/parameters.bin" \
  --output-dir "$root/output" \
  --head-sha "$(git rev-parse HEAD)"
node scripts/test-modal-candidate-package.cjs "$root/output"
echo "BRK_MODAL_CANDIDATE_LOADER=PASS"
