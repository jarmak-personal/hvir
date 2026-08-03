#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
source_checkout=$PWD

if [[ "${HVIR_LINUX_PACKAGE_ACCEPTANCE:-}" != '1' ]]; then
  echo 'Set HVIR_LINUX_PACKAGE_ACCEPTANCE=1 on a disposable compatible Linux host.' >&2
  exit 2
fi

if [[ "$(id -u)" -eq 0 ]]; then
  echo 'Run native package acceptance as an unprivileged user with sudo access.' >&2
  exit 2
fi
apparmor_integration_required=0
apparmor_userns_restriction=/proc/sys/kernel/apparmor_restrict_unprivileged_userns
if [[ -r "$apparmor_userns_restriction" ]] &&
  [[ "$(<"$apparmor_userns_restriction")" == '1' ]]; then
  apparmor_integration_required=1
  if ! command -v apparmor_status >/dev/null 2>&1 ||
    ! apparmor_status --enabled >/dev/null 2>&1; then
    echo 'Native package acceptance requires active AppArmor enforcement on this host.' >&2
    exit 2
  fi
fi

case "$(uname -m)" in
x86_64)
  deb_arch='amd64'
  binary_arch='x86-64'
  ;;
aarch64 | arm64)
  deb_arch='arm64'
  binary_arch='ARM aarch64'
  ;;
*)
  echo "Unsupported Linux package acceptance architecture: $(uname -m)" >&2
  exit 2
  ;;
esac

package_version=$(node -p "require('./package.json').version")
package_path="$source_checkout/dist/hvir_${package_version}_${deb_arch}.deb"
if [[ ! -f "$package_path" ]]; then
  echo "Native hvir package is missing: $package_path" >&2
  exit 1
fi
if dpkg-query -W -f='${Status}' hvir 2>/dev/null | grep -Fq 'install ok installed'; then
  echo 'Native package acceptance requires a host without hvir already installed.' >&2
  exit 2
fi

temporary_parent=$(cd "${TMPDIR:-/tmp}" && pwd -P)
invocation_root=$(mktemp -d "$temporary_parent/hvir-linux-package-smoke.XXXXXX")
project_root="$invocation_root/repository"
home_root="$invocation_root/home"
config_root="$invocation_root/config"
user_state_root="$config_root/hvir"
blocked_tools_root="$invocation_root/blocked-tools"
legacy_prefix="$invocation_root/legacy-npm"
legacy_root="$legacy_prefix/lib/node_modules"
legacy_launcher="$legacy_prefix/bin/hvir"
previous_package_root="$invocation_root/previous-package"
previous_package="$invocation_root/hvir_previous_${deb_arch}.deb"
previous_installer="$invocation_root/install-previous.sh"
current_installer="$invocation_root/install-current.sh"
install_log="$invocation_root/install.log"
shadowed_install_log="$invocation_root/shadowed-install.log"
update_log="$invocation_root/update.log"
remove_log="$invocation_root/remove.log"
package_installed=0

cleanup() {
  cleanup_status=0
  if [[ "$package_installed" -eq 1 ]] ||
    dpkg-query -W -f='${Status}' hvir 2>/dev/null | grep -Fq 'install ok installed'; then
    sudo /usr/bin/apt remove -y hvir >/dev/null 2>&1 || cleanup_status=$?
  fi
  case "$invocation_root" in
  "$temporary_parent"/hvir-linux-package-smoke.*)
    rm -rf -- "$invocation_root" || cleanup_status=$?
    ;;
  *)
    echo "Refusing to clean unexpected package-smoke root: $invocation_root" >&2
    cleanup_status=1
    ;;
  esac
  return "$cleanup_status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

mkdir -p \
  "$home_root" \
  "$user_state_root" \
  "$blocked_tools_root" \
  "$legacy_prefix/bin" \
  "$legacy_root/hvir-workbench/bin" \
  "$invocation_root/cache/hvir/native"
"$source_checkout/scripts/create-smoke-repository.sh" \
  "$source_checkout" \
  "$project_root"
