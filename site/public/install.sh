#!/bin/sh
# NexusIDE para Linux (x64) — instalador de um comando.
#
#   curl -fsSL https://nexuside.app/install.sh | sh
#
# Descobre a sua distribuição, baixa a versão mais nova do espelho público de releases
# (github.com/Hiper-nexus/nexus-ide-releases), confere o SHA-256 e instala:
#   Debian, Ubuntu e derivados  -> .deb   (apt, um pedido de senha)
#   Fedora, RHEL, openSUSE      -> .rpm   (dnf/yum/zypper, um pedido de senha)
#   Arch, Omarchy e as demais   -> .zip portátil, só no seu usuário (sem senha)
#
# Rode de novo a qualquer momento para atualizar. Opções:
#   --zip         instala o portátil mesmo numa distribuição com pacote
#   --no-launch   não abre o NexusIDE no fim da instalação portátil
#   --help        mostra esta ajuda
#
# O que NÃO faz: não altera repositórios do sistema, não importa chaves, não baixa nada
# fora do espelho de releases e não instala o que não bate com o SHA-256 publicado.
# Linux é beta: os pacotes ainda não têm assinatura digital — a conferência é pelo SHA-256.

set -eu

SITE="https://nexuside.app"
RELEASES_PREFIX="https://github.com/Hiper-nexus/nexus-ide-releases/releases/download/v"
SUMS_NAME="SHA256SUMS-linux-x64.txt"
PORTABLE_DIR_NAME="NexusIDE-linux-x64"

FORCE_ZIP=0
LAUNCH=1
TMP=""

say() { printf '%s\n' "$*"; }
warn() { printf 'aviso: %s\n' "$*" >&2; }
die() { printf 'erro: %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

cleanup() {
  if [ -n "$TMP" ] && [ -d "$TMP" ]; then rm -rf "$TMP"; fi
}
trap cleanup EXIT INT TERM HUP

usage() {
  sed -n '2,19p' "$0" 2>/dev/null | sed 's/^# \{0,1\}//' || true
}

for arg in "$@"; do
  case "$arg" in
    --zip) FORCE_ZIP=1 ;;
    --no-launch) LAUNCH=0 ;;
    -h|--help) usage; exit 0 ;;
    *) die "opção desconhecida: $arg (use --help)" ;;
  esac
done

[ "$(uname -s)" = "Linux" ] || die "este instalador é só para Linux. No Mac e no Windows baixe em $SITE/#download"
case "$(uname -m)" in
  x86_64|amd64) ;;
  *) die "por enquanto o NexusIDE para Linux é só x64 (este computador é $(uname -m))" ;;
esac
have curl || die "preciso do curl (sudo apt install curl, sudo dnf install curl ou sudo pacman -S curl)"

# Download que retoma de onde parou e tenta de novo: a internet de quem instala nem sempre é boa.
download() {
  attempt=0
  until curl -fL --progress-bar -C - -o "$2" "$1"; do
    attempt=$((attempt + 1))
    [ "$attempt" -lt 4 ] || return 1
    warn "o download foi interrompido; retomando ($attempt/3)…"
    sleep 2
  done
}

as_root() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  elif have sudo; then
    sudo "$@"
  else
    die "preciso de permissão de administrador e o sudo não está instalado; rode como root ou use --zip"
  fi
}

# --- 1. qual formato -------------------------------------------------------------------------
OS_IDS=""
if [ -r /etc/os-release ]; then
  # shellcheck disable=SC1091
  OS_IDS="$( . /etc/os-release >/dev/null 2>&1; printf '%s %s' "${ID:-}" "${ID_LIKE:-}" )"
fi

METHOD="zip"
FORMAT="zip"
if [ "$FORCE_ZIP" -eq 0 ]; then
  case " $OS_IDS " in
    *" debian "*|*" ubuntu "*)
      if have apt-get; then METHOD="apt"; FORMAT="deb"; fi ;;
    *" fedora "*|*" rhel "*|*" centos "*|*" suse "*|*" opensuse "*)
      if have dnf; then METHOD="dnf"; FORMAT="rpm"
      elif have zypper; then METHOD="zypper"; FORMAT="rpm"
      elif have yum; then METHOD="yum"; FORMAT="rpm"
      fi ;;
  esac
fi

# --- 2. qual versão --------------------------------------------------------------------------
# O próprio site sabe qual é a release mais nova de cada formato (/download/linux-deb|rpm|zip).
URL="$(curl -fsS -o /dev/null -w '%{redirect_url}' "$SITE/download/linux-$FORMAT" || true)"
case "$URL" in
  "$RELEASES_PREFIX"*) ;;
  "") die "não consegui falar com $SITE agora. Confira a internet e tente de novo." ;;
  *) die "o pacote Linux ainda não foi publicado. Veja $SITE/#download e tente mais tarde." ;;
esac
# Só caracteres seguros no endereço que vai para o curl e para o nome do arquivo.
case "$URL" in
  *[!A-Za-z0-9._:/+~%-]*) die "endereço de download inesperado" ;;
esac
FILE="${URL##*/}"
BASE="${URL%/*}"
VERSION="${BASE##*/download/v}"
case "$FILE" in
  nexus-ide_"$VERSION"_amd64.deb|nexus-ide-"$VERSION"-1.x86_64.rpm|NexusIDE-linux-x64-"$VERSION".zip) ;;
  *) die "nome de pacote inesperado: $FILE" ;;
esac

say "NexusIDE $VERSION para Linux ($FORMAT)"

