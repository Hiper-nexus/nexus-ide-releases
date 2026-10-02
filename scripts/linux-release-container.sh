#!/usr/bin/env bash
# Roda DENTRO de um container ubuntu:22.04 (root). Espelha as etapas do workflow
# `.github/workflows/linux-release.yml` para gerar DEB, RPM e ZIP portátil de uma
# tag anotada, sem GitHub Actions: o Actions é caro e fica fora do ar quando a
# cobrança trava. Quem chama é `scripts/build-linux-release-docker.sh`.
#
# Entradas: VERSION (sem "v") e as montagens /source-ro (somente leitura) e /out.
# /repo é um caminho de mentira que testes usam: nunca monte nada ali.
# Saída em /out: os três pacotes, SHA256SUMS-linux-x64.txt e build-provenance.json.
#
# O Ubuntu 22.04 é obrigatório: os módulos nativos (better-sqlite3, node-pty)
# são compilados contra a glibc 2.35, e por isso rodam em Debian 12, Ubuntu 22.04+
# e Fedora. Compilar numa distro mais nova (Arch) quebra as mais antigas.
set -euo pipefail

VERSION="${1:?uso: linux-release-container.sh <versão sem v>}"
STAGE="${2:-root}"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
# Num subshell: /etc/os-release define VERSION e sobrescreveria a versão do release.
test "$(. /etc/os-release && printf '%s %s' "$ID" "$VERSION_ID")" = "ubuntu 22.04"
test "$(uname -m)" = x86_64
log() { printf '\n[linux-release] %s\n' "$*"; }

if [ "$STAGE" = root ]; then
  test "$(id -u)" = 0
  export DEBIAN_FRONTEND=noninteractive
  log "dependências do sistema"
  apt-get update -qq
  apt-get install --no-install-recommends -y ca-certificates curl gnupg dirmngr software-properties-common >/dev/null
  # O runner oficial tem Git recente. O 2.34 do Ubuntu 22.04 não conhece
  # `git merge-tree --write-tree` (2.38+), que a fila de merge usa.
  add-apt-repository -y ppa:git-core/ppa >/dev/null
  apt-get update -qq
  # g++-12: o runner oficial tem o GCC 12 e o clang-15 usa a libstdc++ dele (C++20).
  apt-get install --no-install-recommends -y \
    git openssh-client jq xz-utils sudo procps lsof ripgrep \
    build-essential g++-12 clang-15 python3 pkg-config bubblewrap fakeroot rpm xvfb xauth unzip zip \
    libgtk-3-0 libnss3 libasound2 libgbm1 libx11-xcb1 libdrm2 libxshmfence1 \
    dbus-x11 binutils desktop-file-utils >/dev/null
  bwrap --version
  test "$(printf '%s\n' "$(git --version | cut -d' ' -f3)" 2.38.0 | sort -V | head -n1)" = 2.38.0
  git --version
  # Como o runner oficial: usuário comum com sudo, nunca root (alguns testes mudam de
  # resultado como root) e HOME próprio.
  useradd -m -s /bin/bash -u 1001 runner
  echo 'runner ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/runner
  chmod 0440 /etc/sudoers.d/runner
  mkdir -p /work /out
  chown runner:runner /work
  chmod 0777 /out
  log "Node oficial, com SHA-256 conferido"
  # A versão vem do package.json da tag, lido do repositório montado.
  NODE_VERSION="$(git -c safe.directory='*' -C /source-ro show "refs/tags/v$VERSION:package.json" | python3 -c "import json,sys;print(json.load(sys.stdin)['nexusRelease']['node'])")"
  [[ "$NODE_VERSION" =~ ^22\.[0-9]+\.[0-9]+$ ]]
  curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" -o /tmp/SHASUMS256.txt
  NODE_TGZ="node-v$NODE_VERSION-linux-x64.tar.xz"
  curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/$NODE_TGZ" -o "/tmp/$NODE_TGZ"
  (cd /tmp && grep " $NODE_TGZ\$" SHASUMS256.txt | sha256sum -c -)
  mkdir -p /opt/node && tar -xJf "/tmp/$NODE_TGZ" -C /opt/node --strip-components=1
  test "$(/opt/node/bin/node --version)" = "v$NODE_VERSION"
  exec runuser -u runner -- env \
    HOME=/home/runner USER=runner LOGNAME=runner LANG=C.UTF-8 TZ=UTC CI=true \
    PATH="/opt/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    ONNXRUNTIME_NODE_INSTALL_CUDA=skip NODE_OPTIONS=--max-old-space-size=4096 \
    CC=clang-15 CXX=clang++-15 \
    HOST_UID="${HOST_UID:-}" HOST_GID="${HOST_GID:-}" IMAGE_ID="${IMAGE_ID:-unknown}" \
    bash "$0" "$VERSION" runner
fi

