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
home_root="$invocation_root/home"
cache_base="$invocation_root/cache"
npm_user_config="$invocation_root/npmrc"
install_log="$invocation_root/npm-install.log"
first_launch_log="$invocation_root/first-launch.log"
second_launch_log="$invocation_root/second-launch.log"

cleanup() {
  if [[ -z "${invocation_root:-}" ]]; then return; fi
  case "$invocation_root" in
  "$temporary_parent"/hvir-packaged-smoke.*)
    local cleanup_status=0
    if [[ -e "$installation_root" ]]; then
      chmod -R u+w "$installation_root" 2>/dev/null || cleanup_status=$?
    fi
    rm -rf -- "$project_root" || cleanup_status=$?
    rm -rf -- "$installation_root" || cleanup_status=$?
    rm -rf -- "$user_data_root" || cleanup_status=$?
    rm -rf -- "$home_root" || cleanup_status=$?
    rm -rf -- "$cache_base" || cleanup_status=$?
    rm -f -- \
      "$npm_user_config" \
      "$install_log" \
      "$first_launch_log" \
      "$second_launch_log" || cleanup_status=$?
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

mkdir -p "$installation_root" "$user_data_root" "$home_root"
: >"$npm_user_config"

case "$(uname -s):$(uname -m)" in
Darwin:arm64)
  package_name='hvir-darwin-arm64'
  executable_path='app/hvir.app/Contents/MacOS/hvir'
  notices_path='app/hvir.app/Contents/Resources/THIRD_PARTY_NOTICES.md'
  native_cache_root="$home_root/Library/Caches/hvir/native"
  ;;
Linux:x86_64)
  package_name='hvir-linux-x64'
  executable_path='app/hvir'
  notices_path='app/resources/THIRD_PARTY_NOTICES.md'
  native_cache_root="$cache_base/hvir/native"
  ;;
Linux:aarch64 | Linux:arm64)
  package_name='hvir-linux-arm64'
  executable_path='app/hvir'
  notices_path='app/resources/THIRD_PARTY_NOTICES.md'
  native_cache_root="$cache_base/hvir/native"
  ;;
*)
  echo "Unsupported packaged-smoke host: $(uname -s) $(uname -m)" >&2
  exit 1
  ;;
esac

package_version=$(node -p "require('./package.json').version")
tarball="dist/npm/${package_name}-${package_version}.tgz"
if [[ ! -f "$tarball" ]]; then
  echo "npm payload for ${package_name}@${package_version} not found: $tarball" >&2
  exit 1
fi

launcher_tarball="dist/npm/hvir-workbench-${package_version}.tgz"
if [[ ! -f "$launcher_tarball" ]]; then
  echo "hvir-workbench@${package_version} launcher tarball not found: $launcher_tarball" >&2
  exit 1
fi

NPM_CONFIG_USERCONFIG="$npm_user_config" npm install \
  --prefix "$installation_root" \
  --no-audit \
  --no-fund \
  --no-package-lock \
  --no-save \
  --ignore-scripts \
  --omit=optional \
  "$tarball" \
  "$launcher_tarball" 2>&1 | tee "$install_log"

if grep -Eiq 'allow-scripts|install scripts not' "$install_log"; then
  echo 'npm reported a hvir install-script approval warning' >&2
  exit 1
fi

platform_package="$installation_root/node_modules/$package_name"
if [[ ! -f "$platform_package/payload.tar.gz" ]]; then
  echo "Installed hvir archive is missing: $platform_package/payload.tar.gz" >&2
  exit 1
fi
if [[ -e "$platform_package/app" ]]; then
  echo "Platform package unexpectedly contains an install-time app directory" >&2
  exit 1
fi
node - "$platform_package/package.json" <<'NODE'
const packageMetadata = require(process.argv[2])
if (packageMetadata.scripts) {
  throw new Error(`${packageMetadata.name} must not declare lifecycle scripts`)
}
NODE

