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

launcher_tarball=$(find dist/npm -type f -name 'hvir-workbench-[0-9]*.tgz' -print -quit)
if [[ -z "$launcher_tarball" ]]; then
  echo 'hvir-workbench launcher tarball not found below dist/npm' >&2
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

# Release jobs check out an exact commit in detached-HEAD mode, which does not
# guarantee a local main branch or origin/HEAD. Give the packaged application a
# deterministic repository instead of coupling its Git smoke checks to the
# checkout topology supplied by the runner.
fixture="$profile/repository"
mkdir -p "$fixture"
git archive HEAD | tar -x -C "$fixture"
git -C "$fixture" init --quiet --initial-branch=main
git -C "$fixture" config user.name 'hvir packaged smoke'
git -C "$fixture" config user.email 'hvir-smoke@invalid.example'
git -C "$fixture" add --all
git -C "$fixture" commit --quiet -m 'Create packaged smoke fixture'

(
  cd "$fixture"
  HVIR_SMOKE=1 "$launcher" "$fixture" \
    --no-sandbox \
    --user-data-dir="$profile"
)
