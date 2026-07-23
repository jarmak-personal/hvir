#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
source_checkout=$PWD

if [[ "${HVIR_MACOS_PACKAGE_ACCEPTANCE:-}" != '1' ]]; then
  echo 'Refusing to modify native package state without HVIR_MACOS_PACKAGE_ACCEPTANCE=1.' >&2
  exit 1
fi
if [[ "$(uname -s):$(uname -m)" != 'Darwin:arm64' ]]; then
  echo "Native macOS package acceptance requires macOS arm64, found $(uname -s) $(uname -m)." >&2
  exit 1
fi
if [[ "${CI:-}" != 'true' || "${GITHUB_ACTIONS:-}" != 'true' ]]; then
  echo 'Native macOS package acceptance is restricted to an ephemeral GitHub Actions host.' >&2
  exit 1
fi
case "${HVIR_MACOS_PACKAGE_MODE:-}" in
structural | signed) package_mode=$HVIR_MACOS_PACKAGE_MODE ;;
*)
  echo 'HVIR_MACOS_PACKAGE_MODE must be structural or signed.' >&2
  exit 1
  ;;
esac

package_id='dev.hvir.app'
application='/Applications/hvir.app'
executable="$application/Contents/MacOS/hvir"
command='/usr/local/bin/hvir'
inventory='/Library/Application Support/hvir/package-inventory-v1.txt'
receipt="$package_id"
expected_team_id=${HVIR_MACOS_EXPECTED_TEAM_ID:-}
package_version=$(node -p "require('./package.json').version")