# --- 3. baixar e conferir --------------------------------------------------------------------
TMP="$(mktemp -d "${TMPDIR:-/tmp}/nexus-ide-install.XXXXXX")"
# O apt roda como outro usuário e precisa ler o arquivo; a pasta só tem o pacote público.
chmod 755 "$TMP"

say "Baixando…"
download "$URL" "$TMP/$FILE" || die "o download falhou; confira a internet e rode o comando de novo"
download "$BASE/$SUMS_NAME" "$TMP/sums" || die "não consegui baixar $SUMS_NAME"

EXPECTED="$(awk -v f="$FILE" '$2 == f { print $1 }' "$TMP/sums")"
case "$EXPECTED" in
  *[!0-9a-f]*|"") die "o $SUMS_NAME não lista $FILE" ;;
esac
[ "${#EXPECTED}" -eq 64 ] || die "SHA-256 publicado em formato inesperado"

if have sha256sum; then
  ACTUAL="$(sha256sum "$TMP/$FILE" | awk '{ print $1 }')"
elif have shasum; then
  ACTUAL="$(shasum -a 256 "$TMP/$FILE" | awk '{ print $1 }')"
elif have openssl; then
  ACTUAL="$(openssl dgst -sha256 "$TMP/$FILE" | awk '{ print $NF }')"
else
  die "preciso de sha256sum, shasum ou openssl para conferir o download"
fi
[ "$ACTUAL" = "$EXPECTED" ] || die "o SHA-256 do download NÃO confere com o publicado; nada foi instalado"
say "SHA-256 conferido."

# --- 4. instalar -----------------------------------------------------------------------------
case "$METHOD" in
  apt)
    say "Instalando com o apt (pode pedir a sua senha)…"
    if ! as_root apt-get install -y "$TMP/$FILE"; then
      say "Atualizando a lista de pacotes e tentando de novo…"
      as_root apt-get update -qq
      as_root apt-get install -y "$TMP/$FILE"
    fi
    ;;
  dnf)
    say "Instalando com o dnf (pode pedir a sua senha)…"
    as_root dnf install -y "$TMP/$FILE"
    ;;
  yum)
    say "Instalando com o yum (pode pedir a sua senha)…"
    as_root yum install -y "$TMP/$FILE"
    ;;
  zypper)
    say "Instalando com o zypper (pode pedir a sua senha)…"
    as_root zypper --non-interactive install --allow-unsigned-rpm "$TMP/$FILE"
    ;;
  zip)
    if [ "$(id -u)" -eq 0 ]; then
      DEST="/opt/nexus-ide"
      BIN_DIR="/usr/local/bin"
    else
      [ -n "${HOME:-}" ] || die "a variável HOME não está definida"
      DEST="${XDG_DATA_HOME:-$HOME/.local/share}/nexus-ide"
      BIN_DIR="$HOME/.local/bin"
    fi
    case "$DEST" in /*) ;; *) die "o caminho de instalação precisa ser absoluto" ;; esac

    say "Descompactando em $DEST…"
    mkdir -p "$TMP/x"
    if have unzip; then
      unzip -q "$TMP/$FILE" -d "$TMP/x"
    elif have bsdtar; then
      bsdtar -xf "$TMP/$FILE" -C "$TMP/x"
    else
      die "preciso do unzip para o pacote portátil (sudo pacman -S unzip ou sudo apt install unzip)"
    fi
    [ -x "$TMP/x/$PORTABLE_DIR_NAME/nexus-ide" ] || die "o pacote portátil veio sem o executável nexus-ide"

    mkdir -p "$(dirname "$DEST")" "$BIN_DIR"
    rm -rf "$DEST.new"
    mv "$TMP/x/$PORTABLE_DIR_NAME" "$DEST.new"
    if [ -d "$DEST" ]; then
      rm -rf "$DEST.old"
      mv "$DEST" "$DEST.old"
    fi
    mv "$DEST.new" "$DEST"
    rm -rf "$DEST.old"
    ln -sf "$DEST/nexus-ide" "$BIN_DIR/nexus-ide"

    case ":${PATH:-}:" in
      *":$BIN_DIR:"*) ;;
      *) warn "$BIN_DIR não está no seu PATH; abra o NexusIDE pelo menu ou rode $BIN_DIR/nexus-ide" ;;
    esac

    # DEB e RPM puxam o bubblewrap como dependência; o portátil não instala nada do sistema.
    have bwrap || warn "o NexusIDE usa o bubblewrap para proteger os terminais dos agentes. Instale: sudo pacman -S bubblewrap (Arch, Omarchy), sudo apt install bubblewrap ou sudo dnf install bubblewrap"

    # A primeira abertura do portátil cria a entrada no menu de aplicativos e o retorno do login.
    if [ "$LAUNCH" -eq 1 ] && { [ -n "${WAYLAND_DISPLAY:-}" ] || [ -n "${DISPLAY:-}" ]; }; then
      say "Abrindo o NexusIDE (a primeira abertura cria o atalho no menu)…"
      nohup "$DEST/nexus-ide" >/dev/null 2>&1 &
    fi
    ;;
esac

say ""
say "Pronto: NexusIDE $VERSION instalado."
if [ "$METHOD" = "zip" ]; then
  say "Abra pelo menu de aplicativos ou rode: nexus-ide"
else
  say "Abra pelo menu de aplicativos ou rode: nexus-ide"
fi
say "Para atualizar no futuro, rode este mesmo comando de novo."
