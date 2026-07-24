#!/usr/bin/env bash
set -Eeuo pipefail

readonly HVIR_VERSION=@@HVIR_VERSION@@
readonly HVIR_RELEASE_BASE_URL=@@HVIR_RELEASE_BASE_URL@@
readonly HVIR_LINUX_X64_ARTIFACT=@@HVIR_LINUX_X64_ARTIFACT@@
readonly HVIR_LINUX_X64_SHA256=@@HVIR_LINUX_X64_SHA256@@
readonly HVIR_LINUX_ARM64_ARTIFACT=@@HVIR_LINUX_ARM64_ARTIFACT@@
readonly HVIR_LINUX_ARM64_SHA256=@@HVIR_LINUX_ARM64_SHA256@@
readonly HVIR_MACOS_ARM64_ARTIFACT=@@HVIR_MACOS_ARM64_ARTIFACT@@
readonly HVIR_MACOS_ARM64_SHA256=@@HVIR_MACOS_ARM64_SHA256@@
readonly HVIR_MACOS_TEAM_ID=@@HVIR_MACOS_TEAM_ID@@
readonly HVIR_ACCEPTANCE_ASSET_DIRECTORY=@@HVIR_ACCEPTANCE_ASSET_DIRECTORY@@
readonly HVIR_ACCEPTANCE_UNSIGNED_MACOS=@@HVIR_ACCEPTANCE_UNSIGNED_MACOS@@

stage='validating arguments'
temporary_directory=''
platform=''
architecture=''
artifact_name=''
artifact_sha256=''
native_command=''
legacy_launcher=''
legacy_npm=''
legacy_cache=''
operation='install'
purge=0

cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  if [[ -n "$temporary_directory" ]]; then
    case "$temporary_directory" in
    */hvir-installer.*) /bin/rm -rf -- "$temporary_directory" ;;
    *)
      echo "hvir installer refused to clean unexpected path: $temporary_directory" >&2
      status=1
      ;;
    esac
  fi
  if [[ "$status" -ne 0 ]]; then
    echo "hvir $HVIR_VERSION failed while $stage (status $status)." >&2
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

usage() {
  cat <<EOF
hvir $HVIR_VERSION installer

Usage:
  install.sh
  install.sh --uninstall
  install.sh --uninstall --purge

The default operation installs or updates hvir. Uninstall preserves user state;
--purge additionally removes the current user's documented hvir settings and cache.
EOF
}

parse_arguments() {
  case "$#" in
  0) ;;
  1)
    case "$1" in
    --uninstall) operation='uninstall' ;;
    --help | -h)
      usage
      exit 0
      ;;
    *)
      usage >&2
      exit 64
      ;;
    esac
    ;;
  2)
    if [[ "$1" != '--uninstall' || "$2" != '--purge' ]]; then
      usage >&2
      exit 64
    fi
    operation='uninstall'
    purge=1
    ;;
  *)
    usage >&2
    exit 64
    ;;
  esac
}

read_linux_release() {
  local key value
  linux_id=''
  linux_version=''
  [[ -r /etc/os-release ]] || {
    echo 'hvir supports Linux only on Ubuntu 24.04 LTS.' >&2
    exit 69
  }
  while IFS='=' read -r key value; do
    value=${value#\"}
    value=${value%\"}
    case "$key" in
    ID) linux_id=$value ;;
    VERSION_ID) linux_version=$value ;;
    esac
  done </etc/os-release
  if [[ "$linux_id" != 'ubuntu' || "$linux_version" != '24.04' ]]; then
    echo \
      "hvir supports Linux only on Ubuntu 24.04 LTS; found ${linux_id:-unknown} ${linux_version:-unknown}." \
      >&2
    exit 69
  fi
}

