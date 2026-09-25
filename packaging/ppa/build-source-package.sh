#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
REPOSITORY="nevaeh5379/HaejeokRisuAI"
SERIES="${2:-noble}"
BUILD_NUMBER="${1:-}"

cd "$REPO_ROOT"

if [[ -z "$BUILD_NUMBER" ]]; then
  TAG="$(gh release view --repo "$REPOSITORY" --json tagName --jq '.tagName')"
  BUILD_NUMBER="${TAG#b}"
else
  TAG="b${BUILD_NUMBER}"
fi

if [[ ! "$BUILD_NUMBER" =~ ^[0-9]+$ ]]; then
  echo "Invalid build number: $BUILD_NUMBER" >&2
  exit 2
fi

VERSION="0.0.${BUILD_NUMBER}"
PACKAGE_VERSION="${VERSION}-1~ppa1~${SERIES}1"
OUT_DIR="$REPO_ROOT/dist-ppa/${TAG}-${SERIES}"
WORK_DIR="$(mktemp -d)"
SOURCE_NAME="haejeok-risuai-${VERSION}"
SOURCE_DIR="$WORK_DIR/$SOURCE_NAME"

trap 'rm -rf "$WORK_DIR"' EXIT
mkdir -p "$SOURCE_DIR"

if ! git cat-file -e "${TAG}^{commit}" 2>/dev/null; then
  git fetch origin "refs/tags/${TAG}:refs/tags/${TAG}"
fi

git archive "$TAG" | tar -x -C "$SOURCE_DIR"
rm -rf "$SOURCE_DIR/debian"
mkdir -p "$SOURCE_DIR/payload"

download_payload() {
  local arch="$1"
  local asset="RisuAI_${VERSION}_${arch}.deb"
  local target="$SOURCE_DIR/payload/$asset"
  local digest expected actual

  local release_args=(
    "$TAG"
    --repo "$REPOSITORY"
    --pattern "$asset"
    --dir "$SOURCE_DIR/payload"
  )
  gh release download "${release_args[@]}"

  digest="$(gh api "repos/${REPOSITORY}/releases/tags/${TAG}" --jq ".assets[] | select(.name == \"${asset}\") | .digest")"
  expected="${digest#sha256:}"
  actual="$(sha256sum "$target" | awk '{print $1}')"

  if [[ -z "$expected" || "$expected" != "$actual" ]]; then
    echo "Checksum mismatch for $asset" >&2
    exit 1
  fi
}

download_payload amd64
download_payload arm64

ORIG_TAR="$WORK_DIR/haejeok-risuai_${VERSION}.orig.tar.xz"
TAG_EPOCH="$(git show -s --format=%ct "$TAG")"

tar_args=(
  --sort=name
  --mtime="@${TAG_EPOCH}"
  --owner=0
  --group=0
  --numeric-owner
  -cJf "$ORIG_TAR"
  -C "$WORK_DIR"
  "$SOURCE_NAME"
)
tar "${tar_args[@]}"

cp -a "$REPO_ROOT/debian" "$SOURCE_DIR/debian"

cat > "$SOURCE_DIR/debian/changelog" <<EOF
haejeok-risuai (${PACKAGE_VERSION}) ${SERIES}; urgency=medium

  * Package Haejeok RisuAI ${VERSION} for Ubuntu ${SERIES}.
  * Repackage the official GitHub release payload.

 -- nevaeh5379 <230626330+nevaeh5379@users.noreply.github.com>  $(date -R)
EOF

build_source_package() {
  if command -v docker >/dev/null 2>&1; then
    docker run --rm -e DEBIAN_FRONTEND=noninteractive -e HOST_UID="$(id -u)" -e HOST_GID="$(id -g)" -v "$WORK_DIR:/work" -w "/work/$SOURCE_NAME" ubuntu:24.04 bash -lc 'apt-get update && apt-get install -y --no-install-recommends dpkg-dev debhelper xz-utils && dpkg-buildpackage -S -sa -us -uc -d; status=$?; chown -R "$HOST_UID:$HOST_GID" /work; exit $status'
    return
  fi

  if command -v podman >/dev/null 2>&1; then
    podman run --rm -e DEBIAN_FRONTEND=noninteractive -v "$WORK_DIR:/work" -w "/work/$SOURCE_NAME" ubuntu:24.04 bash -lc 'apt-get update && apt-get install -y --no-install-recommends dpkg-dev debhelper xz-utils && dpkg-buildpackage -S -sa -us -uc -d'
    return
  fi

  if command -v dpkg-buildpackage >/dev/null 2>&1; then
    (cd "$SOURCE_DIR" && dpkg-buildpackage -S -sa -us -uc -d)
    return
  fi

  echo "docker, podman, or dpkg-buildpackage is required" >&2
  exit 1
}

build_source_package
mkdir -p "$OUT_DIR"
find "$WORK_DIR" -maxdepth 1 -type f -name 'haejeok-risuai_*'   -exec cp -f '{}' "$OUT_DIR/" ';'

printf 'Source package prepared in %s\n' "$OUT_DIR"
printf 'Version: %s\n' "$PACKAGE_VERSION"
