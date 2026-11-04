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

## Browser factory build preparation

The standalone `brk_modal_wasm` CMake target is now decoupled from the
former private-host `host/browser/build_worklet_post.py` generator. Legacy
worklet targets are opt-in via `-DBRK_MODAL_BUILD_LEGACY_WORKLET=ON` and
are **not** needed by the BRKTRK generic AudioWorklet Host.

With Emscripten **4.0.23** active, run `npm run build:modal-wasm` to compile
the standalone `build/brk-modal-wasm/brk_modal_module.js` factory and its
`.wasm` binary; both outputs are gitignored. Public CI performs a
configure-only check of this path without pulling the heavy SDK on every PR.
A real Emscripten build, JS/WASM runtime playback, immutable package
verification and release gate remain outstanding. This tool **does not**
change the production catalog or publish binaries.

## Independently testable native/WASM qualification

A conditional `modal_wasm` job in the existing `.github/workflows/ci.yml`
executes for Modal/ABI pull requests and via `workflow_dispatch` with
`qualify_modal_wasm=true`. It installs the Emscripten 4.0.23 SDK from
the *pinned emsdk revision* `c0bb220cb6e6f4e0fabb6f6db9efd53390ef5e56`,
compiles the imported C++ DSP/module into direct JS + WASM and runs
`scripts/qualify-modal-wasm.sh`. The latter rebuilds a matching native
state + audio golden and uses the imported TypeScript/Node ABI harness to
compare the emitted 192 stereo frames, validate the 768-byte state, no
WASM memory growth after activation, concurrent module instances and ramps.

This job is separate from the lightweight Public CI test job, but lives
inside the same workflow to preserve the repository's two-workflow policy. It does
**not** upload binary artifacts, publish a package, alter Pages or mark
BRK Modal as released. A successful run qualifies the direct JS/WASM
factory only; actual Chrome AudioWorklet playback and complete presets,
source/notice/archive verification remain independent release gates.

## GPL factory presets are now source-owned

The 28 original RipplerX 1.5.18 factory XML files are checked into
`upstream-factory/resources/presets/` at exact upstream commit
`e9f6537e5e3d6c648b2463e6a90f15e5f612bb75` (28/28 blob SHA matches).
`bash scripts/build-modal-factory-presets.sh` builds the deterministic
28 Reference + 6 BRK state-v1 banks and enriches the JSON index with all
89 actual binary normalized values per preset. Public CI validates the full
bank using the *real* `BRKTRKEnginePresetDomain.createLibrary`: all 34 must
be applicable, immutable and byte-identical to their packaged state. No
network access or private checkout is used to generate factory data.

Binary package construction and release authorization remain a separate gate.

## Test-only immutable BRK Modal candidate archive

`bash scripts/build-modal-candidate-package.sh` builds a new
`1.1.1-brktrk1` **candidate**, with pinned Emscripten JS/WASM, the 34
validated native preset states and full 89-parameter registry derived from the
native ABI descriptor fixture. Metadata includes a GPL source/provenance
reference tied to the exact BRKTRK commit and a transport-level package SHA.
The **real** BRKTRK tar transport/production package loader and preset domain
must accept the archive; a deliberately corrupted archive must fail SHA check.
Candidate files stay under gitignored `build/` only. This is a qualification
step, **not** public engine publication or acceptance of the old private
binary identity. Browser production Worklet/Program/Project E2E is next.

## Real production Worklet registration gate

`scripts/qualify-modal-production-worklet.mjs` reads the actual 34-preset
SHA-pinned candidate tar.gz through the BRKTRK package loader. It builds the
engine module using `BRKTRKProductionEngineHost.buildWorkletModuleSource`,
loads the complete `web/audio-worklet.js` module graph into a real Chromium
`AudioWorkletNode("brktrk-audio")`, then requests production ABI descriptors.
The module's 89 unique parameters and exact package SHA must be reported from
the real production Worklet registry. The entire fixture stays inside ephemeral
localhost CI; nothing is copied to the public catalog or Pages.

This gate proves package-to-production-Worklet registration. Project-level
playback and persistence are covered separately below.

## Browser Project journey and performer budget

The host's former default 128 KiB per-performer realtime budget rejected the
Modal adapter's 768 KiB minimum at `brk_instance_prepare` (ABI result -4),
even though the package registered successfully. The host now passes a finite
1 MiB default while retaining an explicit caller-specified limit. This value is
an ABI budget per performer, not a request to allocate another 1 MiB Wasm heap;
Modal's existing fixed 32 MiB module memory and eight-instance capacity remain.

`scripts/qualify-modal-project-journey.mjs` builds a separate temporary engine
store, adds only the exact SHA-verified unpublished preview candidate, and runs
the actual BRKTRK UI in Chromium at 1210 and 390 pixel viewport widths. It
selects Modal, applies a factory preset, measures finite nonzero output from the
real production Worklet, saves and reopens the Project after a full page reload,
then replaces Modal with POLY and back and verifies output again. The test
checks exact engine SHA and preset identity after reopening. It does not publish
the candidate, establish physical phone/audio acceptance, or test every preset.

## Public release package

The new `1.1.1-brktrk2` archive is built from public BRKTRK sources and
qualified before being locked in `release/engines/`. Its embedded
`provenance/BUILD-SOURCE.md` points to the exact corresponding source commit,
which remains an ancestor of the release. This is a new version and does not
republish or relabel any old private archive.

The catalog and package SHA are locked in `release/engines/catalog-lock.json`.
`npm run build:store` verifies the hash, package internals, provenance and 34
applicable presets, then copies the unchanged archive to the public store. CI
rejects changes or removal of existing release entries and archive paths, and
the compact Pages build exercises the locked archive in the actual browser UI.
The catalog loads at startup; the package is fetched only on demand. Physical
phone/audio acceptance and the remaining engine migrations are still open.
