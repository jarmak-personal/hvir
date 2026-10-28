#!/usr/bin/env bash
set -euo pipefail

if [[ $# != 3 || "$(uname -s)" != Darwin || "$(uname -m)" != arm64 ]]; then
  echo 'Usage (Apple Silicon macOS): bash scripts/native-ghostty-qualification/build.sh GHOSTTY_REPO ZIG_0_17 NODE_HEADERS' >&2
  exit 1
fi
qualification_repo=$(cd "$1" && pwd)
qualification_zig=$2
qualification_headers=$3
qualification_root=$(cd "$(dirname "$0")/../.." && pwd)
if [[ "$("$qualification_zig" version)" != 0.17.0 || ! -f "$qualification_headers/node_api.h" ]]; then
  echo 'Expected Zig 0.17.0 and a directory containing node_api.h.' >&2
  exit 1
fi
qualification_work=$(mktemp -d "${TMPDIR:-/tmp}/hvir-native-qualification.XXXXXX")
echo "Experiment directory: $qualification_work"
mkdir "$qualification_work/ghostty"
git -C "$qualification_repo" archive 83fb95624b0439ee660c2679b43b38c8b63769cd |
  tar -x -C "$qualification_work/ghostty"
patch -d "$qualification_work/ghostty" -p1 < "$qualification_root/scripts/native-ghostty-qualification/ghostty.patch.txt"
(
  cd "$qualification_work/ghostty"
  "$qualification_zig" build -Dapp-runtime=none -Demit-xcframework=false \
    -Demit-macos-app=false -Demit-docs=false -Demit-themes=false \
    -Doptimize=ReleaseFast --prefix "$qualification_work/native"
)
clang -bundle -undefined dynamic_lookup -fPIC -Wall -Wextra \
  -I "$qualification_headers" -I "$qualification_work/ghostty/include" \
  "$qualification_root/scripts/native-ghostty-qualification/bridge.c" \
  -L "$qualification_work/native/lib" -lghostty \
  -Wl,-rpath,"$qualification_work/native/lib" \
  -framework Cocoa -framework Metal -framework IOSurface \
  -o "$qualification_work/bridge.node"
echo "Built: $qualification_work/bridge.node"
echo 'Run only through the explicitly documented experiment command; nothing is installed.'
