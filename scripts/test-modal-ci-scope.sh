#!/usr/bin/env bash
set -euo pipefail
script=$(cd "$(dirname "$0")" && pwd)/modal-ci-scope.sh
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
cd "$tmp"
git init -q
git config user.name 'CI test'
git config user.email 'ci-test@example.invalid'
mkdir -p docs web
printf 'base\n' > docs/guide.md
printf 'base\n' > web/audio.js
git add .
git commit -qm base
base=$(git rev-parse HEAD)
output="$tmp/.git/scope-output"
check() {
  local expected=$1 event=$2 head=$3
  : > "$output"
  EVENT_NAME="$event" BASE_SHA="$base" HEAD_SHA="$head" GITHUB_OUTPUT="$output" bash "$script"
  [[ $(cat "$output") == "qualify=$expected" ]] || { echo "unexpected scope: $(cat "$output")" >&2; exit 1; }
}
check true workflow_dispatch "$base"
printf 'docs\n' >> docs/guide.md
git add .
git commit -qm docs
docs_head=$(git rev-parse HEAD)
check false pull_request "$docs_head"
printf '{}\n' > docs/golden.json
git add .
git commit -qm 'update test fixture'
check true pull_request "$(git rev-parse HEAD)"
git reset -q --hard "$docs_head"
printf 'host change\n' >> web/audio.js
git add .
git commit -qm 'fix playback'
check true pull_request "$(git rev-parse HEAD)"
git mv web/audio.js docs/audio.md
git commit -qm 'move host file'
check true pull_request "$(git rev-parse HEAD)"
if EVENT_NAME=pull_request BASE_SHA=not-a-commit HEAD_SHA=HEAD GITHUB_OUTPUT="$output" bash "$script" 2>/dev/null; then
  echo 'invalid base unexpectedly accepted' >&2
  exit 1
fi
echo 'Modal CI scope detection PASS'
