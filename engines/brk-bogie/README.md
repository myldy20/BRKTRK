# BRK Bogie

Fast-path BRK engine built around the standalone MIT-licensed Bogie DSP core from Choo Choo Rack.

P0 admitted the pinned tracker-independent donor core and fixed eight-voice BRK performer. P1 freezes the public parameter/state identity and moves Bogie onto the generic BRK Synth ABI/package path used by BRKTRK.

Models: Kick, Snare, Hat, Clap, Tom, Rim, FM, Noise, Cowbell, Cymbal, Shaker, Clave.

Public alpha parameter contract: Model, Decay, Tone, Sweep, Noise, FM, Drive, Level. **All eight parameters are required to be visible in the host Instrument/Sound UI.** `brk-ui.json` exposes all eight on Main and retains a descriptor-driven All page as a compatibility backstop. Native CI and the package builder both fail if registry/UI coverage diverges.

Donor pin: `paiheulevrai/choochoorack@8986ceff930044780d259128990c142595ecd87d`.

Automation semantics: continuous parameter edits update active one-shot voices as well as future triggers; Level is applied at BRK voice mix time so live fades and locks are audible immediately. Model is discrete/control-rate.

Current P1 surface: canonical 120-byte state v1, BRK Synth ABI v1, fixed eight-instance module runtime, native ABI tests, fixed-memory 4 MiB Emscripten targets, descriptor-driven UI metadata and deterministic `brk-engine-package-v1` preview tooling.

The engine is not yet published in the BRKTRK catalog. It requires a new
source-built package and real browser qualification before release. The
original private preview binary is not republished. See LICENSE_INVENTORY.md.
