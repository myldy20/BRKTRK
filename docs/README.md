# Architecture at a glance

- web/: tracker UI, PWA, stores, audio runtime, PWA runtime, selected browser test fixtures and deterministic regressions.
- engines/brk-dev-poly/runtime/: locally packaged reference/development synthesizer implementation.
- scripts/build-dev-engine-store.mjs: creates the local engine catalog, archive and hashes.
- fixtures/: portable project-format samples.
- .github/workflows/ci.yml: small public test pipeline on disposable GitHub-hosted runners.
- .github/workflows/pages.yml: tested static build (including the GPLv3 dev synth) and GitHub Pages deployment from trusted main; no self-hosted infrastructure.

The engine host has separate storage, navigation and transport ownership. AudioWorklet is the authoritative realtime execution path; engine packages have pinned identity and hash integrity checks.

Production package catalogs, trusted exact browser/physical tests, internal release history and personal server deployment belong to the private engineering environment. They are not required to work on the public source.

Public export excludes legacy one-off browser smoke pages not in the PWA
cache, and internal physical-owner sample projects. Private trusted browser
acceptance continues in the engineering repository.
