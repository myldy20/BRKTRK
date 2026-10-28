# BRK Modal source migration into BRKTRK

Imported unchanged from `myldy20/BRKSNTH_private` at commit
`70d7244895591d1db6c25afaead7009353a0e4bb` (80 files).
All 80 source Git blob SHAs were checked identical across repositories.

## License and provenance

BRK Modal is a modified GPL-3.0-only work based on RipplerX 1.5.18
(Tiago Rodrigues). Keep `PROVENANCE.md`, `PROVENANCE.yml`,
the root BRKTRK GPLv3 `LICENSE`, the downstream change records
and upstream notices when publishing the source or future binary.
Its C++17 DSP, build tools, preset importers and test data retain
their original copyright attribution.

The old `BRKSNTH_private/release/brksynth-publication-policy.json`
declared the binary packages non-public while BRKTRK was proprietary.
BRKTRK is now GPLv3 and the project owner requested source consolidation.
This source migration does not itself promote, reissue, or relicense
the old immutable **binary packages** or declare their public distribution
approved. A separate package-level release decision and corresponding-source
verification remain required.

## What works in this slice

- Native CMake project, unchanged source and independent unit tests in BRKTRK.
- CI runs the Modal DSP, state-v1 and parameter-descriptor suites.
- Existing BRK DEV POLY/FM runtime packages and catalog remain untouched.
- No new runtime downloads, browser boot changes or AudioWorklet changes.

## Native ABI integration milestone

- Imported the **29** files under `abi/` from the same private pinned commit,
  with exact 29/29 Git blob-SHA identity across repositories.
- The frozen `abi/include/brk_synth_abi.h`, `abi/native/brk_modal_module.cpp`,
  realtime event executor, runtime-policy bridge, tests and TypeScript ABI
  declarations now live alongside Modal's 80 DSP source files in BRKTRK.
- The existing Public CI builds six native adapter/ABI conformance targets:
  C ABI, structure layout, module runtime, event executor, runtime policy and
  persistent ramp/event semantics.
- The native ABI import must not change any existing browser engine package,
  instrument identity, project file or Pages startup path.

## Next integration dependency

The native adapter is not yet a working browser synth. Next: provision a
pinned Emscripten toolchain in isolated CI, migrate only the necessary
AudioWorklet/package builder dependencies, then generate a **new versioned**
immutable Modal archive with complete GPL corresponding source, provenance,
factory presets and browser conformance. Only add the exact tested SHA to the
public catalog after explicit package-level clearance. Never substitute for
or silently overwrite old package identities pinned in saved projects.
