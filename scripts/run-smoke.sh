#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

profile=$(mktemp -d "${TMPDIR:-/tmp}/hvir-smoke-profile.XXXXXX")
cleanup() {
  rm -rf "$profile"
}
trap cleanup EXIT

HVIR_SMOKE=1 ./node_modules/.bin/electron . \
  --no-sandbox \
  --user-data-dir="$profile"
