#!/usr/bin/env bash
set -euo pipefail

if [[ $# != 3 || "$(uname -s)" != Linux ]]; then
  echo 'Usage (Linux): bash scripts/native-ghostty-qualification/linux-attempt.sh GHOSTTY_REPO ZIG_0_17 NEW_OUTPUT_DIR' >&2
  exit 64
fi
qualification_root=$(cd "$(dirname "$0")/../.." && pwd)
qualification_ghostty=$(cd "$1" && pwd)
qualification_zig=$(realpath "$2")
qualification_output=$3
qualification_upstream=83fb95624b0439ee660c2679b43b38c8b63769cd
if [[ -e "$qualification_output" ]]; then
  echo 'Output directory must be new; all evidence is retained, never overwritten.' >&2
  exit 64
fi
if [[ "$("$qualification_zig" version)" != 0.17.0 ]]; then
  echo 'Expected Zig 0.17.0.' >&2
  exit 64
fi
for qualification_command in git node tar patch timeout cc awk; do
  command -v "$qualification_command" >/dev/null || { echo "Missing prerequisite: $qualification_command" >&2; exit 64; }
done
qualification_source=$(git -C "$qualification_root" rev-parse HEAD)
if [[ -n "$(git -C "$qualification_root" ls-files --others --exclude-standard -- scripts/native-ghostty-qualification)" ]] ||
  ! git -C "$qualification_root" diff --quiet HEAD -- scripts/native-ghostty-qualification; then
  echo 'Experiment source differs from the recorded commit; use the exact pushed candidate.' >&2
  exit 64
fi
git -C "$qualification_ghostty" cat-file -e "$qualification_upstream^{commit}"
mkdir -- "$qualification_output"
qualification_output=$(cd "$qualification_output" && pwd)
qualification_stage=archive
qualification_build_code=not-run
qualification_runtime_code=not-run
qualification_record() {
  node "$qualification_root/scripts/native-ghostty-qualification/linux-evidence.mjs" \
    "$qualification_output" "$qualification_source" "$qualification_stage" \
    "$qualification_build_code" "$qualification_runtime_code"
}
trap qualification_record EXIT
printf '%s\n' "$qualification_source" > "$qualification_output/source-commit.txt"
{
  "$qualification_zig" version
  node --version
  cc --version
  pkg-config --modversion fontconfig freetype2 egl 2>/dev/null || true
} > "$qualification_output/versions.log" 2>&1
if command -v eglinfo >/dev/null; then
  timeout 15s eglinfo -B > "$qualification_output/egl.log" 2>&1 || true
else
  echo 'eglinfo unavailable; no EGL environment result.' > "$qualification_output/egl.log"
fi
cat <<'BOUNDARY'
This is a Linux-native build/embed-boundary attempt, not a scrolling demo.
The pinned embedded runtime declares only macOS/iOS. No Linux facade, DMA-BUF
lease pool or Electron importer is supplied. Even a successful build/init does
not qualify GPU presentation. Compiler/runtime logs identify the first boundary.
BOUNDARY
mkdir "$qualification_output/ghostty"
git -C "$qualification_ghostty" archive "$qualification_upstream" |
  tar -x -C "$qualification_output/ghostty"
# One authoritative pinned patch: select only portable transport/feed hunks.
awk '
  /^--- a\// { qualification_include = ($0 == "--- a/src/apprt/embedded.zig" || $0 == "--- a/src/termio/Termio.zig" || $0 == "--- a/src/termio/Thread.zig" || $0 == "--- a/src/termio/message.zig") }
  qualification_include { print }
' "$qualification_root/scripts/native-ghostty-qualification/ghostty.patch.txt" > "$qualification_output/transport.patch"
patch --batch -d "$qualification_output/ghostty" -p1 < "$qualification_output/transport.patch" \
  > "$qualification_output/patch.log" 2>&1
qualification_stage=native-build
if (
  cd "$qualification_output/ghostty"
  timeout --signal=TERM --kill-after=5s 900s "$qualification_zig" build -j2 \
    -Dapp-runtime=none -Demit-lib-vt=false -Demit-docs=false -Demit-themes=false \
    -Doptimize=ReleaseFast --prefix "$qualification_output/native"
) > "$qualification_output/build.log" 2>&1; then
  qualification_build_code=0
else
  qualification_build_code=$?
  qualification_stage=native-build-blocked
  echo 'Native build stopped. Return result.json and build.log; no GPU claim is possible.' >&2
  exit 1
fi
# Pinned build.zig installs this exact name on non-Darwin, non-Windows targets.
qualification_library="$qualification_output/native/lib/ghostty-internal.so"
if [[ ! -f "$qualification_library" ]]; then
  qualification_stage=expected-native-library-missing
  echo 'Build succeeded but the pinned expected native/lib/ghostty-internal.so is absent.' >&2
  exit 1
fi
qualification_stage=probe-compile
if ! cc -std=gnu11 -Wall -Wextra \
  -I "$qualification_output/ghostty/include" \
  "$qualification_root/scripts/native-ghostty-qualification/linux-probe.c" \
  -ldl -o "$qualification_output/linux-probe" > "$qualification_output/cc.log" 2>&1; then
  qualification_stage=probe-compile-blocked
  exit 1
fi
qualification_stage=runtime-init
if timeout --signal=TERM --kill-after=5s 30s "$qualification_output/linux-probe" \
  "$qualification_library" > "$qualification_output/runtime.log" 2>&1; then
  qualification_runtime_code=0
else
  qualification_runtime_code=$?
fi
case "$qualification_runtime_code" in
  3) qualification_stage=known-embedding-platform-boundary ;;
  10) qualification_stage=native-library-load-blocked ;;
  11) qualification_stage=native-global-init-blocked ;;
  12) qualification_stage=native-config-allocation-blocked ;;
  13) qualification_stage=native-app-init-blocked ;;
  14) qualification_stage=native-abi-symbol-blocked ;;
  *) qualification_stage=runtime-result-needs-inspection ;;
esac
echo 'Attempt retained. Return result.json, build.log, runtime.log and egl.log.'
# A confirmed missing facade is useful evidence, never a passing GPU test.
exit 1