printf 'preserve hvir settings\n' >"$user_state_root/settings-smoke-marker"
printf 'preserve registered projects\n' >"$user_state_root/projects-smoke-marker"
for blocked_tool in node npm npx; do
  printf '#!/bin/sh\nexit 97\n' >"$blocked_tools_root/$blocked_tool"
  chmod 0755 "$blocked_tools_root/$blocked_tool"
done
printf '#!/bin/sh\nexit 97\n' \
  >"$legacy_root/hvir-workbench/bin/hvir.mjs"
chmod 0755 "$legacy_root/hvir-workbench/bin/hvir.mjs"
ln -s '../lib/node_modules/hvir-workbench/bin/hvir.mjs' "$legacy_launcher"
printf '#!/bin/sh\nexit 95\n' >"$blocked_tools_root/hvir"
chmod 0755 "$blocked_tools_root/hvir"
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
printf 'derived npm cache\n' >"$invocation_root/cache/hvir/native/cache-smoke-marker"

dpkg-deb --raw-extract "$package_path" "$previous_package_root"
previous_version='0.0.0'
sed -i "s/^Version:.*/Version: $previous_version/" \
  "$previous_package_root/DEBIAN/control"
dpkg-deb --root-owner-group --build "$previous_package_root" "$previous_package" >/dev/null

render_acceptance_installer() {
  local package=$1
  local version=$2
  local output=$3
  local asset_directory="${output%.sh}-assets"
  local linux_artifact="$asset_directory/$(basename "$package")"
  local macos_artifact="$asset_directory/hvir-${version}-macos-arm64.pkg"

  mkdir "$asset_directory"
  ln -s "$package" "$linux_artifact"
  printf '%s\n' 'acceptance-only macOS arm64 artifact placeholder' \
    >"$macos_artifact"
  CI=true GITHUB_ACTIONS=true node scripts/render-native-installer.mjs \
    --version "$version" \
    --repository jarmak-personal/hvir \
    --linux-x64-artifact "$linux_artifact" \
    --linux-arm64-artifact "$linux_artifact" \
    --macos-arm64-artifact "$macos_artifact" \
    --macos-team-id AAAAAAAAAA \
    --output "$output" \
    --acceptance-asset-directory "$asset_directory" \
    --acceptance-unsigned-macos true
}

render_acceptance_installer \
  "$previous_package" \
  "$previous_version" \
  "$previous_installer"
render_acceptance_installer "$package_path" "$package_version" "$current_installer"

require_equal() {
  actual=$1
  expected=$2
  label=$3
  if [[ "$actual" != "$expected" ]]; then
    echo "Native package contract failed for $label: $actual != $expected" >&2
    exit 1
  fi
}

require_file() {
  path=$1
  label=$2
  if [[ ! -f "$path" ]]; then
    echo "Native package contract failed for $label: missing $path" >&2
    exit 1
  fi
}

require_contains() {
  path=$1
  expected=$2
  label=$3
  if ! grep -Fq "$expected" "$path"; then
    echo "Native package contract failed for $label: $path lacks $expected" >&2
    exit 1
  fi
}

