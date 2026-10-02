#!/usr/bin/env bash
# Gera DEB, RPM e ZIP portátil do Linux numa tag anotada, dentro de um container
# ubuntu:22.04, SEM GitHub Actions. Serve quando o Actions está bloqueado ou caro
# e é o mesmo comando para uma VPS própria.
#
#   scripts/build-linux-release-docker.sh <versão sem v> [diretório de saída]
#
# Variáveis: DOCKER (padrão "docker"; use "sudo docker" se o usuário não está no
# grupo docker) e LINUX_BUILD_IMAGE (padrão ubuntu:22.04).
#
# Isto NÃO produz o recibo `nexus.linux-release/v2` que `release:publish:linux`
# exige: ele prova um run do workflow. A saída leva `build-provenance.json` e
# `SHA256SUMS-linux-x64.txt`, e a publicação é manual (docs/RELEASE.md).
set -euo pipefail

VERSION="${1:?uso: build-linux-release-docker.sh <versão sem v> [saída]}"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
OUT="${2:-$REPO/release-artifacts/linux-local/$VERSION}"
read -r -a DOCKER <<< "${DOCKER:-docker}"
IMAGE="${LINUX_BUILD_IMAGE:-ubuntu:22.04}"

git -C "$REPO" cat-file -e "refs/tags/v$VERSION" 2>/dev/null || { echo "a tag v$VERSION não existe neste checkout" >&2; exit 1; }
test "$(git -C "$REPO" cat-file -t "refs/tags/v$VERSION")" = tag || { echo "v$VERSION precisa ser tag ANOTADA" >&2; exit 1; }

mkdir -p "$OUT"
"${DOCKER[@]}" pull -q "$IMAGE" >/dev/null
IMAGE_ID="$("${DOCKER[@]}" image inspect --format '{{index .RepoDigests 0}}' "$IMAGE" 2>/dev/null || "${DOCKER[@]}" image inspect --format '{{.Id}}' "$IMAGE")"
echo "[linux-release] imagem: $IMAGE_ID"
echo "[linux-release] saída:  $OUT"

status=0
"${DOCKER[@]}" run --rm --init --shm-size=1g \
  --mount "type=bind,src=$REPO,dst=/source-ro,readonly" \
  --mount "type=bind,src=$OUT,dst=/out" \
  --mount "type=bind,src=$REPO/scripts/linux-release-container.sh,dst=/linux-release-container.sh,readonly" \
  --env "IMAGE_ID=$IMAGE_ID" --env "HOST_UID=$(id -u)" --env "HOST_GID=$(id -g)" \
  "$IMAGE" bash /linux-release-container.sh "$VERSION" || status=$?
exit "$status"
