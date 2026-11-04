# BRKTRK

BRKTRK is an eight-track browser music tracker built around reusable Song → Chain → Phrase → Instrument objects.

This public-source candidate corresponds to Web 0.9.0. The original BRKTRK host is released under GNU GPL version 3 only (SPDX: GPL-3.0-only). See LICENSE and NOTICE.md for licensing and third-party credits.

## Play online

Open [BRKTRK on GitHub Pages](https://myldy20.github.io/BRKTRK/). The browser runs the tracker locally. Its catalog includes BRK DEV POLY, BRK DEV FM and the GPL BRK Modal physical-modeling engine. Engine packages load on demand and projects retain their exact package hash.

## Run it

Requirements: Node.js 22+, Python 3, and a current Chromium browser.

    npm run build:store
    npm run serve

To create the compact public artifact after generating the development engine:

    npm run build:web

The output is written to `dist/` (generated only, never committed). Its runtime JS
and CSS are bundled without changing the modular source files in `web/`.
GitHub Actions tests `dist/` in Chromium and deploys it to Pages.

Open http://localhost:8080. Use a web server: opening web/index.html directly does not provide the required secure browser origin.

Development synth packages are generated locally; the public Modal package is copied from the locked release archive and verified before use. A project referring to an unavailable package must fail explicitly instead of silently replacing its engine.

## Test

    npm test
    npm run test:browser

Public CI runs on isolated GitHub-hosted Linux runners with read-only repository permissions, including fork pull requests. The private infrastructure used for full physical audio acceptance and production releases is separate.

BRKTRK remains under active development. Export musical projects frequently and keep backups. See CONTRIBUTING.md, docs/README.md and MIGRATION.md.

The Chromium smoke requires a local `google-chrome` binary after `npm run build:store`.
It checks actual browser bootstrap, both desktop/narrow viewports, and the
hash-verified development engine package. See [Browser Smoke](docs/BROWSER_SMOKE.md).