assert_package_contract() {
  expected_version=$1
  installed_version=$(dpkg-query -W -f='${Version}' hvir)
  require_equal "$installed_version" "$expected_version" 'installed version'
  require_equal \
    "$(dpkg-query -W -f='${Architecture}' hvir)" \
    "$deb_arch" \
    'Debian architecture'

  require_equal "$(stat -c '%U:%G' /opt/hvir)" 'root:root' '/opt/hvir ownership'
  require_equal \
    "$(stat -c '%U:%G' /opt/hvir/hvir)" \
    'root:root' \
    'executable ownership'
  require_equal \
    "$(stat -c '%U:%G' /usr/bin/hvir)" \
    'root:root' \
    'command ownership'
  require_equal \
    "$(readlink -f /usr/bin/hvir)" \
    '/opt/hvir/resources/hvir-command' \
    'command target'
  require_contains /usr/bin/hvir 'hvir-native-package-command-v1' 'command marker'
  binary_description=$(file /opt/hvir/hvir)
  if [[ "$binary_description" != *"$binary_arch"* ]]; then
    echo \
      "Native package contract failed for executable architecture: $binary_description" \
      >&2
    exit 1
  fi

  desktop_entry=/usr/share/applications/hvir.desktop
  require_file "$desktop_entry" 'desktop entry'
  require_contains "$desktop_entry" 'Exec=/opt/hvir/hvir %U' 'desktop command'
  for icon_size in 16 32 64 128 256 512 1024; do
    installed_icon="/usr/share/icons/hicolor/${icon_size}x${icon_size}/apps/hvir.png"
    require_file "$installed_icon" "${icon_size}px application icon"
    if ! cmp \
      "build/icons-linux/${icon_size}x${icon_size}.png" \
      "$installed_icon"; then
      echo \
        "Installed ${icon_size}px icon differs from the platform-owned Linux asset." \
        >&2
      exit 1
    fi
  done
  notices=/opt/hvir/resources/THIRD_PARTY_NOTICES.md
  require_file "$notices" 'third-party notices'
  require_contains "$notices" 'Copyright (c) 2025 Coder' 'Coder notice'
  require_contains \
    "$notices" \
    'Copyright (c) 2024 Mitchell Hashimoto, Ghostty contributors' \
    'Ghostty notice'

  apparmor_profile=/etc/apparmor.d/hvir
  if [[ "$apparmor_integration_required" -eq 1 ]]; then
    require_file "$apparmor_profile" 'AppArmor profile'
    require_equal \
      "$(stat -c '%U:%G:%a' "$apparmor_profile")" \
      'root:root:644' \
      'AppArmor profile ownership and mode'
    require_contains \
      "$apparmor_profile" \
      'profile "hvir" "/opt/hvir/hvir" flags=(unconfined)' \
      'AppArmor executable attachment'
    require_contains "$apparmor_profile" 'userns,' 'AppArmor user namespace permission'
    sudo apparmor_parser --skip-kernel-load --debug /etc/apparmor.d/hvir >/dev/null
    apparmor_summary=$(sudo apparmor_status)
    if ! grep -Eq '^[[:space:]]+hvir$' <<<"$apparmor_summary"; then
      echo 'Native package contract failed for loaded AppArmor profile:' >&2
      printf '%s\n' "$apparmor_summary" >&2
      exit 1
    fi
  elif [[ -e "$apparmor_profile" ]]; then
    echo 'Native package installed an AppArmor profile on a host that does not require it.' >&2
    exit 1
  fi

  sandbox_owner_mode=$(stat -c '%U:%G:%a' /opt/hvir/chrome-sandbox)
  case "$sandbox_owner_mode" in
  root:root:755 | root:root:4755) ;;
  *)
    echo "Unsafe Chromium sandbox helper ownership or mode: $sandbox_owner_mode" >&2
    exit 1
    ;;
  esac
}

assert_packaged_runtime() {
  node scripts/inspect-packaged-runtime.mts \
    --archive /opt/hvir/resources/app.asar \
    --native-architecture "$binary_arch" \
    --native-platform linux
}

run_installed_startup() {
  stage=$1
  node scripts/installed-startup-probe.mts \
    --command /usr/bin/hvir \
    --expected-main /opt/hvir/hvir \
    --project-root "$project_root" \
    --runtime-root "$invocation_root/runtime-$stage" \
    --path "$blocked_tools_root:/usr/sbin:/usr/bin:/sbin:/bin"
}

if HOME="$home_root" \
  PATH="$legacy_prefix/bin:$blocked_tools_root:/usr/sbin:/usr/bin:/sbin:/bin" \
  HVIR_FAKE_NPM_PREFIX="$legacy_prefix" \
  HVIR_FAKE_NPM_ROOT="$legacy_root" \
  XDG_CONFIG_HOME="$config_root" \
  XDG_CACHE_HOME="$invocation_root/cache" \
  "$previous_installer" >"$shadowed_install_log" 2>&1; then
  echo 'Native installer accepted a second command shadowing /usr/bin/hvir.' >&2
  exit 1