# ---- etapa 2: como o usuário `runner`, igual ao runner hospedado ----
test "$(id -un)" = runner
WORK=/work
RUNNER_TEMP="$WORK/runner-temp"
mkdir -p "$RUNNER_TEMP"
: > "$RUNNER_TEMP/github_path"
: > "$RUNNER_TEMP/github_env"
export RUNNER_TEMP GITHUB_PATH="$RUNNER_TEMP/github_path" GITHUB_ENV="$RUNNER_TEMP/github_env"
load_github_env() {
  while IFS= read -r line; do
    [ -n "$line" ] && export "$line" || true
  done < "$GITHUB_ENV"
  while IFS= read -r dir; do
    [ -n "$dir" ] && export PATH="$dir:$PATH" || true
  done < "$GITHUB_PATH"
}

log "código-fonte: tag anotada v$VERSION, imutável"
git config --global --add safe.directory '*'
git clone -q /source-ro "$WORK/src"
cd "$WORK/src"
RELEASE_TAG="refs/tags/v$VERSION"
test "$(git cat-file -t "$RELEASE_TAG")" = tag
RELEASE_COMMIT="$(git rev-parse --verify "$RELEASE_TAG^{commit}")"
TAG_OBJECT="$(git rev-parse --verify "$RELEASE_TAG")"
git merge-base --is-ancestor "$RELEASE_COMMIT" origin/main
git checkout -q --detach "$RELEASE_COMMIT"
test "$(git status --porcelain | wc -l)" = 0
NODE_VERSION="$(python3 -c "import json;print(json.load(open('package.json'))['nexusRelease']['node'])")"
[[ "$NODE_VERSION" =~ ^22\.[0-9]+\.[0-9]+$ ]]
test "$(python3 -c "import json;print(json.load(open('package.json'))['version'])")" = "$VERSION"

NODE_VERSION="$(node --version | sed s/^v//)"
test "$NODE_VERSION" = "$(python3 -c "import json;print(json.load(open('package.json'))['nexusRelease']['node'])")"