detect_target() {
  local kernel machine
  kernel=$(/usr/bin/uname -s)
  machine=$(/usr/bin/uname -m)
  case "$kernel:$machine" in
  Linux:x86_64)
    read_linux_release
    platform='linux'
    architecture='x64'
    artifact_name=$HVIR_LINUX_X64_ARTIFACT
    artifact_sha256=$HVIR_LINUX_X64_SHA256
    native_command='/usr/bin/hvir'
    ;;
  Linux:aarch64 | Linux:arm64)
    read_linux_release
    platform='linux'
    architecture='arm64'
    artifact_name=$HVIR_LINUX_ARM64_ARTIFACT
    artifact_sha256=$HVIR_LINUX_ARM64_SHA256
    native_command='/usr/bin/hvir'
    ;;
  Darwin:arm64)
    platform='macos'
    architecture='arm64'
    artifact_name=$HVIR_MACOS_ARM64_ARTIFACT
    artifact_sha256=$HVIR_MACOS_ARM64_SHA256
    native_command='/usr/local/bin/hvir'
    ;;
  *)
    echo \
      "hvir does not support $kernel $machine. Supported targets are Ubuntu 24.04 x64/arm64 and Apple-silicon macOS." \
      >&2
    exit 69
    ;;
  esac
}

require_absolute_tool() {
  [[ -x "$1" ]] || {
    echo "hvir requires $1." >&2
    exit 69
  }
}

require_install_tools() {
  require_absolute_tool /usr/bin/sudo
  if [[ -z "$HVIR_ACCEPTANCE_ASSET_DIRECTORY" ]]; then
    require_absolute_tool /usr/bin/curl
  fi
  if [[ "$platform" == 'linux' ]]; then
    require_absolute_tool /usr/bin/apt
    require_absolute_tool /usr/bin/dpkg-query
    require_absolute_tool /usr/bin/sha256sum
  else
    require_absolute_tool /usr/bin/shasum
    require_absolute_tool /usr/sbin/pkgutil
    require_absolute_tool /usr/sbin/installer
    require_absolute_tool /usr/sbin/spctl
    require_absolute_tool /usr/bin/xcrun
  fi
}

create_private_temporary_directory() {
  local temporary_parent
  temporary_parent=$(cd "${TMPDIR:-/tmp}" && pwd -P)
  temporary_directory=$(umask 077 && /usr/bin/mktemp -d \
    "$temporary_parent/hvir-installer.XXXXXX")
}

download_artifact() {
  local destination=$1
  stage="downloading $artifact_name"
  if [[ -n "$HVIR_ACCEPTANCE_ASSET_DIRECTORY" ]]; then
    /bin/cp -- "$HVIR_ACCEPTANCE_ASSET_DIRECTORY/$artifact_name" "$destination"
  else
    /usr/bin/curl \
      --fail \
      --silent \
      --show-error \
      --location \
      --proto '=https' \
      --tlsv1.2 \
      --output "$destination" \
      "$HVIR_RELEASE_BASE_URL/$artifact_name"
  fi
}

verify_digest() {
  local artifact=$1 digest_output actual_digest
  stage="verifying the SHA-256 digest for $artifact_name"
  if [[ "$platform" == 'linux' ]]; then
    digest_output=$(/usr/bin/sha256sum "$artifact")
  else
    digest_output=$(/usr/bin/shasum -a 256 "$artifact")
  fi
  actual_digest=${digest_output%%[[:space:]]*}
  if [[ "$actual_digest" != "$artifact_sha256" ]]; then
    echo "Digest mismatch for $artifact_name." >&2
    echo "Expected: $artifact_sha256" >&2
    echo "Actual:   $actual_digest" >&2
    exit 1
  fi
}

