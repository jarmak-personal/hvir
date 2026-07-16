#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

profile=$(mktemp -d "${TMPDIR:-/tmp}/hvir-packaged-smoke-profile.XXXXXX")
cleanup() {
  rm -rf "$profile"
}
trap cleanup EXIT

case "$(uname -s):$(uname -m)" in
Darwin:arm64)
  package_name='hvir-darwin-arm64'
  executable_path='app/hvir.app/Contents/MacOS/hvir'
  ;;
Linux:x86_64)
  package_name='hvir-linux-x64'
  executable_path='app/hvir'
  ;;
Linux:aarch64 | Linux:arm64)
  package_name='hvir-linux-arm64'
  executable_path='app/hvir'
  ;;
*)
  echo "Unsupported packaged-smoke host: $(uname -s) $(uname -m)" >&2
  exit 1
  ;;
esac

tarball=$(find dist/npm -type f -name "${package_name}-*.tgz" -print -quit)
if [[ -z "$tarball" ]]; then
  echo "npm payload for $package_name not found below dist/npm" >&2
  exit 1
fi

launcher_tarball=$(find dist/npm -type f -name 'hvir-[0-9]*.tgz' -print -quit)
if [[ -z "$launcher_tarball" ]]; then
  echo 'hvir launcher tarball not found below dist/npm' >&2
  exit 1
fi

npm install \
  --prefix "$profile/npm" \
  --no-audit \
  --no-fund \
  --no-package-lock \
  --no-save \
  "$tarball" \
  "$launcher_tarball"

executable="$profile/npm/node_modules/$package_name/$executable_path"
if [[ ! -x "$executable" ]]; then
  echo "Installed hvir executable is missing: $executable" >&2
  exit 1
fi

if [[ "$(uname -s)" == "Darwin" ]]; then
  file "$executable" | grep -q 'arm64'
else
  expected_arch=$(if [[ "$package_name" == 'hvir-linux-arm64' ]]; then echo 'ARM aarch64'; else echo 'x86-64'; fi)
  file "$executable" | grep -q "$expected_arch"
fi

launcher="$profile/npm/node_modules/.bin/hvir"
if [[ ! -x "$launcher" ]]; then
  echo "Installed hvir launcher is missing: $launcher" >&2
  exit 1
fi

HVIR_SMOKE=1 "$launcher" "$PWD" \
  --no-sandbox \
  --user-data-dir="$profile"
