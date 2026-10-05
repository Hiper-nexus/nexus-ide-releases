#!/usr/bin/env bash
# CI do app SEM GitHub Actions: as etapas de `.github/workflows/ci.yml` (typecheck,
# sinks do renderer, testes) num container ubuntu:22.04 limpo, como usuário comum e
# sobre um commit exato. O Actions é cobrado por minuto; esta máquina (ou uma VPS)
# roda o mesmo gate sem custo.
#
#   scripts/ci-local-docker.sh [commit-ish]      # padrão: HEAD (o que está COMMITADO)
#
# Variável: DOCKER (padrão "docker"; "sudo docker" se o usuário não está no grupo).
# Só o que está commitado entra: mudança não commitada NÃO é testada (o container
# clona o repositório). Sai com o status do CI; o log fica no stdout.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
REF="${1:-HEAD}"
SHA="$(git -C "$REPO" rev-parse --verify "$REF^{commit}")"
read -r -a DOCKER <<< "${DOCKER:-docker}"
IMAGE="${LINUX_BUILD_IMAGE:-ubuntu:22.04}"

if ! git -C "$REPO" merge-base --is-ancestor "$SHA" HEAD 2>/dev/null && ! git -C "$REPO" cat-file -e "$SHA" 2>/dev/null; then
  echo "commit $SHA não existe neste checkout" >&2; exit 1
fi
[ -z "$(git -C "$REPO" status --porcelain --untracked-files=no)" ] || echo "[ci-local] aviso: há mudança não commitada; só $SHA é testado" >&2

"${DOCKER[@]}" pull -q "$IMAGE" >/dev/null
echo "[ci-local] commit $SHA em $IMAGE"
status=0
"${DOCKER[@]}" run --rm --init --shm-size=1g \
  --mount "type=bind,src=$REPO,dst=/source-ro,readonly" \
  --mount "type=bind,src=$REPO/scripts/linux-release-container.sh,dst=/linux-release-container.sh,readonly" \
  --env "CI_REF=$SHA" --env "IMAGE_ID=ci-local" \
  "$IMAGE" bash /linux-release-container.sh ci || status=$?
if [ "$status" = 0 ]; then echo "[ci-local] PASSOU: $SHA"; else echo "[ci-local] FALHOU ($status): $SHA" >&2; fi
exit "$status"
