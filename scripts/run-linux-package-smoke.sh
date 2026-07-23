#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
source_checkout=$PWD

if [[ "${HVIR_LINUX_PACKAGE_ACCEPTANCE:-}" != '1' ]]; then
  echo 'Set HVIR_LINUX_PACKAGE_ACCEPTANCE=1 on a disposable Ubuntu 24.04 host.' >&2
  exit 2
fi

source /etc/os-release
if [[ "${ID:-}" != 'ubuntu' || "${VERSION_ID:-}" != '24.04' ]]; then
  echo "Native package acceptance requires Ubuntu 24.04; found ${ID:-unknown} ${VERSION_ID:-unknown}." >&2
  exit 2
fi
if [[ "$(id -u)" -eq 0 ]]; then
  echo 'Run native package acceptance as an unprivileged user with sudo access.' >&2
  exit 2
fi
if ! command -v apparmor_status >/dev/null 2>&1 ||
  ! apparmor_status --enabled >/dev/null 2>&1; then
  echo 'Native package acceptance requires active Ubuntu AppArmor enforcement.' >&2
  exit 2
fi
if [[ ! -r /proc/sys/kernel/apparmor_restrict_unprivileged_userns ]] ||
  [[ "$(< /proc/sys/kernel/apparmor_restrict_unprivileged_userns)" != '1' ]]; then
  echo 'Ubuntu unprivileged-user-namespace restriction is not active.' >&2
  exit 2
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
previous_package_root="$invocation_root/previous-package"
previous_package="$invocation_root/hvir_previous_${deb_arch}.deb"
install_log="$invocation_root/install.log"
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

mkdir -p "$home_root" "$user_state_root" "$blocked_tools_root"
"$source_checkout/scripts/create-smoke-repository.sh" \
  "$source_checkout" \
  "$project_root"
printf 'preserve hvir settings\n' >"$user_state_root/settings-smoke-marker"
printf 'preserve registered projects\n' >"$user_state_root/projects-smoke-marker"
for blocked_tool in node npm npx; do
  printf '#!/bin/sh\nexit 97\n' >"$blocked_tools_root/$blocked_tool"
  chmod 0755 "$blocked_tools_root/$blocked_tool"
done

dpkg-deb --raw-extract "$package_path" "$previous_package_root"
previous_version='0.0.0~hvir-smoke'
sed -i "s/^Version:.*/Version: $previous_version/" \
  "$previous_package_root/DEBIAN/control"
dpkg-deb --root-owner-group --build "$previous_package_root" "$previous_package" >/dev/null

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
  require_equal "$(readlink -f /usr/bin/hvir)" '/opt/hvir/hvir' 'command target'
  binary_description=$(file /opt/hvir/hvir)
  if [[ "$binary_description" != *"$binary_arch"* ]]; then
    echo \
      "Native package contract failed for executable architecture: $binary_description" \
      >&2
    exit 1
  fi

  desktop_entry=/usr/share/applications/hvir.desktop
  require_file "$desktop_entry" 'desktop entry'
  require_contains "$desktop_entry" 'Exec=hvir' 'desktop command'
  notices=/opt/hvir/resources/THIRD_PARTY_NOTICES.md
  require_file "$notices" 'third-party notices'
  require_contains "$notices" 'Copyright (c) 2025 Coder' 'Coder notice'
  require_contains \
    "$notices" \
    'Copyright (c) 2024 Mitchell Hashimoto, Ghostty contributors' \
    'Ghostty notice'

  apparmor_profile=/etc/apparmor.d/hvir
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

  sandbox_owner_mode=$(stat -c '%U:%G:%a' /opt/hvir/chrome-sandbox)
  case "$sandbox_owner_mode" in
  root:root:755 | root:root:4755) ;;
  *)
    echo "Unsafe Chromium sandbox helper ownership or mode: $sandbox_owner_mode" >&2
    exit 1
    ;;
  esac
}

run_installed_smoke() {
  stage=$1
  scenario=$2
  log="$invocation_root/$stage-$scenario.log"
  user_data_root="$invocation_root/user-data-$stage-$scenario"
  mkdir -p "$user_data_root"
  (
    unset ELECTRON_RUN_AS_NODE NODE_OPTIONS NODE_PATH
    cd "$project_root"
    HOME="$home_root" \
      PATH="$blocked_tools_root:/usr/sbin:/usr/bin:/sbin:/bin" \
      XDG_CONFIG_HOME="$config_root" \
      HVIR_SMOKE=1 \
      HVIR_SMOKE_REQUIRE_PROCESS_SANDBOX=1 \
      HVIR_SMOKE_SCENARIO="$scenario" \
      /usr/bin/hvir \
      --project-root="$project_root" \
      --user-data-dir="$user_data_root"
  ) >"$log" 2>&1
  sed -n '1,240p' "$log"
  grep -Fq 'HVIR_SMOKE_OK' "$log"
}

sudo /usr/bin/apt install --no-install-recommends -y "$previous_package" \
  2>&1 | tee "$install_log"
package_installed=1
assert_package_contract "$previous_version"
run_installed_smoke previous pty-native

sudo /usr/bin/apt install --no-install-recommends -y "$package_path" \
  2>&1 | tee "$update_log"
assert_package_contract "$package_version"
run_installed_smoke current pty-native
run_installed_smoke current platform-contracts
grep -Fq 'renderer sandbox active' \
  "$invocation_root/current-platform-contracts.log"
grep -Fq 'renderer IPC + echo worker round-trip OK' \
  "$invocation_root/current-platform-contracts.log"

sudo /usr/bin/apt remove -y hvir 2>&1 | tee "$remove_log"
package_installed=0
if [[ -e /usr/bin/hvir || -e /opt/hvir || -e /etc/apparmor.d/hvir ]]; then
  echo 'Native package removal left package-owned files behind.' >&2
  exit 1
fi
if sudo apparmor_status | grep -Eq '^[[:space:]]+hvir$'; then
  echo 'Native package removal left the hvir AppArmor profile loaded.' >&2
  exit 1
fi
test -f "$user_state_root/settings-smoke-marker"
test -f "$user_state_root/projects-smoke-marker"
test -d "$project_root/.git"

echo "Verified hvir ${package_version} ${deb_arch} native installation, update, sandbox, and removal."
