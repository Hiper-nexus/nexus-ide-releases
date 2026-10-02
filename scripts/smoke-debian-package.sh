#!/usr/bin/env bash
set -euo pipefail

# Docker Official Images Debian 12.15 / bookworm-20260918-slim, linux/amd64.
# Immutable manifest checked against docker-library/repo-info and the registry.
DEBIAN_IMAGE='debian@sha256:f3034a6ec3c1205360777c4aae76234998866ad18806ae62b63a3f84ccad782b'

smoke_inside_container() {
  test "${NEXUS_DEBIAN_CONTAINER:-}" = 1
  test "$PWD" = /workspace
  test "$(id -u)" = 0
  # The pinned official image is the OS under test, not the Ubuntu runner.
  . /etc/os-release
  test "$ID" = debian
  test "$VERSION_ID" = 12
  test "$(dpkg --print-architecture)" = amd64
  test "$(/opt/nexus-node/bin/node --version)" = "v$NEXUS_DEBIAN_NODE_VERSION"
  local codex=/opt/nexus-smoke-codex/vendor/x86_64-unknown-linux-musl/bin/codex
  test "$NEXUS_SMOKE_CODEX_VERSION" = 0.145.0
  test "$NEXUS_SMOKE_CODEX_SHA256" = a2a05dafaa1acb002a45eaec0a462de5b13694fcfcd7bc43305f14781ce7be14
  test -f "$codex" && test -x "$codex" && test ! -L "$codex"
  test "$(sha256sum "$codex" | cut -d' ' -f1)" = "$NEXUS_SMOKE_CODEX_SHA256"
  printf '[debian-smoke] os=%s version=%s arch=amd64 node=%s\n' "$ID" "$VERSION_ID" "$NEXUS_DEBIAN_NODE_VERSION"

  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install --no-install-recommends -y \
    ca-certificates dbus-x11 fontconfig procps python3 util-linux unzip xvfb xauth \
    libgtk-3-0 libnss3 libasound2 libgbm1 libx11-xcb1 libdrm2 libxshmfence1 libxtst6

  local deb="/workspace/out/make/deb/x64/nexus-ide_${NEXUS_DEBIAN_VERSION}_amd64.deb"
  local archive="/workspace/out/make/zip/linux/x64/NexusIDE-linux-x64-${NEXUS_DEBIAN_VERSION}.zip"
  test "$(dpkg-deb -f "$deb" Package)" = nexus-ide
  test "$(dpkg-deb -f "$deb" Version)" = "$NEXUS_DEBIAN_VERSION"
  test "$(dpkg-deb -f "$deb" Architecture)" = amd64
  dpkg-deb -f "$deb" Depends | grep -Eq '(^|,)[[:space:]]*bubblewrap([[:space:](,]|$)'
  sha256sum "$deb" "$archive"
  apt-get install --no-install-recommends -y "$deb"
  test "$(dpkg-query -W -f='${Version}' nexus-ide)" = "$NEXUS_DEBIAN_VERSION"
  # Desktop identity as Debian's own dpkg installed it: brand icon and the
  # nexus:// handler the browser login returns through.
  /opt/nexus-node/bin/node scripts/verify-linux-desktop-identity.mjs
  bwrap --version

  local -a binaries=()
  mapfile -t binaries < <(
    dpkg-query -L nexus-ide | while IFS= read -r entry; do
      if [[ "$entry" == */nexus-ide && -f "$entry" && -x "$entry" && ! -L "$entry" ]]; then
        printf '%s\n' "$entry"
      fi
    done
  )
  test "${#binaries[@]}" = 1
  local libraries
  libraries="$(ldd "${binaries[0]}")"
  printf '%s\n' "$libraries"
  if grep -q 'not found' <<< "$libraries"; then
    printf 'installed Debian binary has unresolved shared libraries\n' >&2
    return 1
  fi

  # Apt runs as root; the real Electron/PTY/persistence smoke runs as a user.
  useradd --uid 10001 --create-home --shell /bin/bash nexus-smoke
  install -d -o nexus-smoke -g nexus-smoke /tmp/nexus-debian-smoke
  # Check the same real CLI under the unprivileged Debian identity. No login
  # or inference runs; mission.prepare retains its provider installation gate.
  test "$(runuser -u nexus-smoke -- "$codex" --version)" = "codex-cli $NEXUS_SMOKE_CODEX_VERSION"
  printf '[debian-smoke] native codex-cli %s hash and unprivileged version verified\n' "$NEXUS_SMOKE_CODEX_VERSION"
  printf '[debian-smoke] installed-deb begin uid=10001\n'
  runuser -u nexus-smoke -- dbus-run-session -- \
    xvfb-run -a -s '-screen 0 1280x1024x24' \
    /opt/nexus-node/bin/node scripts/smoke-packaged-app.mjs --app "${binaries[0]}" --verify-restart --expected-version "$NEXUS_DEBIAN_VERSION"

  local zip_binary
  zip_binary="$(runuser -u nexus-smoke -- python3 scripts/extract-linux-zip.py \
    --archive "$archive" --out /tmp/nexus-debian-smoke/zip)"
  test -x "$zip_binary"
  printf '[debian-smoke] extracted-zip begin uid=10001\n'
  runuser -u nexus-smoke -- dbus-run-session -- \
    xvfb-run -a -s '-screen 0 1280x1024x24' \
    /opt/nexus-node/bin/node scripts/smoke-packaged-app.mjs --app "$zip_binary" --verify-restart --expected-version "$NEXUS_DEBIAN_VERSION"
  printf '[debian-smoke] installed-deb and extracted-zip passed\n'
}

