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
  printf '[debian-smoke] installed-deb begin uid=10001\n'
  runuser -u nexus-smoke -- dbus-run-session -- \
    xvfb-run -a -s '-screen 0 1280x1024x24' \
    /opt/nexus-node/bin/node scripts/smoke-packaged-app.mjs --app "${binaries[0]}"

  local zip_binary
  zip_binary="$(runuser -u nexus-smoke -- python3 scripts/extract-linux-zip.py \
    --archive "$archive" --out /tmp/nexus-debian-smoke/zip)"
  test -x "$zip_binary"
  printf '[debian-smoke] extracted-zip begin uid=10001\n'
  runuser -u nexus-smoke -- dbus-run-session -- \
    xvfb-run -a -s '-screen 0 1280x1024x24' \
    /opt/nexus-node/bin/node scripts/smoke-packaged-app.mjs --app "$zip_binary"
  printf '[debian-smoke] installed-deb and extracted-zip passed\n'
}

smoke_from_host() {
  local workspace node_binary node_root version node_version
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
  docker info > /dev/null
  docker pull --platform linux/amd64 "$DEBIAN_IMAGE"
  test "$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$DEBIAN_IMAGE")" = linux/amd64
  printf '[debian-smoke] image=%s\n' "$DEBIAN_IMAGE"
  docker run --rm --init --platform linux/amd64 --shm-size=1g \
    --mount "type=bind,src=$workspace,dst=/workspace,readonly" \
    --mount "type=bind,src=$node_root,dst=/opt/nexus-node,readonly" \
    --workdir /workspace \
    --env PATH=/opt/nexus-node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    --env NEXUS_DEBIAN_CONTAINER=1 \
    --env "NEXUS_DEBIAN_VERSION=$version" \
    --env "NEXUS_DEBIAN_NODE_VERSION=$node_version" \
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
