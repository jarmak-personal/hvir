#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ "$(uname -s):$(uname -m)" != 'Darwin:arm64' ]]; then
  echo "macOS SSH identity evidence requires macOS arm64, found $(uname -s) $(uname -m)." >&2
  exit 1
fi
if [[ ! "${MACOS_TEAM_ID:-}" =~ ^[A-Z0-9]{10}$ ]]; then
  echo 'macOS SSH identity evidence requires a ten-character MACOS_TEAM_ID.' >&2
  exit 1
fi

acceptance_app=
release_app=
while [[ $# -gt 0 ]]; do
  case "$1" in
  --acceptance)
    [[ $# -ge 2 ]] || {
      echo '--acceptance requires an application bundle path.' >&2
      exit 1
    }
    acceptance_app=$2
    shift 2
    ;;
  --release)
    [[ $# -ge 2 ]] || {
      echo '--release requires an application bundle path.' >&2
      exit 1
    }
    release_app=$2
    shift 2
    ;;
  *)
    echo "Unknown macOS SSH identity argument: $1" >&2
    exit 1
    ;;
  esac
done
if [[ -z "$acceptance_app" ]]; then
  echo 'macOS SSH identity evidence requires --acceptance <application>.' >&2
  exit 1
fi

temporary_parent=$(cd "${TMPDIR:-/tmp}" && pwd -P)
evidence_root=$(mktemp -d "$temporary_parent/hvir-ssh-identity.XXXXXX")
cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  case "$evidence_root" in
  "$temporary_parent"/hvir-ssh-identity.*) /bin/rm -rf -- "$evidence_root" ;;
  *)
    echo "Refusing to clean unexpected identity-evidence root: $evidence_root" >&2
    status=1
    ;;
  esac
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

inspect_application() {
  local label=$1
  local application=$2
  local expected_identifier=$3
  local plist="$application/Contents/Info.plist"
  local signature_log="$evidence_root/$label-signature.log"
  local requirement_log="$evidence_root/$label-requirement.log"
  local identifier executable_name executable team_id authority requirement uuids usage

  if [[ ! -d "$application" || ! -f "$plist" ]]; then
    echo "$label application bundle is unavailable." >&2
    exit 1
  fi
  identifier=$(plutil -extract CFBundleIdentifier raw "$plist")
  executable_name=$(plutil -extract CFBundleExecutable raw "$plist")
  executable="$application/Contents/MacOS/$executable_name"
  if [[ "$identifier" != "$expected_identifier" || ! -x "$executable" ]]; then
    echo "$label application identity is not the expected hvir bundle." >&2
    exit 1
  fi
  if ! codesign --verify --deep --strict --verbose=2 "$application" \
    >"$signature_log" 2>&1; then
    echo "$label application failed strict code-signature verification." >&2
    exit 1
  fi
  codesign -dvvv "$application" >"$signature_log" 2>&1
  team_id=$(sed -n 's/^TeamIdentifier=//p' "$signature_log" | head -n 1)
  authority=$(sed -n 's/^Authority=//p' "$signature_log" | head -n 1)
  if [[ "$team_id" != "$MACOS_TEAM_ID" ||
    "$authority" != 'Developer ID Application:'* ]]; then
    echo "$label application does not carry the required Apple-issued Developer ID identity." >&2
    exit 1
  fi
  codesign -d -r- "$application" >"$requirement_log" 2>&1
  requirement=$(sed -n 's/^designated => //p' "$requirement_log" | head -n 1)
  uuids=$(dwarfdump --uuid "$executable" | awk '{print $2}' | paste -sd, -)
  if [[ -z "$requirement" || ! "$uuids" =~ ^[0-9A-Fa-f,-]+$ ]]; then
    echo "$label application identity evidence is incomplete." >&2
    exit 1
  fi
  usage=$(plutil -extract NSLocalNetworkUsageDescription raw "$plist" 2>/dev/null || true)
  if [[ "$label" == acceptance && -z "$usage" ]]; then
    echo 'acceptance application has no Local Network usage description.' >&2
    exit 1
  fi

  printf '%s\n' \
    "$label bundle ID: $identifier" \
    "$label signing class: Developer ID Application" \
    "$label Team ID: $team_id" \
    "$label designated requirement: $requirement" \
    "$label main-executable UUID: $uuids" \
    "$label Local Network usage description: ${usage:-unavailable}"
}

if [[ -n "$release_app" ]]; then
  inspect_application release "$release_app" dev.hvir.app
fi
inspect_application acceptance "$acceptance_app" dev.hvir.ssh-acceptance
