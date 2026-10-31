#!/usr/bin/env bash
# Reproduce the authentic 28 RipplerX + 6 BRK Modal factory bank from
# checked-in GPL upstream XML and the imported C++ state-v1 serializer.
# Requires Python 3, CMake, and a native C++17 compiler (no network).
set -euo pipefail

root="\${BRKTRK_MODAL_FACTORY_BUILD_DIR:-build/brk-modal-factory}"
mkdir -p "$root"
root="$(cd "$root" && pwd)"
source_dir="engines/brk-modal/upstream-factory"
python3 engines/brk-modal/tools/import_ripplerx_presets.py \
  --upstream-root "$source_dir" --output "$root/ripplerx-programs.json"
python3 engines/brk-modal/tools/generate_ripplerx_program_bank.py \
  --programs "$root/ripplerx-programs.json" --output "$root/ripplerx-program-bank.inc"
cmake -S engines/brk-modal -B "$root/native" \
  -DCMAKE_BUILD_TYPE=Release -DBRK_MODAL_ENABLE_VECTOR=OFF \
  -DBRK_MODAL_PROGRAM_BANK_INCLUDE="$root/ripplerx-program-bank.inc"
cmake --build "$root/native" --parallel 2 --target brk_modal_p6_preset_pack
"$root/native/brk_modal_p6_preset_pack" "$root/presets"
python3 scripts/prepare-modal-factory-index.py --preset-dir "$root/presets"
node scripts/test-modal-factory-presets.cjs "$root/presets"
echo "BRK_MODAL_FACTORY_PRESETS=PASS"