verify_macos_package() {
  local artifact=$1 signature_log
  if [[ "$HVIR_ACCEPTANCE_UNSIGNED_MACOS" == '1' ]]; then
    return
  fi
  signature_log="$temporary_directory/macos-package-signature.log"
  stage='validating the macOS installer signature'
  /usr/sbin/pkgutil --check-signature "$artifact" >"$signature_log" 2>&1
  if ! /usr/bin/grep -Eq \
    "Developer ID Installer: .+ \\($HVIR_MACOS_TEAM_ID\\)" \
    "$signature_log"; then
    echo "The package is not signed by the expected Apple team $HVIR_MACOS_TEAM_ID." >&2
    exit 1
  fi
  /usr/bin/grep -Fq 'Signed with a trusted timestamp' "$signature_log"
  stage='validating the stapled macOS notarization ticket'
  /usr/bin/xcrun stapler validate "$artifact"
  stage='assessing the macOS package with Gatekeeper'
  /usr/sbin/spctl --assess --type install --verbose=2 "$artifact"
}

native_install_present() {
  if [[ "$platform" == 'linux' ]]; then
    /usr/bin/dpkg-query -W -f='${Status}' hvir 2>/dev/null |
      /usr/bin/grep -Fq 'install ok installed'
  else
    /usr/sbin/pkgutil --pkg-info dev.hvir.app >/dev/null 2>&1 &&
      [[ -f "$native_command" ]] &&
      /usr/bin/grep -Fq 'hvir-native-package-command-v1' "$native_command"
  fi
}

resolve_link_target() {
  local link=$1 target parent
  target=$(/usr/bin/readlink "$link")
  case "$target" in
  /*) ;;
  *) target=$(/usr/bin/dirname "$link")/$target ;;
  esac
  parent=$(cd "$(/usr/bin/dirname "$target")" && pwd -P)
  printf '%s/%s\n' "$parent" "$(/usr/bin/basename "$target")"
}

list_contains_exact_line() {
  local expected=$1 line
  while IFS= read -r line; do
    [[ "$line" == "$expected" ]] && return 0
  done
  return 1
}

legacy_cache_root() {
  if [[ "$platform" == 'macos' ]]; then
    printf '%s/Library/Caches/hvir/native\n' "$HOME"
  elif [[ -n "${XDG_CACHE_HOME:-}" && "$XDG_CACHE_HOME" == /* ]]; then
    printf '%s/hvir/native\n' "${XDG_CACHE_HOME%/}"
  else
    printf '%s/.cache/hvir/native\n' "$HOME"
  fi
}

discover_legacy_launcher() {
  local found npm_prefix npm_root expected_launcher expected_target actual_target listing
  found=$(command -v hvir 2>/dev/null || true)
  [[ -n "$found" ]] || return 0
  if native_install_present && [[ "$found" == "$native_command" ]]; then
    return
  fi

  legacy_npm=$(command -v npm 2>/dev/null || true)
  if [[ "$legacy_npm" != /* || ! -x "$legacy_npm" ]]; then
    echo "An existing hvir command is not package-owned and cannot be verified: $found" >&2
    exit 1
  fi
  npm_prefix=$("$legacy_npm" prefix -g)
  npm_root=$("$legacy_npm" root -g)
  [[ "$npm_prefix" == /* && "$npm_root" == /* ]] || {
    echo 'The legacy npm installation reported a non-absolute global prefix.' >&2
    exit 1
  }
  expected_launcher=${npm_prefix%/}/bin/hvir
  expected_target=${npm_root%/}/hvir-workbench/bin/hvir.mjs
  if [[ "$found" != "$expected_launcher" || ! -L "$found" ||
    ! -f "$expected_target" ]]; then
    echo "An existing hvir command has ambiguous ownership and was not changed: $found" >&2
    exit 1
  fi
  actual_target=$(resolve_link_target "$found")
  expected_target=$(cd "$(/usr/bin/dirname "$expected_target")" && pwd -P)/$(
    /usr/bin/basename "$expected_target"
  )
  if [[ "$actual_target" != "$expected_target" ]]; then
    echo "The existing hvir launcher does not target hvir-workbench: $found" >&2
    exit 1
  fi
  listing=$("$legacy_npm" ls -g --depth=0 --parseable hvir-workbench)
  if ! list_contains_exact_line "${npm_root%/}/hvir-workbench" <<<"$listing"; then
    echo 'npm did not confirm ownership of the existing hvir-workbench launcher.' >&2
    exit 1
  fi
  if [[ "$found" == "$native_command" ]]; then
    echo \
      "The verified legacy launcher occupies $native_command; move hvir-workbench to a user-owned npm prefix before native migration." \
      >&2
    exit 1
  fi
  legacy_launcher=$found
  legacy_cache=$(legacy_cache_root)
  echo "Verified legacy hvir-workbench launcher: $legacy_launcher"
}

verify_native_command() {
  stage='verifying the installed native command'
  [[ -x "$native_command" ]] || {
    echo "The native package did not install $native_command." >&2
    exit 1
  }
  /usr/bin/grep -Fq 'hvir-native-package-command-v1' "$native_command" || {
    echo "The installed command is not owned by the hvir native package: $native_command" >&2
    exit 1
  }
  native_install_present || {
    echo 'The native package manager does not report hvir as installed.' >&2
    exit 1
  }
}

safe_remove_legacy_cache() {
  [[ -n "$legacy_cache" ]] || return 0
  case "$legacy_cache" in
  /*/hvir/native) ;;
  *)
    echo "Refusing to remove unexpected legacy cache path: $legacy_cache" >&2
    exit 1
    ;;
  esac
  /bin/rm -rf -- "$legacy_cache"
}

