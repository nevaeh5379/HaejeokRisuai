#!/usr/bin/env bash
set -euo pipefail

# Build on the same Ubuntu baseline as the application. Pulling binaries from
# a newer distribution would also raise the AppImage's glibc requirement.
TOOLING_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
read -r WEBKIT_VERSION WEBKIT_SHA256 < <(
  python3 - "$TOOLING_DIR/webkitgtk-version.json" <<'PY'
import json, re, sys
pin = json.load(open(sys.argv[1]))
assert re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", pin["version"])
assert re.fullmatch(r"[0-9a-f]{64}", pin["sha256"])
print(pin["version"], pin["sha256"])
PY
)

WORK_DIR=${WEBKIT_BUILD_DIR:?Set WEBKIT_BUILD_DIR to a build directory}
STAGE_DIR=${WEBKIT_STAGE_DIR:?Set WEBKIT_STAGE_DIR to an installation staging directory}
JOBS=${WEBKIT_BUILD_JOBS:-2}
if [[ ! "$JOBS" =~ ^[1-9][0-9]*$ ]]; then
  echo "Invalid WEBKIT_BUILD_JOBS: $JOBS" >&2
  exit 1
fi
mkdir -p "$WORK_DIR" "$STAGE_DIR"
WORK_DIR=$(realpath "$WORK_DIR")
STAGE_DIR=$(realpath "$STAGE_DIR")
ARCHIVE="$WORK_DIR/webkitgtk-$WEBKIT_VERSION.tar.xz"
SOURCE_DIR="$WORK_DIR/webkitgtk-$WEBKIT_VERSION"
BUILD_DIR="$WORK_DIR/build"

if [ ! -f "$ARCHIVE" ]; then
  curl -fL --retry 3 "https://webkitgtk.org/releases/webkitgtk-$WEBKIT_VERSION.tar.xz" \
    -o "$ARCHIVE"
fi
printf '%s  %s\n' "$WEBKIT_SHA256" "$ARCHIVE" | sha256sum --check --strict
if [ ! -d "$SOURCE_DIR" ]; then
  tar -xf "$ARCHIVE" -C "$WORK_DIR"
fi

MULTIARCH=$(gcc-14 -dumpmachine)
export WEBKIT_NINJA_LINK_MAX=1
cmake -S "$SOURCE_DIR" -B "$BUILD_DIR" -G Ninja \
  -DPORT=GTK \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_C_COMPILER=gcc-14 \
  -DCMAKE_CXX_COMPILER=g++-14 \
  -DCMAKE_INSTALL_PREFIX=/usr \
  -DCMAKE_INSTALL_LIBDIR="lib/$MULTIARCH" \
  -DCMAKE_INSTALL_LIBEXECDIR="lib/$MULTIARCH" \
  -DUSE_GTK4=OFF \
  -DENABLE_GPU_PROCESS=ON \
  -DENABLE_DOCUMENTATION=OFF \
  -DENABLE_INTROSPECTION=OFF \
  -DENABLE_MINIBROWSER=OFF \
  -DENABLE_WEBDRIVER=OFF \
  -DUSE_SYSTEM_SYSPROF_CAPTURE=OFF \
  -DUSE_LIBBACKTRACE=OFF \
  -DUSE_JPEGXL=OFF
cmake --build "$BUILD_DIR" --parallel "$JOBS"
DESTDIR="$STAGE_DIR" cmake --install "$BUILD_DIR"

# Tauri flattens shared libraries into AppDir/usr/lib. Its current bundler
# does not relocate WebKitGPUProcess, so give that helper the matching RPATH.
GPU_PROCESS="$STAGE_DIR/usr/lib/$MULTIARCH/webkit2gtk-4.1/WebKitGPUProcess"
# $ORIGIN is expanded by the ELF loader, not by this shell.
# shellcheck disable=SC2016
patchelf --set-rpath '$ORIGIN/../..' "$GPU_PROCESS"
