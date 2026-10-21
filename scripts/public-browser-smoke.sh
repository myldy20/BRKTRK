#!/usr/bin/env bash
set -euo pipefail

# Run from an isolated clean source checkout after npm run dev:engine.
# Never calls the private CI's engine-store transfer or production environment.
test -f "${BRKTRK_WEB_DIR:-web}/engines/catalog-v1.json" || {
  echo "Build the local synth package first: npm run dev:engine" >&2
  exit 1
}
command -v google-chrome >/dev/null || {
  echo "google-chrome is required for the public browser smoke" >&2
  exit 1
}
tmp="$(mktemp -d /tmp/brktrk-public-chrome.XXXXXXXX)"
server_pid=""
cleanup() {
  set +e
  if [[ -n "$server_pid" ]]; then kill "$server_pid" 2>/dev/null || true; fi
  rm -rf -- "$tmp"
}
trap cleanup EXIT INT TERM

# Bind to the actual ephemeral port (no test-port collision/race).
python3 -u - <<'PY' > "$tmp/server.log" 2>&1 &
import os
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from functools import partial
handler = partial(SimpleHTTPRequestHandler, directory=os.environ.get("BRKTRK_WEB_DIR", "web"))
server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
print("PUBLIC_BROWSER_PORT=" + str(server.server_address[1]), flush=True)
server.serve_forever()
PY
server_pid="$!"
port=""
for i in $(seq 1 100); do
  port="$(sed -n 's/^PUBLIC_BROWSER_PORT=//p' "$tmp/server.log" | head -n 1)"
  if [[ -n "$port" ]]; then break; fi
  if ! kill -0 "$server_pid" 2>/dev/null; then
    cat "$tmp/server.log" >&2
    echo "Public smoke HTTP server failed to start" >&2
    exit 1
  fi
  sleep 0.1
done
[[ "$port" =~ ^[0-9]+$ ]] || { echo "Public smoke server port unavailable" >&2; exit 1; }

for width in 1210 390; do
  profile="$tmp/chrome-$width"
  set +e
  output="$(node scripts/run-browser-cdp-fixture.mjs \
    "http://127.0.0.1:$port/public-source-browser-smoke.html?width=$width" \
    "$profile" "$tmp/chrome-$width.stderr")"
  result=$?
  set -e
  echo "PUBLIC BROWSER $width: $output"
  if [[ "$result" -ne 0 || "$output" != "BRKTRK_BROWSER_TESTS_PASSED" ]]; then
    tail -n 24 "$tmp/chrome-$width.stderr" >&2 || true
    echo "Public browser smoke failed at width $width" >&2
    exit 1
  fi
done

echo "Public browser smoke PASS: desktop 1210px + narrow 390px, real app bootstrap and verified development package"