remove_legacy_launcher() {
  [[ -n "$legacy_launcher" ]] || return 0
  stage='removing the verified legacy hvir-workbench launcher'
  "$legacy_npm" uninstall -g hvir-workbench
  if [[ -e "$legacy_launcher" || -L "$legacy_launcher" ]]; then
    echo "npm retained the legacy launcher: $legacy_launcher" >&2
    exit 1
  fi
  stage='removing the derived ADR-018 native cache'
  safe_remove_legacy_cache
}

install_or_update() {
  local artifact
  discover_legacy_launcher
  create_private_temporary_directory
  artifact="$temporary_directory/$artifact_name"
  download_artifact "$artifact"
  verify_digest "$artifact"
  if [[ "$platform" == 'macos' ]]; then
    verify_macos_package "$artifact"
    stage="installing hvir $HVIR_VERSION with the macOS package manager"
    /usr/bin/sudo /usr/sbin/installer -pkg "$artifact" -target /
  else
    stage="installing hvir $HVIR_VERSION with apt"
    /usr/bin/sudo /usr/bin/apt install --no-install-recommends -y "$artifact"
  fi
  verify_native_command
  remove_legacy_launcher
  echo \
    "Installed hvir $HVIR_VERSION for $platform $architecture from $artifact_name."
}

validate_macos_inventory() {
  local inventory='/Library/Application Support/hvir/package-inventory-v1.txt'
  [[ -f "$inventory" ]] || {
    echo "The hvir package inventory is missing: $inventory" >&2
    exit 1
  }
  /usr/bin/grep -Fxq 'hvir-native-package-inventory-v1' "$inventory"
  /usr/bin/grep -Fxq 'package-id=dev.hvir.app' "$inventory"
  /usr/bin/grep -Fxq 'application=/Applications/hvir.app' "$inventory"
  /usr/bin/grep -Fxq 'command=/usr/local/bin/hvir' "$inventory"
  /usr/bin/grep -Fxq \
    'inventory=/Library/Application Support/hvir/package-inventory-v1.txt' \
    "$inventory"
  /usr/bin/grep -Fxq 'receipt=dev.hvir.app' "$inventory"
  [[ -f /usr/local/bin/hvir ]] &&
    /usr/bin/grep -Fq 'hvir-native-package-command-v1' /usr/local/bin/hvir
}