shopt -s nullglob
package_matches=(dist/hvir-*-macos-arm64.pkg)
shopt -u nullglob
if [[ ${#package_matches[@]} -ne 1 ]]; then
  echo "Expected exactly one macOS arm64 package, found ${#package_matches[@]}." >&2
  exit 1
fi
package_path="$source_checkout/${package_matches[0]}"

for path in "$application" "$command" "$inventory"; do
  if [[ -e "$path" || -L "$path" ]]; then
    echo "Refusing to replace pre-existing acceptance host state: $path" >&2
    exit 1
  fi
done
if pkgutil --pkg-info "$receipt" >/dev/null 2>&1; then
  echo "Refusing to replace pre-existing package receipt: $receipt" >&2
  exit 1
fi
sudo -n true

temporary_parent=$(cd "${TMPDIR:-/tmp}" && pwd -P)
invocation_root=$(mktemp -d "$temporary_parent/hvir-macos-package-smoke.XXXXXX")
project_root="$invocation_root/repository"
home_root="$invocation_root/home"
user_data_root="$invocation_root/user-data"
legacy_prefix="$invocation_root/legacy-npm"
legacy_root="$legacy_prefix/lib/node_modules"
legacy_launcher="$legacy_prefix/bin/hvir"
old_root="$invocation_root/old-root"
old_package="$invocation_root/hvir-previous.pkg"
old_component_plist="$invocation_root/old-component.plist"
old_installer="$invocation_root/install-previous.sh"
current_installer="$invocation_root/install-current.sh"
previous_command="$invocation_root/hvir-previous-command"
unowned_command="$invocation_root/hvir-unowned-command"
signature_log="$invocation_root/package-signature.log"
install_log="$invocation_root/install.log"
installed_by_smoke=0

remove_package_state() {
  sudo /bin/rm -rf -- "$application"
  sudo /bin/rm -f -- "$command" "$inventory"
  sudo /bin/rmdir '/Library/Application Support/hvir' 2>/dev/null || true
  sudo pkgutil --forget "$receipt" >/dev/null 2>&1 || true
}

cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  if [[ "$installed_by_smoke" -eq 1 ]]; then remove_package_state; fi
  case "$invocation_root" in
  "$temporary_parent"/hvir-macos-package-smoke.*)
    /bin/rm -rf -- "$invocation_root"
    ;;
  *)
    echo "Refusing to clean unexpected macOS package smoke root: $invocation_root" >&2
    status=1
    ;;
  esac
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

mkdir -p \
  "$home_root/Library/Application Support/hvir" \
  "$home_root/Library/Caches/hvir/native" \
  "$user_data_root" \
  "$legacy_prefix/bin" \
  "$legacy_root/hvir-workbench/bin" \
  "$old_root"
printf '%s\n' 'settings-preserved' \
  >"$home_root/Library/Application Support/hvir/settings-smoke.json"
printf '%s\n' 'registered-project-preserved' \
  >"$home_root/Library/Application Support/hvir/registered-projects-smoke.json"
printf '#!/bin/sh\nexit 97\n' \
  >"$legacy_root/hvir-workbench/bin/hvir.mjs"
chmod 0755 "$legacy_root/hvir-workbench/bin/hvir.mjs"
ln -s '../lib/node_modules/hvir-workbench/bin/hvir.mjs' "$legacy_launcher"
printf '%s\n' \
  '#!/bin/sh' \
  'case "$1:$2" in' \
  'prefix:-g) printf "%s\n" "$HVIR_FAKE_NPM_PREFIX" ;;' \
  'root:-g) printf "%s\n" "$HVIR_FAKE_NPM_ROOT" ;;' \
  'ls:-g) printf "%s/hvir-workbench\n" "$HVIR_FAKE_NPM_ROOT" ;;' \
  'uninstall:-g)' \
  '  /bin/rm -f -- "$HVIR_FAKE_NPM_PREFIX/bin/hvir"' \
  '  /bin/rm -rf -- "$HVIR_FAKE_NPM_ROOT/hvir-workbench"' \
  '  ;;' \
  '*) exit 96 ;;' \
  'esac' \
  >"$legacy_prefix/bin/npm"
chmod 0755 "$legacy_prefix/bin/npm"
printf '%s\n' 'derived npm cache' \
  >"$home_root/Library/Caches/hvir/native/cache-smoke-marker"
"$source_checkout/scripts/create-smoke-repository.sh" \
  "$source_checkout" \
  "$project_root"

if [[ "$package_mode" == 'signed' ]]; then
  if [[ -z "$expected_team_id" ]]; then
    echo 'Signed acceptance requires HVIR_MACOS_EXPECTED_TEAM_ID.' >&2
    exit 1
  fi
  pkgutil --check-signature "$package_path" | tee "$signature_log"
  grep -Eq "Developer ID Installer: .+ \\($expected_team_id\\)" "$signature_log"
  grep -Fq 'Signed with a trusted timestamp' "$signature_log"
  xcrun stapler validate "$package_path"
  spctl --assess --type install --verbose=2 "$package_path"
else
  set +e
  pkgutil --check-signature "$package_path" >"$signature_log" 2>&1
  signature_status=$?
  set -e
  cat "$signature_log"
  if [[ "$signature_status" -eq 0 ]] ||
    ! grep -Fq 'Status: no signature' "$signature_log"; then
    echo 'Pull-request package unexpectedly carried an installer signature.' >&2
    exit 1
  fi
fi

expanded_package="$invocation_root/expanded"
pkgutil --expand-full "$package_path" "$expanded_package"
grep -Fq 'hostArchitectures="arm64"' "$expanded_package/Distribution"
grep -Fq 'enable_anywhere="false"' "$expanded_package/Distribution"
grep -Fq 'enable_currentUserHome="false"' "$expanded_package/Distribution"
grep -Fq 'enable_localSystem="true"' "$expanded_package/Distribution"
component_info="$expanded_package/dev.hvir.app.pkg/PackageInfo"
grep -Fq '<upgrade-bundle>' "$component_info"
grep -Fq '<strict-identifier>' "$component_info"
grep -Fq '<preinstall ' "$component_info"
grep -Fq '<postinstall ' "$component_info"

ditto 'dist/mac-arm64/hvir.app' "$old_root/hvir.app"
printf '%s\n' 'remove-during-package-upgrade' \
  >"$old_root/hvir.app/Contents/Resources/hvir-previous-only.txt"
codesign \
  --force \
  --deep \
  --sign - \
  --options runtime \
  --entitlements build/entitlements.mac.plist \
  "$old_root/hvir.app"
codesign --verify --deep --strict --verbose=2 "$old_root/hvir.app"
pkgbuild --analyze --root "$old_root" "$old_component_plist"
plutil -replace '0.BundleIsRelocatable' -bool false "$old_component_plist"
plutil -replace '0.BundleIsVersionChecked' -bool true "$old_component_plist"
plutil -replace '0.BundleHasStrictIdentifier' -bool true "$old_component_plist"
plutil -replace '0.BundleOverwriteAction' -string upgrade "$old_component_plist"
pkgbuild \
  --root "$old_root" \
  --identifier "$package_id" \
  --component-plist "$old_component_plist" \
  --scripts build/pkg-scripts \
  --install-location /Applications \
  --version 0.0.0 \
  "$old_package"

render_acceptance_installer() {
  local package=$1
  local version=$2
  local output=$3
  local unsigned=$4
  local asset_directory="${output%.sh}-assets"
  local linux_x64_artifact="$asset_directory/hvir-${version}-linux-x64.deb"
  local linux_arm64_artifact="$asset_directory/hvir-${version}-linux-arm64.deb"
  local macos_artifact="$asset_directory/$(basename "$package")"

  mkdir "$asset_directory"
  printf '%s\n' 'acceptance-only Linux x64 artifact placeholder' \
    >"$linux_x64_artifact"
  printf '%s\n' 'acceptance-only Linux arm64 artifact placeholder' \
    >"$linux_arm64_artifact"
  ln -s "$package" "$macos_artifact"
  CI=true GITHUB_ACTIONS=true node scripts/render-native-installer.mjs \
    --version "$version" \
    --repository jarmak-personal/hvir \
    --linux-x64-artifact "$linux_x64_artifact" \
    --linux-arm64-artifact "$linux_arm64_artifact" \
    --macos-arm64-artifact "$macos_artifact" \
    --macos-team-id "${expected_team_id:-AAAAAAAAAA}" \
    --output "$output" \
    --acceptance-asset-directory "$asset_directory" \
    --acceptance-unsigned-macos "$unsigned"
}

render_acceptance_installer "$old_package" 0.0.0 "$old_installer" true
if [[ "$package_mode" == 'signed' ]]; then
  render_acceptance_installer \
    "$package_path" \
    "$package_version" \
    "$current_installer" \
    false
else
  render_acceptance_installer \
    "$package_path" \
    "$package_version" \
    "$current_installer" \
    true
fi

HOME="$home_root" \
  PATH="$legacy_prefix/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
  HVIR_FAKE_NPM_PREFIX="$legacy_prefix" \
  HVIR_FAKE_NPM_ROOT="$legacy_root" \
  "$old_installer" | tee "$install_log"
installed_by_smoke=1
test ! -e "$legacy_launcher"
test ! -e "$legacy_root/hvir-workbench"
test ! -e "$home_root/Library/Caches/hvir/native"
grep -Fq 'installer: The install was successful.' "$install_log"
[[ "$(pkgutil --pkg-info-plist "$receipt" | plutil -extract pkg-version raw -)" == '0.0.0' ]]
test -f "$application/Contents/Resources/hvir-previous-only.txt"

run_installed_smoke() {
  local phase=$1
  local scenario=$2
  local log="$invocation_root/${phase}-${scenario}.log"
  local status
  set +e
  (
    cd "$project_root"
    HOME="$home_root" \
      PATH='/usr/bin:/bin:/usr/sbin:/sbin' \
      HVIR_SMOKE=1 \
      HVIR_SMOKE_SCENARIO="$scenario" \
      "$command" . \
      --user-data-dir="$user_data_root"
  ) >"$log" 2>&1
  status=$?
  set -e
  cat "$log"
  if [[ "$status" -ne 0 ]]; then
    echo "Installed hvir smoke failed during $phase $scenario with status $status." >&2
    exit "$status"
  fi
  grep -Fq 'HVIR_SMOKE_OK' "$log"
}

run_installed_smoke previous pty-native

cp "$command" "$previous_command"
printf '%s\n' '#!/bin/sh' '# deliberately-unowned-hvir-command' 'exit 75' \
  >"$unowned_command"
chmod 0755 "$unowned_command"
sudo /usr/bin/install -o root -g wheel -m 0755 "$unowned_command" "$command"
set +e
sudo /usr/sbin/installer -pkg "$package_path" -target / \
  >"$invocation_root/broken-update.log" 2>&1
broken_status=$?
set -e
cat "$invocation_root/broken-update.log"
if [[ "$broken_status" -eq 0 ]]; then
  echo 'Postinstall-rejected package update unexpectedly succeeded.' >&2
  exit 1
fi
sudo /usr/bin/install -o root -g wheel -m 0755 "$previous_command" "$command"
[[ "$(pkgutil --pkg-info-plist "$receipt" | plutil -extract pkg-version raw -)" == '0.0.0' ]]
test -f "$application/Contents/Resources/hvir-previous-only.txt"
run_installed_smoke retained-after-failed-update pty-native

HOME="$home_root" \
  PATH='/usr/bin:/bin:/usr/sbin:/sbin' \
  "$current_installer" | tee "$install_log"
grep -Fq 'installer: The upgrade was successful.' "$install_log"
receipt_version=$(pkgutil --pkg-info-plist "$receipt" |
  plutil -extract pkg-version raw -) || {
  echo 'Could not read the installed package receipt version.' >&2
  exit 1
}
echo "Installed receipt version: $receipt_version"
bundle_version=$(plutil -extract CFBundleShortVersionString raw \
  "$application/Contents/Info.plist") || {
  echo 'Could not read the installed application version.' >&2
  exit 1
}
echo "Installed bundle version: $bundle_version"
application_state=$(stat -f '%Su:%Sg:%Lp' "$application") || {
  echo 'Could not read installed application ownership.' >&2
  exit 1
}
echo "Application ownership: $application_state"
command_state=$(stat -f '%Su:%Sg:%Lp' "$command") || {
  echo 'Could not read installed command ownership.' >&2
  exit 1
}
echo "Command ownership: $command_state"
inventory_state=$(stat -f '%Su:%Sg:%Lp' "$inventory") || {
  echo 'Could not read installed inventory ownership.' >&2
  exit 1
}
echo "Inventory ownership: $inventory_state"
[[ "$receipt_version" == "$package_version" ]] || {
  echo "Expected receipt version $package_version, found $receipt_version." >&2
  exit 1
}
[[ "$bundle_version" == "$package_version" ]] || {
  echo "Expected bundle version $package_version, found $bundle_version." >&2
  exit 1
}
if [[ -e "$application/Contents/Resources/hvir-previous-only.txt" ]]; then
  echo 'Package upgrade retained a stale application file.' >&2
  exit 1
fi
[[ "$application_state" == 'root:wheel:755' ]] || {
  echo "Unexpected application ownership: $application_state" >&2
  exit 1
}
[[ "$command_state" == 'root:wheel:755' ]] || {
  echo "Unexpected command ownership: $command_state" >&2
  exit 1
}
[[ "$inventory_state" == 'root:wheel:644' ]] || {
  echo "Unexpected inventory ownership: $inventory_state" >&2
  exit 1
}
grep -Fq 'hvir-native-package-command-v1' "$command"
grep -Fxq 'hvir-native-package-inventory-v1' "$inventory"
grep -Fxq 'package-id=dev.hvir.app' "$inventory"
grep -Fxq 'application=/Applications/hvir.app' "$inventory"
grep -Fxq 'command=/usr/local/bin/hvir' "$inventory"
grep -Fxq 'inventory=/Library/Application Support/hvir/package-inventory-v1.txt' \
  "$inventory"
grep -Fxq 'receipt=dev.hvir.app' "$inventory"
if ! pkgutil --files "$receipt" |
  grep -Fx 'hvir.app/Contents/MacOS/hvir' >/dev/null; then
  echo 'Package receipt does not own the installed hvir executable.' >&2
  exit 1
fi

executable_description=$(file "$executable")
if [[ "$executable_description" != *'Mach-O'* ||
  "$executable_description" != *'arm64'* ]]; then
  echo "Installed executable is not an arm64 Mach-O: $executable_description" >&2
  exit 1
fi
framework="$application/Contents/Frameworks/Electron Framework.framework"
test -L "$framework/Versions/Current"
otool -L "$executable" | grep -Fq 'Electron Framework.framework'
native_modules=()
while IFS= read -r native_module; do
  native_modules+=("$native_module")
done < <(
  find "$application" -type f -name '*.node' \
    \( -path '*/build/Release/*' \
    -o -path '*/bin/darwin-arm64-*/*' \
    -o -path '*/prebuilds/darwin-arm64/*' \) \
    -print
)
if [[ ${#native_modules[@]} -eq 0 ]]; then
  echo 'Installed application contains no macOS arm64 native modules.' >&2
  exit 1
fi
for native_module in "${native_modules[@]}"; do
  native_description=$(file "$native_module")
  if [[ "$native_description" != *'Mach-O'* ||
    "$native_description" != *'arm64'* ]]; then
    echo "Installed native module is not an arm64 Mach-O: $native_description" >&2
    exit 1
  fi
done
notices="$application/Contents/Resources/THIRD_PARTY_NOTICES.md"
grep -Fq 'Copyright (c) 2025 Coder' "$notices"
grep -Fq 'Copyright (c) 2024 Mitchell Hashimoto, Ghostty contributors' "$notices"

if [[ "$package_mode" == 'signed' ]]; then
  codesign --verify --deep --strict --verbose=2 "$application"
  codesign -dvvv "$application" 2>"$invocation_root/app-signature.log"
  grep -Fq "TeamIdentifier=$expected_team_id" "$invocation_root/app-signature.log"
  spctl --assess --type exec --verbose=2 "$application"
else
  if codesign -dvvv "$application" 2>"$invocation_root/app-signature.log" &&
    grep -Fq 'Authority=Developer ID Application:' "$invocation_root/app-signature.log"; then
    echo 'Pull-request application unexpectedly carried a Developer ID signature.' >&2
    exit 1
  fi
fi

run_installed_smoke current pty-native
run_installed_smoke current platform-contracts

if HOME="$home_root" \
  PATH='/usr/bin:/bin:/usr/sbin:/sbin' \
  "$command" "$invocation_root/missing-project" \
  >"$invocation_root/invalid-project.log" 2>&1; then
  echo 'Invalid public project path unexpectedly launched hvir.' >&2
  exit 1
fi
grep -Fq 'project is not a local directory' "$invocation_root/invalid-project.log"

HOME="$home_root" \
  PATH='/usr/bin:/bin:/usr/sbin:/sbin' \
  "$current_installer" --uninstall
installed_by_smoke=0
for path in "$application" "$command" "$inventory"; do
  if [[ -e "$path" || -L "$path" ]]; then
    echo "Package-owned state survived removal: $path" >&2
    exit 1
  fi
done
if pkgutil --pkg-info "$receipt" >/dev/null 2>&1; then
  echo "Package receipt survived removal: $receipt" >&2
  exit 1
fi
test -f "$home_root/Library/Application Support/hvir/settings-smoke.json"
test -f "$home_root/Library/Application Support/hvir/registered-projects-smoke.json"
test -d "$project_root/.git"

HOME="$home_root" \
  PATH='/usr/bin:/bin:/usr/sbin:/sbin' \
  "$current_installer" >/dev/null
installed_by_smoke=1
mkdir -p "$home_root/Library/Caches/hvir"
printf '%s\n' 'purge-cache' \
  >"$home_root/Library/Caches/hvir/cache-smoke-marker"
HOME="$home_root" \
  PATH='/usr/bin:/bin:/usr/sbin:/sbin' \
  "$current_installer" --uninstall --purge >/dev/null
installed_by_smoke=0
test ! -e "$home_root/Library/Application Support/hvir"
test ! -e "$home_root/Library/Caches/hvir"
test -d "$project_root/.git"

echo "Accepted $package_mode macOS arm64 native installer lifecycle."