log "npm fixado pelo repositório, com a integridade verificada antes do npm ci"
node --input-type=module <<'NODE'
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { readAndAssertReleaseAuthority } from './scripts/release-authority.mjs';
import { bootstrapPinnedNpm } from './scripts/make-release.mjs';
const authority = readAndAssertReleaseAuthority();
if (process.versions.node !== authority.nodeVersion || process.arch !== 'x64') throw new Error('Linux release runtime mismatch');
const execute = (command, args, options) => {
  const result = spawnSync(command, args, { ...options, encoding: 'utf8', shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`pinned npm bootstrap command failed: ${command}`);
  return result;
};
const buildBase = path.join(process.env.RUNNER_TEMP, 'nexus-linux-toolchain');
const pinned = bootstrapPinnedNpm({
  buildBase, version: authority.npmVersion, expectedIntegrity: authority.npmPackageIntegrity,
  execute, environment: process.env,
});
const bin = path.join(buildBase, 'bin');
fs.mkdirSync(bin, { recursive: true });
fs.symlinkSync(pinned.npmCli, path.join(bin, 'npm'));
fs.symlinkSync(path.join(path.dirname(pinned.npmCli), 'npx-cli.js'), path.join(bin, 'npx'));
fs.appendFileSync(process.env.GITHUB_PATH, `${bin}\n`);
for (const name of ['NPM_CONFIG_CACHE', 'NPM_CONFIG_USERCONFIG', 'NPM_CONFIG_REGISTRY']) {
  fs.appendFileSync(process.env.GITHUB_ENV, `${name}=${pinned.npmEnvironment[name]}\n`);
}
NODE
load_github_env
test "$(npm --version)" = "$(node -p 'require("./package.json").packageManager.slice(4)')"

log "compilador C++20 (clang-15 com a libstdc++ do GCC 12)"
test "$("$CC" -dumpversion | cut -d. -f1)" = 15
"$CXX" -print-search-dirs | grep -Eq "/gcc/x86_64-linux-gnu/12(:|$)"
"$CXX" -std=c++20 -fsyntax-only -x c++ - <<'CPP'
class [[deprecated("native compiler gate")]] __attribute__((visibility("default"))) NativeCompilerGate {
 public: int value;
};
CPP

log "npm ci, typecheck, sinks do renderer, testes e segurança de release"
npm ci
npm run typecheck
npm run security:renderer-sinks
npm test
npm run release:security

log "pré-requisito nativo do smoke (Codex fixado por hash)"
node scripts/install-linux-smoke-codex.mjs --output release-artifacts/linux-codex-prerequisite.json
load_github_env

log "build dos pacotes: npm run make"
npm run make -- --platform linux --arch x64

DEB="$WORK/src/out/make/deb/x64/nexus-ide_${VERSION}_amd64.deb"
RPM="$WORK/src/out/make/rpm/x64/nexus-ide-${VERSION}-1.x86_64.rpm"
ZIP="$WORK/src/out/make/zip/linux/x64/NexusIDE-linux-x64-${VERSION}.zip"
for f in "$DEB" "$RPM" "$ZIP"; do test -f "$f"; done

log "smoke do app empacotado (Xvfb)"
xvfb-run -a node scripts/smoke-packaged-app.mjs --verify-restart --expected-version "$VERSION"

log "metadados dos pacotes e instalação do DEB"
test "$(dpkg-deb -f "$DEB" Version)" = "$VERSION"
test "$(dpkg-deb -f "$DEB" Architecture)" = amd64
dpkg-deb -f "$DEB" Depends | grep -Eq '(^|,)[[:space:]]*bubblewrap([[:space:](,]|$)'
dpkg-deb -f "$DEB" Depends | grep -Eq '(^|,)[[:space:]]*desktop-file-utils([[:space:](,]|$)'
test "$(rpm -qp --queryformat '%{VERSION}' "$RPM")" = "$VERSION"
test "$(rpm -qp --queryformat '%{ARCH}' "$RPM")" = x86_64
rpm -qpR "$RPM" | grep -Eq '^bubblewrap([[:space:]]|$)'
rpm -qpR "$RPM" | grep -Eq '^desktop-file-utils([[:space:]]|$)'
rpm -qpR "$RPM" | grep -Eq '^alsa-lib([[:space:]]|$)'
sudo apt-get install --no-install-recommends -y "$DEB" >/dev/null
test "$(dpkg-query -W -f='${Version}' nexus-ide)" = "$VERSION"
node scripts/verify-linux-desktop-identity.mjs
rpm -qpl "$RPM" | grep -Fxq /usr/share/applications/nexus-ide.desktop
rpm -qpl "$RPM" | grep -Fxq /usr/share/pixmaps/nexus-ide.png
mapfile -t BINARIES < <(
  dpkg-query -L nexus-ide | while IFS= read -r entry; do
    if [[ "$entry" == */nexus-ide && -f "$entry" && -x "$entry" && ! -L "$entry" ]]; then printf '%s\n' "$entry"; fi
  done
)
test "${#BINARIES[@]}" = 1
xvfb-run -a node scripts/smoke-packaged-app.mjs --app "${BINARIES[0]}" --verify-restart --expected-version "$VERSION"

log "ZIP portátil: extração segura e smoke do aplicativo extraído"
ZIP_BINARY="$(python3 scripts/extract-linux-zip.py --archive "$ZIP" --out "$RUNNER_TEMP/linux-release-zip")"
xvfb-run -a node scripts/smoke-packaged-app.mjs --app "$ZIP_BINARY" --verify-restart --expected-version "$VERSION"

log "compatibilidade de glibc: nenhum binário do ZIP pode pedir mais que a 2.35"
ZIP_ROOT="$(dirname "$ZIP_BINARY")"
need="$(find "$ZIP_ROOT" -type f \( -name '*.node' -o -name '*.so' -o -name '*.so.*' -o -name nexus-ide -o -name chrome_crashpad_handler -o -name chrome-sandbox \) -print0 \
  | xargs -0 -r objdump -T 2>/dev/null | grep -v ' w ' | grep -o 'GLIBC_[0-9.]*' | sort -Vu | tail -n1)"
echo "glibc máxima exigida: ${need:-nenhuma}"
test "$(printf '%s\n' "${need:-GLIBC_0}" GLIBC_2.35 | sort -V | tail -n1)" = GLIBC_2.35

log "coleta: três pacotes, checksums e proveniência"
cp "$DEB" "$RPM" "$ZIP" /out/
(cd /out && for f in "$(basename "$DEB")" "$(basename "$RPM")" "$(basename "$ZIP")"; do printf '%s  %s\n' "$(sha256sum "$f" | cut -d' ' -f1)" "$f"; done | LC_ALL=C sort -k2 > SHA256SUMS-linux-x64.txt)
NODE_VERSION="$NODE_VERSION" VERSION="$VERSION" RELEASE_COMMIT="$RELEASE_COMMIT" TAG_OBJECT="$TAG_OBJECT" \
IMAGE_ID="${IMAGE_ID:-unknown}" python3 - <<'PY'
import json, os, subprocess, datetime
out = {
  "schema": "nexus.linux-local-build/v1",
  "note": "Gerado fora do GitHub Actions (cobrança bloqueada), num container ubuntu:22.04, com as mesmas etapas do linux-release.yml. Sem recibo do workflow.",
  "version": os.environ["VERSION"],
  "commit": os.environ["RELEASE_COMMIT"],
  "tagObject": os.environ["TAG_OBJECT"],
  "node": os.environ["NODE_VERSION"],
  "npm": subprocess.check_output(["npm", "--version"], text=True).strip(),
  "image": os.environ["IMAGE_ID"],
  "builtAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
  "smoke": {"packaged": True, "debInstalled": True, "zipExtracted": True},
  "glibcMax": "<= 2.35",
}
json.dump(out, open("/out/build-provenance.json", "w"), indent=2)
PY
cat /out/SHA256SUMS-linux-x64.txt
if [ -n "${HOST_UID:-}" ] && [ -n "${HOST_GID:-}" ]; then sudo chown -R "$HOST_UID:$HOST_GID" /out; fi
log "pronto"