remove_native_package() {
  if [[ "$platform" == 'linux' ]]; then
    if native_install_present; then
      stage='removing the hvir native package with apt'
      /usr/bin/sudo /usr/bin/apt remove -y hvir
    elif [[ "$purge" -eq 0 ]]; then
      echo 'The hvir native package is not installed.' >&2
      exit 1
    fi
  else
    if /usr/sbin/pkgutil --pkg-info dev.hvir.app >/dev/null 2>&1; then
      stage='validating package-owned macOS removal state'
      validate_macos_inventory
      stage='removing package-owned macOS application state'
      /usr/bin/sudo /bin/rm -rf -- /Applications/hvir.app
      /usr/bin/sudo /bin/rm -f -- \
        /usr/local/bin/hvir \
        '/Library/Application Support/hvir/package-inventory-v1.txt'
      /usr/bin/sudo /bin/rmdir '/Library/Application Support/hvir' 2>/dev/null || true
      /usr/bin/sudo /usr/sbin/pkgutil --forget dev.hvir.app >/dev/null
    elif [[ "$purge" -eq 0 ]]; then
      echo 'The hvir native package is not installed.' >&2
      exit 1
    fi
  fi
}

purge_roots() {
  local wrapped
  if [[ "$HOME" != /* || "$HOME" == '/' ]]; then
    echo "Refusing to purge with unsafe HOME: ${HOME:-unset}" >&2
    exit 1
  fi
  wrapped=/${HOME#/}/
  case "$wrapped" in
  */../* | */./*)
    echo "Refusing to purge with non-canonical HOME: $HOME" >&2
    exit 1
    ;;
  esac
  if [[ "$platform" == 'macos' ]]; then
    printf '%s\n' \
      "$HOME/Library/Application Support/hvir" \
      "$HOME/Library/Caches/hvir"
  else
    if [[ -n "${XDG_CONFIG_HOME:-}" && "$XDG_CONFIG_HOME" == /* ]]; then
      wrapped=/${XDG_CONFIG_HOME#/}/
      case "$wrapped" in
      */../* | */./*)
        echo "Refusing to purge with unsafe XDG_CONFIG_HOME: $XDG_CONFIG_HOME" >&2
        exit 1
        ;;
      esac
      printf '%s/hvir\n' "${XDG_CONFIG_HOME%/}"
    else
      printf '%s/.config/hvir\n' "$HOME"
    fi
    if [[ -n "${XDG_CACHE_HOME:-}" && "$XDG_CACHE_HOME" == /* ]]; then
      wrapped=/${XDG_CACHE_HOME#/}/
      case "$wrapped" in
      */../* | */./*)
        echo "Refusing to purge with unsafe XDG_CACHE_HOME: $XDG_CACHE_HOME" >&2
        exit 1
        ;;
      esac
      printf '%s/hvir\n' "${XDG_CACHE_HOME%/}"
    else
      printf '%s/.cache/hvir\n' "$HOME"
    fi
  fi
}

purge_user_state() {
  local path
  stage='purging the current user hvir settings and cache'
  while IFS= read -r path; do
    case "$path" in
    /*/hvir) ;;
    *)
      echo "Refusing to purge unexpected path: $path" >&2
      exit 1
      ;;
    esac
    echo "Purging current-user hvir state: $path"
    /bin/rm -rf -- "$path"
  done < <(purge_roots)
}

uninstall_hvir() {
  remove_native_package
  if [[ "$purge" -eq 1 ]]; then
    purge_user_state
  fi
  echo "Uninstalled hvir $HVIR_VERSION; project directories were preserved."
}

parse_arguments "$@"
stage='detecting the supported platform'
detect_target
require_install_tools
echo \
  "hvir $HVIR_VERSION selected $platform $architecture ($artifact_name); operation: $operation."

if [[ "$operation" == 'install' ]]; then
  install_or_update
else
  uninstall_hvir
fi

stage='completed successfully'
