#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

npm run check-seams
npx eslint electron.vite.config.ts eslint.config.mjs src test
npm run typecheck
npm test
npm run smoke

if [[ "${HVIR_SKIP_CAPACITY:-0}" != "1" ]]; then
  npm run smoke:capacity
fi