fi
package_installed=1
sed -n '1,240p' "$shadowed_install_log"
grep -Fq \
  'Another hvir command shadows the installed native command:' \
  "$shadowed_install_log"
test ! -e "$legacy_launcher"
test ! -e "$legacy_root/hvir-workbench"
test ! -e "$invocation_root/cache/hvir/native"
rm "$blocked_tools_root/hvir"

HOME="$home_root" \
  PATH="$blocked_tools_root:/usr/sbin:/usr/bin:/sbin:/bin" \
  XDG_CONFIG_HOME="$config_root" \
  XDG_CACHE_HOME="$invocation_root/cache" \
  "$previous_installer" 2>&1 | tee "$install_log"
assert_package_contract "$previous_version"
assert_packaged_runtime
run_installed_startup previous

HOME="$home_root" \
  PATH="$blocked_tools_root:/usr/sbin:/usr/bin:/sbin:/bin" \
  XDG_CONFIG_HOME="$config_root" \
  XDG_CACHE_HOME="$invocation_root/cache" \
  "$current_installer" 2>&1 | tee "$update_log"
assert_package_contract "$package_version"
assert_packaged_runtime
run_installed_startup current

if HOME="$home_root" \
  PATH="$blocked_tools_root:/usr/sbin:/usr/bin:/sbin:/bin" \
  XDG_CONFIG_HOME="$config_root" \
  XDG_CACHE_HOME="$invocation_root/cache" \
  /usr/bin/hvir "$invocation_root/missing-project" \
  >"$invocation_root/invalid-project.log" 2>&1; then
  echo 'Invalid public project path unexpectedly launched hvir.' >&2
  exit 1
fi
grep -Fq 'project is not a local directory' "$invocation_root/invalid-project.log"

HOME="$home_root" \
  PATH="$blocked_tools_root:/usr/sbin:/usr/bin:/sbin:/bin" \
  XDG_CONFIG_HOME="$config_root" \
  XDG_CACHE_HOME="$invocation_root/cache" \
  "$current_installer" --uninstall 2>&1 | tee "$remove_log"
package_installed=0
if [[ -e /usr/bin/hvir || -e /opt/hvir || -e /etc/apparmor.d/hvir ]]; then
  echo 'Native package removal left package-owned files behind.' >&2
  exit 1
fi
if [[ "$apparmor_integration_required" -eq 1 ]] &&
  sudo apparmor_status | grep -Eq '^[[:space:]]+hvir$'; then
  echo 'Native package removal left the hvir AppArmor profile loaded.' >&2
  exit 1
fi
test -f "$user_state_root/settings-smoke-marker"
test -f "$user_state_root/projects-smoke-marker"
test -d "$project_root/.git"

HOME="$home_root" \
  PATH="$blocked_tools_root:/usr/sbin:/usr/bin:/sbin:/bin" \
  XDG_CONFIG_HOME="$config_root" \
  XDG_CACHE_HOME="$invocation_root/cache" \
  "$current_installer" >/dev/null
package_installed=1
mkdir -p "$invocation_root/cache/hvir"
printf 'purge cache\n' >"$invocation_root/cache/hvir/cache-smoke-marker"
HOME="$home_root" \
  PATH="$blocked_tools_root:/usr/sbin:/usr/bin:/sbin:/bin" \
  XDG_CONFIG_HOME="$config_root" \
  XDG_CACHE_HOME="$invocation_root/cache" \
  "$current_installer" --uninstall --purge >/dev/null
package_installed=0
test ! -e "$user_state_root"
test ! -e "$invocation_root/cache/hvir"
test -d "$project_root/.git"

echo "Verified hvir ${package_version} ${deb_arch} native installer lifecycle."
