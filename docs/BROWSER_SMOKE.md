# Public browser smoke

The public source includes a Chrome DevTools smoke on a temporary `localhost`
origin. It uses only `Node.js 22+`, Python 3 and `google-chrome`, plus the
local development synth. It does not contact private servers or use production
sound packages.

From the exported checkout:

    npm run dev:engine
    npm run test:browser

The test boots the real editor at 1210px desktop and 390px narrow/phone
viewport, waits for native browser-writer input readiness, verifies the actual
UI shell/transport and ProjectStore, fetches the development synth catalog
and uses the production package verification path to retrieve and hash-check
the real BRK DEV POLY archive. It expects nine synth parameters.

This is an executable **first-run startup/engine-availability smoke**. It
does not imply audible playback, real touch gesture qualification, PWA offline
acceptance or the separate full trusted physical matrix. Existing Sound knob
physical hit target issue #525 stays unresolved until retested.

Public GitHub-hosted CI runs the same smoke for fork PRs using an ephemeral
runner with read-only repository access.
