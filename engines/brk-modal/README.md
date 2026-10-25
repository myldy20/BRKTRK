# BRK Modal

Compact dual-resonator physical-modeling Instrument engine and fixed-memory module for the BRK synth gateway.

BRK Modal is an explicitly modified **GPL-3.0-only work derived from RipplerX 1.5.18**. It is intended to ship with complete corresponding source, license and attribution.

## Current status

**P0–P8B complete. P9 standalone playable web instrument is next.**

Canonical continuation sources:

- [`NEXT_DEVELOPER_HANDOFF.md`](../../docs/NEXT_DEVELOPER_HANDOFF.md)
- [`BRK_MODAL_P8B_STATUS.md`](../../docs/BRK_MODAL_P8B_STATUS.md)
- [`ABI_V1.md`](../../docs/ABI_V1.md)
- [`ROADMAP.md`](../../ROADMAP.md)
- [`PROVENANCE.md`](PROVENANCE.md) and [`PROVENANCE.yml`](PROVENANCE.yml)

Older `BRK_MODAL_P*` reports and `ABI_V1_DRAFT.md` are historical evidence.

## Accepted engine stack

- dependency-free C++17 DSP core;
- 16 fixed voices and two modal/waveguide resonators per voice;
- all 12 RipplerX model families;
- parallel/serial resonator flow;
- Stable / Reference / Wild sound paths;
- sustain, retrigger, choke, Damped/Natural/OneShot lifecycle;
- 28 reproducibly imported RipplerX Reference programs + 6 BRK presets;
- frozen BRK Synth ABI v1.0 (`0x00010000`), 89 stable parameter IDs;
- exact 768-byte deterministic BRK Modal state v1;
- sample-accurate packed events and persistent ramps;
- eight generation-protected module instances per current runtime pool;
- native/WASM from the same DSP/adapter source;
- fixed 32 MiB Wasm memory, growth disabled;
- real Chrome AudioWorklet path;
- persistent Instrument patch / independent performer / Track dry-sum host semantics;
- host-owned descriptor-driven Sound UI;
- Full/Balanced/Economy/Draft profiles plus model-aware Auto;
- native/WASM/browser conformance, sanitizer and fuzz evidence;
- P8B BRKTRK K4A/K4B integration handoff/package.

Physical TrimUI Brick evidence remains pending and no TrimUI readiness claim is made.

## Runtime quality

Quality is runtime-only and never serialized into state v1.

| Profile | Hard voice cap | Modal policy | Stereo |
| --- | ---: | --- | --- |
| Full | 16 | authored, up to 64/resonator | authored |
| Balanced | 12 | model-aware 24/32/64 protection | authored |
| Economy | 8 | structure-aware 16/20/24, serial floor 32 | authored |
| Draft | 6 | 8/resonator | mono |

P8A owner listening was accepted on 2026-08-08. Balanced remains the candidate normal interactive profile; Economy is accepted as the lower-cost tier; Full remains the reference oracle; Draft remains intentionally aggressive. Default Auto remains **Full ↔ Balanced only**.

## Frozen ABI/state invariants

Canonical ABI semantics: [`docs/ABI_V1.md`](../../docs/ABI_V1.md). Canonical C layout: [`abi/include/brk_synth_abi.h`](../../abi/include/brk_synth_abi.h).

- ABI version `0x00010000`;
- 89 stable numeric parameter IDs; UI order is never identity;
- exact 768-byte deterministic state v1;
- whole-state replacement is stopped/deactivated and atomic;
- packed events validate before mutation;
- actual process frame count is consumed; 128 is never assumed;
- no observed process-time allocation after activation in the tested path;
- no Wasm memory growth;
- native/WASM share DSP and adapter code;
- quality remains runtime-only.

Frozen same-sample performer order:

```text
Reset -> AllNotesOff -> Choke -> NoteOff -> Sustain -> ParamValue -> ParamRamp -> NoteOn -> Retrigger
```

## BRKTRK integration boundary

P8B inspected `myldy20/BRKTRK` read-only. The accepted downstream K4A/K4B architecture is compatible with BRK Modal and becomes the future host timing boundary.

BRKTRK owns Project/Phrase/Groove/Table/FX semantic compilation and supplies ordered absolute-frame intent. BRKSNTH must not read tracker rows, derive a private musical clock, interpret raw tracker FX IDs, assume fixed render quanta or reorder K4 musical intent.

The validator/router lives in `../../integration/brktrk/brktrk_k4_bridge.mjs`.

One eight-instance ModuleRuntime exactly covers BRKTRK's current eight Tracks for the ordinary one-performer-per-Track case. Future >8 simultaneous performers scale through additional independent module runtimes; handles never cross runtimes and each additional WASM runtime costs a separate fixed 32 MiB memory.

## Final P8B package evidence

```text
run: 31253531466
commit: 4d93db990327810f008ef5b7676a54e4d6b6e40a
job: 93093442791
runner: myldysite-brksnth
artifact: brk-modal-p8b-integration-package
artifact_id: 9020735953
package tar.gz SHA256: ebab7c1950fcc299cd7893fd307e6c86e4b64680d3bb0bda626c99ce373b5821
```

The package includes built WASM/Worklet artifacts, host helpers, all 34 presets, frozen ABI docs/header, engine/UI manifests, K4 bridge/snapshot, GPLv3, human + machine-readable provenance, `PACKAGE_MANIFEST.json` and verified `SHA256SUMS`.

The exact-head acceptance passed K4 bridge `reorders=0`, native ABI 6/6, pinned presets, exact direct host/Track/Sound/P7 contracts, real Chrome P5B/P5C/P6 and every package checksum. The package workflow is back to manual-only after acceptance.

See [`BRK_MODAL_P8B_STATUS.md`](../../docs/BRK_MODAL_P8B_STATUS.md).

## Build native engine

```bash
cmake -S engines/brk-modal -B build/brk-modal -DCMAKE_BUILD_TYPE=Release
cmake --build build/brk-modal --parallel 2
ctest --test-dir build/brk-modal --output-on-failure
```

## Build native module adapter/tests

```bash
cmake -S abi -B build/abi -DCMAKE_BUILD_TYPE=Release
cmake --build build/abi --parallel 2
ctest --test-dir build/abi --output-on-failure
```

## Factory-program pipeline

Raw RipplerX data remains the source of truth. Runtime never parses XML/JSON. Packaging/acceptance regenerates the Reference bank from pinned RipplerX `1.5.18` commit `e9f6537e5e3d6c648b2463e6a90f15e5f612bb75` using checked-in import/generation tools. Generated program values must not be manually edited instead of fixing the importer.

## Repository boundary

BRK Modal accepts synth note/lifecycle/parameter events and outputs dry stereo audio. It does **not** own BRKTRK Song/Chain/Phrase/Tables, Track gain/pan/mute, effects/sends/returns/Master routing, project navigation, audio input/sidechain or arbitrary executable engine UI.

Actual BRKTRK edits remain out of scope until explicit P11 authorization.

## License and provenance

Upstream portions and converted factory-program data are GPL-3.0; downstream BRK modifications are GPL-3.0-only. Preserve attribution, identify BRK modifications, provide complete corresponding source/build scripts and distribute GPLv3 text when conveying the work.

See [PROVENANCE.md](PROVENANCE.md) and [PROVENANCE.yml](PROVENANCE.yml).

## Next

Proceed to **P9 standalone playable web instrument**. Build it on the accepted AudioWorklet/module/state/descriptor contracts; do not create a separate DSP path or pull BRKTRK sequencing/mixer ownership into the app.
