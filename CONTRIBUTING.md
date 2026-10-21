# Contributing

BRKTRK original host code is licensed under GPL-3.0-only. By contributing you confirm you have the right to submit your changes and will retain appropriate third-party copyright and license notices.

Submit focused pull requests to main. Run npm test before submission. For audio, input, PWA and UI work, also launch Chromium with npm run dev:engine and npm run serve.

Respect the Song → Chain → Phrase → Instrument references. Preserve distinct Note, Empty and Note Off values. Protect project file compatibility and avoid silently substituting sound engine packages.

Untrusted fork pull requests are tested on isolated GitHub-hosted runners with read-only permissions. No unreviewed external code should execute on maintainers' home or production hosts.

Release tags and deployment are maintained separately from this public source CI.