for notices in \
  "$platform_package/THIRD_PARTY_NOTICES.md" \
  "$installation_root/node_modules/hvir-workbench/THIRD_PARTY_NOTICES.md"; do
  if [[ ! -f "$notices" ]]; then
    echo "Installed hvir third-party notices are missing: $notices" >&2
    exit 1
  fi
  grep -Fq 'Copyright (c) 2025 Coder' "$notices"
  grep -Fq 'Copyright (c) 2024 Mitchell Hashimoto, Ghostty contributors' "$notices"
done

launcher="$installation_root/node_modules/.bin/hvir"
if [[ ! -x "$launcher" ]]; then
  echo "Installed hvir launcher is missing: $launcher" >&2
  exit 1
fi

"$source_checkout/scripts/create-smoke-repository.sh" \
  "$source_checkout" \
  "$project_root"

chmod -R a-w "$installation_root"

run_launcher() {
  (
    cd "$project_root"
    HOME="$home_root" \
      XDG_CACHE_HOME="$cache_base" \
      HVIR_SMOKE=1 \
      HVIR_SMOKE_SCENARIO=platform-contracts \
      "$launcher" "$project_root" \
      --no-sandbox \
      --user-data-dir="$user_data_root"
  )
}

run_launcher >"$first_launch_log" 2>&1
cat "$first_launch_log"
grep -Fq "Preparing hvir $package_version" "$first_launch_log"
grep -Fq "Prepared hvir $package_version." "$first_launch_log"

prepared_root="$native_cache_root/$package_name/$package_version"
executable="$prepared_root/$executable_path"
if [[ ! -x "$executable" ]]; then
  echo "Prepared hvir executable is missing: $executable" >&2
  exit 1
fi

for notices in "$prepared_root/$notices_path"; do
  if [[ ! -f "$notices" ]]; then
    echo "Prepared hvir third-party notices are missing: $notices" >&2
    exit 1
  fi
  grep -Fq 'Copyright (c) 2025 Coder' "$notices"
  grep -Fq 'Copyright (c) 2024 Mitchell Hashimoto, Ghostty contributors' "$notices"
done

if [[ "$(uname -s)" == "Darwin" ]]; then
  file "$executable" | grep -q 'arm64'
  framework="$prepared_root/app/hvir.app/Contents/Frameworks/Electron Framework.framework"
  if [[ ! -L "$framework/Versions/Current" ]]; then
    echo "Prepared macOS framework is missing Versions/Current symlink" >&2
    exit 1
  fi
  source_signature_state=$(
    codesign -dvv "$source_checkout/dist/mac-arm64/hvir.app" 2>&1 |
      grep -E '^(Identifier|CodeDirectory|Signature|TeamIdentifier|Sealed Resources|Internal requirements)=' ||
      true
  )
  prepared_signature_state=$(
    codesign -dvv "$prepared_root/app/hvir.app" 2>&1 |
      grep -E '^(Identifier|CodeDirectory|Signature|TeamIdentifier|Sealed Resources|Internal requirements)=' ||
      true
  )
  if [[ "$prepared_signature_state" != "$source_signature_state" ]]; then
    echo 'Prepared macOS application changed the build signature state' >&2
    exit 1
  fi
  if [[ -n "$prepared_signature_state" ]] && \
    ! grep -Eq 'Signature=adhoc|TeamIdentifier=not set' <<<"$prepared_signature_state"; then
    codesign --verify --deep --strict --verbose=2 "$prepared_root/app/hvir.app"
    echo 'Verified prepared macOS application signature.'
  else
    echo 'Verified preparation preserved the documented unsigned development state.'
  fi
else
  expected_arch=$(if [[ "$package_name" == 'hvir-linux-arm64' ]]; then echo 'ARM aarch64'; else echo 'x86-64'; fi)
  file "$executable" | grep -q "$expected_arch"
fi

run_launcher >"$second_launch_log" 2>&1
cat "$second_launch_log"
if grep -Fq 'Preparing hvir' "$second_launch_log"; then
  echo 'A subsequent hvir launch repeated payload preparation' >&2
  exit 1
fi

diagnostic_journal="$user_data_root/runtime-diagnostics.jsonl"
test -f "$diagnostic_journal"
grep -q '"kind":"application-starting"' "$diagnostic_journal"
