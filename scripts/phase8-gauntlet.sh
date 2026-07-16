#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

npm run verify
npm run smoke

if [[ "${HVIR_SKIP_CAPACITY:-0}" != "1" ]]; then
  npm run smoke:capacity
fi
