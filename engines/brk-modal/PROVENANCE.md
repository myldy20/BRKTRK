# BRK Modal provenance and license record

## License decision

BRK Modal is intentionally developed as a **modified GPL-3.0 work derived from RipplerX**, for inclusion as a stock engine in the GPL-3.0 BRKTRK source tree.

It is not presented as a clean-room or independently relicensable implementation.

- Upstream project: RipplerX
- Upstream author: Tiago Rodrigues / `tiagolr` / tilr
- Upstream repository: `https://github.com/tiagolr/ripplerx`
- Upstream version aligned in this branch: `1.5.18`
- Initial inspected revision: `e9f6537e5e3d6c648b2463e6a90f15e5f612bb75`
- Upstream license: GNU GPL version 3
- Downstream project: BRK Modal / BRKTRK
- Downstream modifications: Copyright © 2026 Myldy design / Ilya Tolstoukhov
- Downstream license: GNU GPL version 3

## Material used from upstream

BRK Modal may directly port, adapt or preserve:

- modal resonator equations and coefficient behavior;
- model frequency-ratio tables;
- model-specific gain tables;
- serial-coupling and frequency-splitting behavior;
- waveguide tube behavior;
- mallet/noise excitation behavior;
- voice/retrigger ideas;
- parameter names, ranges and semantics where useful;
- factory-program XML and resulting converted preset data.

The P2.5 alignment adds the RipplerX 1.5.18 `Marimba2`, `Bell` and `Djembe` model families and a lossless importer for all 28 factory-program XML files.

Source/state alignment and converted factory programs do not by themselves prove identical audio, lower CPU use or target-device readiness. Those claims require the matched P4.5 evidence package described in `docs/BRK_MODAL_VS_RIPPLERX.md`.

## Downstream modifications

BRK Modal removes the JUCE/DAW wrapper and adapts the engine for a bounded dependency-free BRK runtime. BRK-specific work includes, among other changes:

- synth-only Track × Instrument gateway ownership;
- fixed runtime memory and deterministic processing;
- float32 fixed-array implementation rather than the upstream plug-in's double-oriented dynamic ownership;
- Stable/Reference/Wild coupling profiles;
- bounded-detune Stable coupling;
- Spectral Focus and modal-bank energy normalization;
- tail-preserving note-ID retrigger;
- explicit Damped/Natural/OneShot lifecycle semantics;
- sustain handling and BRK-oriented factory patches;
- permanent parameter identities and deterministic state;
- packed event execution and persistent cross-block ramps;
- generation-protected multi-instance native/WASM module runtime.

The BRK module does not currently carry the complete RipplerX product surface. Notable exclusions/deferred features include JUCE GUI/plug-in wrappers, audio-input excitation, MTS-ESP, sample/user-file mallets, live pitch-wheel glide and 22 source-only controls unused by the factory bank.

These changes and exclusions must be marked as downstream modifications and must not be attributed to the RipplerX author.

## Comparison claim policy

Allowed before P4.5:

- BRK Modal is a compact fixed-memory derivative;
- the current module artifact sizes and memory reservation may be stated exactly;
- the 28 factory programs and 55 used parameters are migrated;
- native and WASM BRK renders match in the documented P4 golden case.

Not allowed before P4.5:

- identical sound to RipplerX;
- lower CPU use than RipplerX;
- a percentage binary-size advantage over the original plug-in;
- comfortable TrimUI Brick support;
- full RipplerX compatibility.

## Distribution requirements

When BRK Modal is conveyed as source or object code:

1. retain upstream copyright and license notices;
2. retain this provenance/modification record;
3. provide the GNU GPL version 3 license text;
4. make the complete corresponding source and build scripts available under GPLv3;
5. identify BRK Modal as a modified work and state the relevant modification dates;
6. keep imported RipplerX factory-program data under the same GPL terms;
7. keep measured comparison claims separate from provenance and source-alignment claims.

This record is an engineering compliance checklist, not a substitute for legal advice.
