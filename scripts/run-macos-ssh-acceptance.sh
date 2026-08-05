#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

build_only=false
case "${1:-}" in
'') ;;
--build-only) build_only=true ;;
*)
  echo 'Usage: scripts/run-macos-ssh-acceptance.sh [--build-only]' >&2
  exit 1
  ;;
esac
if [[ $# -gt 1 ]]; then
  echo 'Usage: scripts/run-macos-ssh-acceptance.sh [--build-only]' >&2
  exit 1
fi

if [[ "$(uname -s):$(uname -m)" != 'Darwin:arm64' ]]; then
  echo "Signed macOS SSH acceptance requires macOS arm64, found $(uname -s) $(uname -m)." >&2
  exit 1
fi
missing=false
for name in \
  MACOS_APPLICATION_CERTIFICATE \
  MACOS_APPLICATION_CERTIFICATE_PASSWORD \
  MACOS_TEAM_ID; do
  if [[ -z "${!name:-}" ]]; then
    echo "$name is required for the Apple-issued SSH acceptance identity." >&2
    missing=true
  fi
done
if [[ "$missing" == true ]]; then
  echo 'Refusing to build or launch an ad-hoc or raw Electron SSH acceptance app.' >&2
  exit 1
fi
if [[ ! "$MACOS_TEAM_ID" =~ ^[A-Z0-9]{10}$ ]]; then
  echo 'MACOS_TEAM_ID must be a ten-character Apple Developer Team ID.' >&2
  exit 1
fi

export CSC_LINK=$MACOS_APPLICATION_CERTIFICATE
export CSC_KEY_PASSWORD=$MACOS_APPLICATION_CERTIFICATE_PASSWORD
export CSC_FOR_PULL_REQUEST=true
export CSC_IDENTITY_AUTO_DISCOVERY=false

npm run build -- --mode ssh-acceptance
./node_modules/.bin/electron-builder \
  --mac dir \
  --arm64 \
  --publish never \
  --config electron-builder.ssh-acceptance.yml

application='dist/ssh-acceptance/mac-arm64/hvir SSH Acceptance.app'
scripts/record-macos-ssh-identity.sh --acceptance "$application"
echo 'Acceptance user-data root: hvir-ssh-acceptance (under macOS Application Support)'

if [[ "$build_only" == true ]]; then
  echo "Built the signed SSH acceptance application at $application"
  exit 0
fi

executable_name=$(plutil -extract CFBundleExecutable raw \
  "$application/Contents/Info.plist")
executable="$application/Contents/MacOS/$executable_name"
unset \
  MACOS_APPLICATION_CERTIFICATE \
  MACOS_APPLICATION_CERTIFICATE_PASSWORD \
  MACOS_TEAM_ID \
  CSC_LINK \
  CSC_KEY_PASSWORD \
  CSC_FOR_PULL_REQUEST \
  CSC_IDENTITY_AUTO_DISCOVERY
echo 'Launching the exact signed SSH acceptance application; no fallback is permitted.'
exec "$executable"
