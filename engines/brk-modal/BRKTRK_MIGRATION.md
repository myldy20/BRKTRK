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

## Next integration dependency

Bring the BRK Synth ABI header/module adapter and WASM packaging inputs into
BRKTRK, build and test a **new versioned** immutable Modal package, verify
complete GPL corresponding source/presets and browser conformance, then add
its exact SHA to the public catalog. Existing projects pinned to older binary
identities must retain exact-package resolution, without silent migration.
