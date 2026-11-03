#!/usr/bin/env bash
# A host, build or engine change can affect Modal. Only documentation-only
# changes are exempt; a failure to determine the diff fails the job closed.
set -euo pipefail

if [[ ${EVENT_NAME:?} == workflow_dispatch ]]; then
  printf 'qualify=true\n' >> "${GITHUB_OUTPUT:?}"
  exit 0
fi
[[ $EVENT_NAME == pull_request ]]
base=$(git merge-base "${BASE_SHA:?}" "${HEAD_SHA:?}")
changes=$(mktemp)
trap 'rm -f "$changes"' EXIT
git diff --no-renames --name-only -z "$base" "$HEAD_SHA" -- > "$changes"
qualify=false
while IFS= read -r -d '' path; do
  case "$path" in
    *.md|*.MD) ;;
    *) qualify=true; break ;;
  esac
done < "$changes"
printf 'qualify=%s\n' "$qualify" >> "${GITHUB_OUTPUT:?}"
