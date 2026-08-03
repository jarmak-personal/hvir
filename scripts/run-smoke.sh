#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
source_checkout=$PWD

# A smoke launched by a Git hook must not inherit the invoking repository as
# implicit authority. Every Git process below must discover the temp project.
while IFS= read -r variable; do
  if [[ -n "$variable" ]]; then unset "$variable"; fi
done < <(git -C "$source_checkout" rev-parse --local-env-vars)
# A built smoke must never attach to an unrelated renderer development server.
unset ELECTRON_RENDERER_URL

source_commit=$(git -C "$source_checkout" rev-parse HEAD)
source_dirty=0
if [[ -n "$(git -C "$source_checkout" status --porcelain --untracked-files=normal)" ]]; then
  source_dirty=1
fi
temporary_parent=$(cd "${TMPDIR:-/tmp}" && pwd -P)
invocation_root=$(mktemp -d "$temporary_parent/hvir-smoke.XXXXXX")
project_root="$invocation_root/repository"
user_data_root="$invocation_root/user-data"
ownership_marker="$invocation_root/.hvir-smoke-owner"
ownership_marker_value='hvir-smoke-owned-root-v1'
smoke_pid=''

if ! printf '%s\n' "$ownership_marker_value" > "$ownership_marker"; then
  rmdir -- "$invocation_root" 2>/dev/null || true
  exit 1
fi

if [[ -n "${HVIR_SMOKE_ISOLATION_RUN:-}" ]]; then
  if [[ ! "$HVIR_SMOKE_ISOLATION_RUN" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$ ]]; then
    echo 'HVIR_SMOKE_ISOLATION_RUN must be a UUID' >&2
    exit 1
  fi
  printf '[smoke:isolation:owned-root]\t%s\t%s\n' \
    "$HVIR_SMOKE_ISOLATION_RUN" "$invocation_root"
fi

cleanup() {
  if [[ -z "${invocation_root:-}" ]]; then return; fi
  case "$invocation_root" in
  "$temporary_parent"/hvir-smoke.*)
    if [[ ! -f "$ownership_marker" ]] || \
      [[ "$(<"$ownership_marker")" != "$ownership_marker_value" ]]; then
      echo "Refusing to clean unowned smoke root: $invocation_root" >&2
      return 1
    fi
    local cleanup_status=0
    rm -rf -- "$project_root" || cleanup_status=$?
    rm -rf -- "$user_data_root" || cleanup_status=$?
    rm -f -- "$ownership_marker" || cleanup_status=$?
    rmdir -- "$invocation_root" 2>/dev/null || {
      if [[ -e "$invocation_root" ]]; then cleanup_status=1; fi
    }
    if [[ "$cleanup_status" -eq 0 ]]; then invocation_root=''; fi
    return "$cleanup_status"
    ;;
  *)
    echo "Refusing to clean unexpected smoke root: $invocation_root" >&2
    return 1
    ;;
  esac
}

terminate_smoke() {
  local status=$1
  trap - HUP INT TERM
  if [[ -n "$smoke_pid" ]] && kill -0 "$smoke_pid" 2>/dev/null; then
    # Electron reliably runs its graceful main-process teardown on TERM across
    # supported hosts. Preserve the wrapper's caller-visible signal status.
    kill -s TERM "$smoke_pid" 2>/dev/null || true
    wait "$smoke_pid" 2>/dev/null || true
  fi
  smoke_pid=''
  exit "$status"
}

trap cleanup EXIT
trap 'terminate_smoke 129' HUP
trap 'terminate_smoke 130' INT
trap 'terminate_smoke 143' TERM

mkdir -p "$user_data_root"
"$source_checkout/scripts/create-smoke-repository.sh" \
  "$source_checkout" \
  "$project_root"

cd "$project_root"
if [[ "${HVIR_SMOKE_SCENARIO:-legacy-workflow}" == 'development-performance' ]]; then
  cd "$source_checkout"
  development_smoke_log="$user_data_root/development-performance.log"
  HVIR_SMOKE=1 \
    HVIR_SMOKE_SOURCE_COMMIT="$source_commit" \
    HVIR_SMOKE_SOURCE_DIRTY="$source_dirty" \
    HVIR_SMOKE_SCENARIO=development-performance \
    HVIR_PROJECT_ROOT="$project_root" \
    ELECTRON_ENTRY="$source_checkout" \
    ELECTRON_CLI_ARGS="[\"--user-data-dir=$user_data_root\"]" \
    "$source_checkout/node_modules/.bin/electron-vite" \
    "$source_checkout" \
    --mode smoke \
    --noSandbox \
    --clearScreen false | tee "$development_smoke_log"
  if ! grep -qx 'HVIR_SMOKE_OK' "$development_smoke_log"; then
    echo 'Development Performance Timeline smoke ended without its success sentinel' >&2
    exit 1
  fi
else
  HVIR_SMOKE=1 \
    HVIR_SMOKE_SOURCE_COMMIT="$source_commit" \
    HVIR_SMOKE_SOURCE_DIRTY="$source_dirty" \
    HVIR_SMOKE_SCENARIO="${HVIR_SMOKE_SCENARIO:-legacy-workflow}" \
    "$source_checkout/node_modules/.bin/electron" "$source_checkout" \
    --project-root="$project_root" \
    --no-sandbox \
    --user-data-dir="$user_data_root" &
  smoke_pid=$!
  wait "$smoke_pid"
  smoke_pid=''
fi
