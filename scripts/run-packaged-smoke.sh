#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
source_checkout=$PWD

# Release and contributor hooks export repository-local Git variables. Do not
# let them redirect packaged acceptance away from the temp project.
while IFS= read -r variable; do
  if [[ -n "$variable" ]]; then unset "$variable"; fi
done < <(git -C "$source_checkout" rev-parse --local-env-vars)

temporary_parent=$(cd "${TMPDIR:-/tmp}" && pwd -P)
invocation_root=$(mktemp -d "$temporary_parent/hvir-packaged-smoke.XXXXXX")
installation_root="$invocation_root/installation"
project_root="$invocation_root/repository"
user_data_root="$invocation_root/user-data"

cleanup() {
  if [[ -z "${invocation_root:-}" ]]; then return; fi
  case "$invocation_root" in
  "$temporary_parent"/hvir-packaged-smoke.*)
    local cleanup_status=0
    rm -rf -- "$project_root" || cleanup_status=$?
    rm -rf -- "$installation_root" || cleanup_status=$?
    rm -rf -- "$user_data_root" || cleanup_status=$?
    rmdir -- "$invocation_root" 2>/dev/null || {
      if [[ -e "$invocation_root" ]]; then cleanup_status=1; fi
    }
    if [[ "$cleanup_status" -eq 0 ]]; then invocation_root=''; fi
    return "$cleanup_status"
    ;;
  *)
    echo "Refusing to clean unexpected packaged-smoke root: $invocation_root" >&2
    return 1
    ;;
  esac
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

mkdir -p "$user_data_root"

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
  --prefix "$installation_root" \
  --no-audit \
  --no-fund \
  --no-package-lock \
  --no-save \
  "$tarball" \
  "$launcher_tarball"

executable="$installation_root/node_modules/$package_name/$executable_path"
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

launcher="$installation_root/node_modules/.bin/hvir"
if [[ ! -x "$launcher" ]]; then
  echo "Installed hvir launcher is missing: $launcher" >&2
  exit 1
fi

"$source_checkout/scripts/create-smoke-repository.sh" \
  "$source_checkout" \
  "$project_root"

(
  cd "$project_root"
  HVIR_SMOKE=1 "$launcher" "$project_root" \
    --no-sandbox \
    --user-data-dir="$user_data_root"
)
