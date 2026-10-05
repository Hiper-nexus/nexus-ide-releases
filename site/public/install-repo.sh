#!/bin/sh
# NexusIDE para Linux — ativa as atualizações pelo apt (Debian, Ubuntu) ou pelo dnf (Fedora, RHEL).
#
#   curl -fsSL https://nexuside.app/install-repo.sh | sh
#
# Faz DUAS coisas, com um pedido de senha: registra o repositório do NexusIDE no seu sistema (a chave
# pública de assinatura e uma linha de configuração) e instala o NexusIDE por ele. Dali em diante o
# `apt upgrade` ou o `dnf upgrade` atualiza o app como qualquer outro pacote.
#
# Os índices do repositório são assinados com uma chave GPG que só o NexusIDE tem; o apt e o dnf recusam
# índice sem essa assinatura. Os pacotes saem do mesmo espelho de releases do instalador comum.
# Se preferir não alterar os repositórios do sistema, use o instalador comum (install.sh).
#
# Opções:
#   --remove   tira o repositório e a chave do sistema (o NexusIDE instalado continua)
#   --help     mostra esta ajuda
#
# Arch e Omarchy não usam este caminho: o pacote portátil (install.sh) já se atualiza sozinho.
# Linux é beta: os pacotes .deb e .rpm não têm assinatura própria; quem assina é o repositório.

set -eu

SITE="https://nexuside.app"
# Impressão digital da chave de assinatura do repositório (RSA 4096, expira em 2031-10-04).
KEY_FPR="EFFD5CAECBCBEAF7FD72D4779F9BB9C0E2518740"
APT_KEYRING="/etc/apt/keyrings/nexus-ide.gpg"
APT_LIST="/etc/apt/sources.list.d/nexus-ide.list"
DNF_REPO="/etc/yum.repos.d/nexus-ide.repo"

REMOVE=0
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
    --remove) REMOVE=1 ;;
    -h|--help) usage; exit 0 ;;
    *) die "opção desconhecida: $arg (use --help)" ;;
  esac
done

[ "$(uname -s)" = "Linux" ] || die "este instalador é só para Linux. No Mac e no Windows baixe em $SITE/#download"
case "$(uname -m)" in
  x86_64|amd64) ;;
  *) die "por enquanto o NexusIDE para Linux é só x64 (este computador é $(uname -m))" ;;
esac

as_root() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  elif have sudo; then
    sudo "$@"
  else
    die "preciso de permissão de administrador e o sudo não está instalado; rode como root"
  fi
}

# --- 1. qual gerenciador -----------------------------------------------------------------------
OS_IDS=""
if [ -r /etc/os-release ]; then
  # shellcheck disable=SC1091
  OS_IDS="$( . /etc/os-release >/dev/null 2>&1; printf '%s %s' "${ID:-}" "${ID_LIKE:-}" )"
fi
METHOD=""
case " $OS_IDS " in
  *" debian "*|*" ubuntu "*) have apt-get && METHOD="apt" ;;
  *" fedora "*|*" rhel "*|*" centos "*)
    if have dnf; then METHOD="dnf"; elif have yum; then METHOD="yum"; fi ;;
esac
[ -n "$METHOD" ] || die "este caminho é para apt (Debian, Ubuntu) e dnf (Fedora, RHEL). No Arch, Omarchy e openSUSE use: curl -fsSL $SITE/install.sh | sh"

# --- 2. tirar o repositório --------------------------------------------------------------------
if [ "$REMOVE" -eq 1 ]; then
  case "$METHOD" in
    apt) as_root rm -f "$APT_LIST" "$APT_KEYRING" ;;
    *) as_root rm -f "$DNF_REPO" ;;
  esac
  say "Repositório do NexusIDE removido. O app instalado continua; para tirá-lo: sudo ${METHOD} remove nexus-ide"
  exit 0
fi

# --- 3. registrar o repositório e instalar -----------------------------------------------------
have curl || die "preciso do curl (sudo apt install curl ou sudo dnf install curl)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/nexus-ide-repo.XXXXXX")"
chmod 755 "$TMP"

case "$METHOD" in
  apt)
    say "Baixando a chave de assinatura do repositório…"
    curl -fsSL -o "$TMP/key.gpg" "$SITE/linux/nexus-ide.gpg" || die "não consegui baixar a chave em $SITE/linux/nexus-ide.gpg"
    if have gpg; then
      FOUND="$(gpg --show-keys --with-colons "$TMP/key.gpg" 2>/dev/null | awk -F: '/^fpr/ { print $10; exit }')"
      [ "$FOUND" = "$KEY_FPR" ] || die "a chave baixada não tem a impressão digital esperada ($KEY_FPR); nada foi instalado"
      say "Chave conferida: $KEY_FPR"
    else
      warn "sem o gpg não consigo conferir a impressão digital da chave; o apt ainda recusa índice que ela não assinou"
    fi
    as_root install -d -m 755 /etc/apt/keyrings
    as_root install -m 644 "$TMP/key.gpg" "$APT_KEYRING"
    printf 'deb [signed-by=%s] %s/apt/ ./\n' "$APT_KEYRING" "$SITE" > "$TMP/nexus-ide.list"
    as_root install -m 644 "$TMP/nexus-ide.list" "$APT_LIST"
    say "Atualizando a lista de pacotes e instalando (pode pedir a sua senha)…"
    as_root apt-get update -qq
    as_root apt-get install -y nexus-ide
    UPDATE_HINT="sudo apt update && sudo apt upgrade"
    ;;
  dnf|yum)
    cat > "$TMP/nexus-ide.repo" <<REPO
[nexus-ide]
name=NexusIDE (Linux, beta)
baseurl=$SITE/rpm/
enabled=1
gpgcheck=0
repo_gpgcheck=1
gpgkey=$SITE/linux/nexus-ide.asc
metadata_expire=1h
REPO
    as_root install -m 644 "$TMP/nexus-ide.repo" "$DNF_REPO"
    say "Instalando pelo $METHOD (pode pedir a sua senha; o $METHOD pergunta se confia na chave $KEY_FPR)…"
    as_root "$METHOD" install -y nexus-ide
    UPDATE_HINT="sudo $METHOD upgrade"
    ;;
esac

say ""
say "Pronto: o NexusIDE está instalado e ligado ao repositório."
say "Para atualizar: $UPDATE_HINT"
say "Para tirar o repositório: curl -fsSL $SITE/install-repo.sh | sh -s -- --remove"
