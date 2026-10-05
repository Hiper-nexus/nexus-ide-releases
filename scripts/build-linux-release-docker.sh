#!/usr/bin/env bash
# Gera DEB, RPM e ZIP portátil do Linux numa tag anotada, dentro de um container
# ubuntu:22.04, SEM GitHub Actions. Serve quando o Actions está bloqueado ou caro
# e é o mesmo comando para uma VPS própria.
#
#   scripts/build-linux-release-docker.sh <versão sem v> [diretório de saída]
#
# Falha conhecida de uma tag imutável (já corrigida depois): KNOWN_TEST_FAILURE_FILE e
# KNOWN_TEST_FAILURE_MATCH; o teste precisa falhar exatamente assim ou o build aborta
# (ver linux-release-container.sh). A exceção fica em build-provenance.json.
# Paridade com o runner e o macOS, sem pular teste: o container instala zsh e aceita
# NEXUS_CI_TMPDIR (um TMPDIR comprido, ~60 caracteres como o do macOS: fixtures do F-788
# só passam de 255 caracteres com ele) e CI_TMPFS (ex.: 6g; /tmp em tmpfs, sem o overlayfs,
# onde o demo-missions-e2e não vê o arquivo do drop-box). Vão para build-provenance.json.
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
TMPFS_ARGS=()
[ -z "${CI_TMPFS:-}" ] || TMPFS_ARGS=(--tmpfs "/tmp:exec,mode=1777,size=$CI_TMPFS")
"${DOCKER[@]}" run --rm --init --shm-size=1g "${TMPFS_ARGS[@]}" \
  --mount "type=bind,src=$REPO,dst=/source-ro,readonly" \
  --mount "type=bind,src=$OUT,dst=/out" \
  --mount "type=bind,src=$REPO/scripts/linux-release-container.sh,dst=/linux-release-container.sh,readonly" \
  --env "IMAGE_ID=$IMAGE_ID" --env "HOST_UID=$(id -u)" --env "HOST_GID=$(id -g)" \
  --env "KNOWN_TEST_FAILURE_FILE=${KNOWN_TEST_FAILURE_FILE:-}" --env "KNOWN_TEST_FAILURE_MATCH=${KNOWN_TEST_FAILURE_MATCH:-}" \
  --env "NEXUS_CI_TMPDIR=${NEXUS_CI_TMPDIR:-}" --env "CI_TMPFS=${CI_TMPFS:-}" \
  "$IMAGE" bash /linux-release-container.sh "$VERSION" || status=$?
exit "$status"