smoke_from_host() {
  local workspace node_binary node_root version node_version codex_root codex_binary
  workspace="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
  cd "$workspace"
  node_binary="$(node -p 'process.execPath')"
  node_root="$(dirname "$(dirname "$node_binary")")"
  version="$(node -p 'require("./package.json").version')"
  node_version="$(node -p 'require("./package.json").nexusRelease.node')"
  [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
  [[ "$node_version" =~ ^22\.[0-9]+\.[0-9]+$ ]]
  test "$(node --version)" = "v$node_version"
  test -x "$node_root/bin/node"
  test -f "out/make/deb/x64/nexus-ide_${version}_amd64.deb"
  test -f "out/make/zip/linux/x64/NexusIDE-linux-x64-${version}.zip"
  # The installer emits a dedicated pristine native package root; do not mount
  # runner profiles, npm caches, or the broader temporary directory.
  codex_root="${NEXUS_SMOKE_CODEX_ROOT:?verified Linux Codex prerequisite is required}"
  codex_binary="$codex_root/vendor/x86_64-unknown-linux-musl/bin/codex"
  [[ "$codex_root" = /* && "$codex_root" != *','* && "$codex_root" != *$'\n'* && "$codex_root" != *$'\r'* ]]
  test -f "$codex_root/package.json"
  test -f "$codex_binary" && test -x "$codex_binary" && test ! -L "$codex_binary"
  test "${NEXUS_SMOKE_CODEX_VERSION:-}" = 0.145.0
  test "${NEXUS_SMOKE_CODEX_SHA256:-}" = a2a05dafaa1acb002a45eaec0a462de5b13694fcfcd7bc43305f14781ce7be14
  docker info > /dev/null
  docker pull --platform linux/amd64 "$DEBIAN_IMAGE"
  test "$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$DEBIAN_IMAGE")" = linux/amd64
  printf '[debian-smoke] image=%s\n' "$DEBIAN_IMAGE"
  docker run --rm --init --platform linux/amd64 --shm-size=1g \
    --mount "type=bind,src=$workspace,dst=/workspace,readonly" \
    --mount "type=bind,src=$node_root,dst=/opt/nexus-node,readonly" \
    --mount "type=bind,src=$codex_root,dst=/opt/nexus-smoke-codex,readonly" \
    --workdir /workspace \
    --env PATH=/opt/nexus-smoke-codex/vendor/x86_64-unknown-linux-musl/bin:/opt/nexus-node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    --env NEXUS_DEBIAN_CONTAINER=1 \
    --env "NEXUS_DEBIAN_VERSION=$version" \
    --env "NEXUS_DEBIAN_NODE_VERSION=$node_version" \
    --env "NEXUS_SMOKE_CODEX_VERSION=$NEXUS_SMOKE_CODEX_VERSION" \
    --env "NEXUS_SMOKE_CODEX_SHA256=$NEXUS_SMOKE_CODEX_SHA256" \
    --entrypoint /bin/bash "$DEBIAN_IMAGE" \
    /workspace/scripts/smoke-debian-package.sh --inside-container
}

if [[ "$#" = 1 && "$1" = --inside-container ]]; then
  smoke_inside_container
elif [[ "$#" != 0 ]]; then
  printf 'usage: smoke-debian-package.sh\n' >&2
  exit 2
else
  smoke_from_host
fi
