#!/usr/bin/env bash
# Gera e ASSINA os metadados dos repositórios apt e dnf do Linux para uma versão já construída.
#
#   scripts/build-linux-repo.sh <pasta com os pacotes> [pasta de saída]
#
# A pasta de entrada é a saída de build-linux-release-docker.sh (.deb, .rpm). A saída fica em
# <saída>/assets/ e TUDO que está lá sobe como asset da MESMA release dos pacotes (nos dois repositórios);
# o Worker do site (site/src/downloads/repo.js) redireciona /apt/* e /rpm/* para esses assets.
#
# - apt: repositório PLANO (`deb … https://nexuside.app/apt/ ./`): Packages, Packages.gz, Release, InRelease, Release.gpg.
# - dnf: repodata do createrepo_c (gz) + repomd.xml.asc; `repo_gpgcheck=1` com `gpgcheck=0` (o RPM em si não é assinado;
#   a integridade vem do repomd assinado, que lista o SHA-256 do primary).
#
# Os índices são gerados em containers (debian:12 e fedora) sem a chave. A ASSINATURA é no host, com a chave de
# ~/.config/nexus-release/gnupg (NEXUS_GNUPGHOME muda), que nunca entra em container. Variável DOCKER como nos outros scripts.
set -euo pipefail

PKG="$(cd "${1:?uso: build-linux-repo.sh <pasta com os pacotes> [saída]}" && pwd -P)"
OUT="${2:-$PKG/repo}"
GNUPGHOME="${NEXUS_GNUPGHOME:-$HOME/.config/nexus-release/gnupg}"
read -r -a DOCKER <<< "${DOCKER:-docker}"
UID_GID="$(id -u):$(id -g)"

shopt -s nullglob
DEBS=("$PKG"/nexus-ide_*_amd64.deb)
RPMS=("$PKG"/nexus-ide-*-1.x86_64.rpm)
[ "${#DEBS[@]}" -eq 1 ] && [ "${#RPMS[@]}" -eq 1 ] || { echo "preciso de exatamente 1 .deb e 1 .rpm em $PKG" >&2; exit 1; }
gpg --homedir "$GNUPGHOME" --list-secret-keys --with-colons 2>/dev/null | grep -q '^sec' || { echo "sem chave GPG de assinatura em $GNUPGHOME" >&2; exit 1; }
FINGERPRINT="$(gpg --homedir "$GNUPGHOME" --list-secret-keys --with-colons | awk -F: '/^fpr/ { print $10; exit }')"

rm -rf "$OUT"
mkdir -p "$OUT/apt" "$OUT/rpm" "$OUT/assets"
cp "${DEBS[0]}" "$OUT/apt/"
cp "${RPMS[0]}" "$OUT/rpm/"

echo "[repo] apt: Packages e Release (apt-ftparchive, container debian:12)"
"${DOCKER[@]}" run --rm -v "$OUT/apt:/repo" -w /repo debian:12 sh -ec '
  apt-get update -qq >/dev/null
  apt-get install -y -qq --no-install-recommends apt-utils >/dev/null
  apt-ftparchive packages . > Packages
  gzip -9nk Packages
  apt-ftparchive \
    -o APT::FTPArchive::Release::Origin=NexusIDE \
    -o APT::FTPArchive::Release::Label=NexusIDE \
    -o APT::FTPArchive::Release::Suite=stable \
    -o APT::FTPArchive::Release::Architectures=amd64 \
    -o APT::FTPArchive::Release::Description="NexusIDE para Linux (beta)" \
    release . > Release
  chown -R '"$UID_GID"' /repo'

echo "[repo] dnf: repodata (createrepo_c, container fedora)"
"${DOCKER[@]}" run --rm -v "$OUT/rpm:/repo" -w /repo fedora:latest sh -ec '
  dnf install -y -q createrepo_c >/dev/null 2>&1
  createrepo_c --quiet --no-database --general-compress-type gz /repo
  chown -R '"$UID_GID"' /repo'

echo "[repo] assinando no host com a chave ${FINGERPRINT: -16}"
sign=(gpg --homedir "$GNUPGHOME" --batch --yes --pinentry-mode loopback --passphrase '' --local-user "$FINGERPRINT")
"${sign[@]}" --clearsign -o "$OUT/apt/InRelease" "$OUT/apt/Release"
"${sign[@]}" --armor --detach-sign -o "$OUT/apt/Release.gpg" "$OUT/apt/Release"
"${sign[@]}" --armor --detach-sign -o "$OUT/rpm/repodata/repomd.xml.asc" "$OUT/rpm/repodata/repomd.xml"

# Prova de que a assinatura confere ANTES de qualquer upload, com um chaveiro novo que só tem a pública.
VERIFY="$(mktemp -d "${TMPDIR:-/tmp}/nexus-repo-verify.XXXXXX")"
chmod 700 "$VERIFY"
gpg --homedir "$GNUPGHOME" --export "$FINGERPRINT" | gpg --homedir "$VERIFY" --batch --import 2>/dev/null
gpg --homedir "$VERIFY" --batch --verify "$OUT/apt/InRelease" 2>&1 | grep -q 'Good signature' || { echo "InRelease não verifica" >&2; exit 1; }
gpg --homedir "$VERIFY" --batch --verify "$OUT/apt/Release.gpg" "$OUT/apt/Release" 2>&1 | grep -q 'Good signature' || { echo "Release.gpg não verifica" >&2; exit 1; }
gpg --homedir "$VERIFY" --batch --verify "$OUT/rpm/repodata/repomd.xml.asc" "$OUT/rpm/repodata/repomd.xml" 2>&1 | grep -q 'Good signature' || { echo "repomd.xml.asc não verifica" >&2; exit 1; }
rm -rf "$VERIFY"

# Os assets da release (o asset não tem pasta: repodata/x vira rpm-repodata-x, como o Worker espera).
for file in InRelease Release Release.gpg Packages Packages.gz; do cp "$OUT/apt/$file" "$OUT/assets/$file"; done
for file in "$OUT"/rpm/repodata/*; do
  base="$(basename "$file")"
  case "$base" in repomd.xml|repomd.xml.asc|*-primary.xml.gz|*-filelists.xml.gz|*-other.xml.gz) cp "$file" "$OUT/assets/rpm-repodata-$base" ;; esac
done
( cd "$OUT/assets" && ls -1 && echo && grep -E '^(Filename|SHA256|Size|Version):' "$OUT/apt/Packages" )
echo "[repo] pronto: $OUT/assets"
