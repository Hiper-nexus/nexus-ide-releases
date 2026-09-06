#!/bin/bash
# Wrapper de codesign para builds de release LOCAIS.
#
# Por quê: com muitos nativos unpacked no asar, o osx-sign dispara dezenas de
# `codesign --timestamp` em sequência e o transporte até o Timestamp Authority
# da Apple pode falhar de forma intermitente. Uma falha depois de a assinatura
# ter sido gravada, mas antes de o timestamp chegar, deixa o Mach-O em estado
# parcial e a tentativa seguinte pode morrer com "internal error". Por isso,
# somente depois de um erro explicitamente relacionado ao TSA removemos essa
# assinatura parcial antes do retry. DMGs não suportam `--remove-signature`:
# nesses contêineres a tentativa limitada reaplica a assinatura com `--force`.
# Identidade, entitlement, keychain e qualquer outra falha abortam de imediato.
#
# Uso (ver build/notarize.md):
#   PATH="$PWD/scripts/codesign-retry-bin:$PATH" npm run make:release
# onde scripts/codesign-retry-bin/codesign é um symlink para este arquivo
# (criado sob demanda: mkdir -p scripts/codesign-retry-bin && ln -sf
#  ../codesign-with-retry.sh scripts/codesign-retry-bin/codesign).
is_retryable_timestamp_failure() {
  LC_ALL=C grep -Eiq \
    'A timestamp was expected but was not found|timestamp (service|authority).*(unavailable|not available|timed out|timeout|connection|network)'
}

# Some networks advertise an unusable IPv6 route to Apple's TSA. Resolve only
# Apple's public IPv4 addresses; codesign still validates Apple's signed token.
resolve_apple_timestamp_ipv4() {
  /usr/bin/python3 - <<'PYTHON'
import ipaddress
import socket
import sys
try:
    for info in socket.getaddrinfo('timestamp.apple.com', 80, socket.AF_INET, socket.SOCK_STREAM):
        address = ipaddress.ip_address(info[4][0])
        if address.is_global:
            print(address)
            sys.exit(0)
except OSError:
    pass
sys.exit(1)
PYTHON
}

prefer_apple_timestamp_ipv4() {
  is_sign_invocation "${command_args[@]}" || return 1
  local arg ipv4 target
  local retained=()
  for arg in "${command_args[@]}"; do
    case "$arg" in
      --timestamp|--timestamp=http://timestamp.apple.com/ts01) ;;
      --timestamp=*) return 1 ;;
      *) retained+=("$arg") ;;
    esac
  done
  ipv4="$(resolve_apple_timestamp_ipv4)" || return 1
  [[ "$ipv4" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || return 1
  local count=${#retained[@]}
  (( count > 0 )) || return 1
  target="${retained[$((count - 1))]}"
  command_args=("${retained[@]:0:$((count - 1))}" "--timestamp=http://$ipv4/ts01" "$target")
  return 0
}

is_correlated_post_timestamp_failure() {
  LC_ALL=C grep -Eiq 'internal error in Code Signing subsystem'
}

remove_partial_signature() {
  local target="$1"
  [[ -e "$target" ]] || return 1
  /usr/bin/codesign --remove-signature "$target"
}

is_sign_invocation() {
  local arg
  for arg in "$@"; do
    case "$arg" in
      --sign|-s) return 0 ;;
    esac
  done
  return 1
}

requests_secure_timestamp() {
  local arg
  for arg in "$@"; do
    case "$arg" in
      --timestamp) return 0 ;;
      --timestamp=none) return 1 ;;
      --timestamp=*) return 0 ;;
    esac
  done
  # codesign solicita o timestamp seguro por padrão quando ele não foi
  # explicitamente desativado. O maker do DMG usa esse padrão e não passa
  # `--timestamp` na argv.
  return 0
}

is_dmg_container() {
  case "$1" in
    *.dmg|*.DMG) return 0 ;;
  esac
  return 1
}

has_force_flag() {
  local arg
  for arg in "$@"; do
    case "$arg" in
      --force|-f) return 0 ;;
    esac
  done
  return 1
}

# Return codes:
#   0 = exact target verifies and, when requested, carries a secure timestamp
#   1 = definitive signature/identity/entitlement failure (never retry)
#   2 = zero-exit partial/unsigned/missing-timestamp state (bounded TSA retry)
verify_signing_postcondition() {
  local target="$1"
  local require_timestamp="$2"
  local stdout_log="$3"
  local stderr_log="$4"

  : >"$stdout_log"
  : >"$stderr_log"
  /usr/bin/codesign --verify --strict "$target" \
    >"$stdout_log" 2>"$stderr_log"
  local verify_status=$?
  if (( verify_status != 0 )); then
    cat "$stdout_log"
    cat "$stderr_log" >&2
    if LC_ALL=C grep -Eiq \
      'code object is not signed at all|A timestamp was expected but was not found' \
      "$stdout_log" "$stderr_log"; then
      return 2
    fi
    return 1
  fi

  if (( require_timestamp == 0 )); then
    return 0
  fi

  : >"$stdout_log"
  : >"$stderr_log"
  /usr/bin/codesign -d --verbose=4 "$target" \
    >"$stdout_log" 2>"$stderr_log"
  local detail_status=$?
  if (( detail_status != 0 )); then
    cat "$stdout_log"
    cat "$stderr_log" >&2
    if LC_ALL=C grep -Eiq 'code object is not signed at all' \
      "$stdout_log" "$stderr_log"; then
      return 2
    fi
    return 1
  fi
  if ! LC_ALL=C grep -Eq '(^|[[:space:]])Timestamp=' \
    "$stdout_log" "$stderr_log"; then
    printf '%s: assinatura sem secure timestamp após codesign retornar sucesso.\n' \
      "$target" >&2
    return 2
  fi
  return 0
}

# Permite testar a política sem executar o codesign real.
if [[ "${BASH_SOURCE[0]}" != "$0" ]]; then
  return 0
fi

set -u

stdout_log="$(mktemp "${TMPDIR:-/tmp}/nexus-codesign-stdout.XXXXXX")" || exit 1
stderr_log="$(mktemp "${TMPDIR:-/tmp}/nexus-codesign-stderr.XXXXXX")" || {
  rm -f "$stdout_log"
  exit 1
}
trap 'rm -f "$stdout_log" "$stderr_log"' EXIT

last=1
attempt=0
timestamp_failure_seen=0
command_args=("$@")
# Esperas antes das tentativas: a primeira é imediata; as seguintes têm
# backoff finito (máximo total de 747 s ≈ 12 min) e nunca escondem uma falha
# definitiva.
#
# O teto era 207 s e NÃO bastava: em três releases seguidas (23/08) o TSA da
# Apple recusou o contêiner DMG nas sete tentativas, esgotando a escada em
# ~3,5 min — enquanto uma assinatura avulsa feita logo depois passava. A
# janela de limitação por rajada dura mais que isso, e cada falha custa um
# `make:release` inteiro (~8 min) refeito do zero. Esperar é mais barato.
for delay in 0 4 8 15 30 60 90 120 180 240; do
  attempt=$((attempt + 1))
  retryable_failure=0
  if (( delay > 0 )); then
    sleep "$delay"
  fi
  : >"$stdout_log"
  : >"$stderr_log"
  /usr/bin/codesign "${command_args[@]}" >"$stdout_log" 2>"$stderr_log"
  last=$?
  cat "$stdout_log"
  cat "$stderr_log" >&2
  if (( last == 0 )); then
    if is_sign_invocation "${command_args[@]}"; then
      target="${command_args[$((${#command_args[@]} - 1))]}"
      require_timestamp=0
      if requests_secure_timestamp "${command_args[@]}"; then
        require_timestamp=1
      fi
      verify_signing_postcondition \
        "$target" "$require_timestamp" "$stdout_log" "$stderr_log"
      postcondition_status=$?
      if (( postcondition_status == 0 )); then
        exit 0
      fi
      last=1
      if (( postcondition_status == 2 )); then
        timestamp_failure_seen=1
        retryable_failure=1
      else
        exit "$last"
      fi
    else
      exit 0
    fi
  fi
  if (( retryable_failure == 1 )); then
    :
  elif cat "$stdout_log" "$stderr_log" | is_retryable_timestamp_failure; then
    timestamp_failure_seen=1
  elif (( timestamp_failure_seen == 1 )) &&
    cat "$stdout_log" "$stderr_log" | is_correlated_post_timestamp_failure; then
    # `codesign` can report this generic residual once after a known TSA
    # failure left the embedded signature half-written. It is retryable only
    # inside that already-established timestamp chain; as a first failure it
    # remains fatal like every other keychain/signing internal error.
    :
  else
    exit "$last"
  fi
  if (( attempt < 10 )); then
    if prefer_apple_timestamp_ipv4; then
      printf '[codesign-retry] tentando IPv4 do serviço de timestamp da Apple.\n' >&2
    fi
    target="${command_args[$((${#command_args[@]} - 1))]}"
    if is_dmg_container "$target"; then
      if ! has_force_flag "${command_args[@]}"; then
        count=${#command_args[@]}
        # `target` is the final positional argument supplied to codesign.
        command_args=("${command_args[@]:0:$((count - 1))}" --force "$target")
      fi
      printf '[codesign-retry] TSA transitório no DMG; reassinando o contêiner com --force (%d/10).\n' \
        "$attempt" >&2
    elif ! remove_partial_signature "$target"; then
      printf '[codesign-retry] não foi possível limpar a assinatura parcial; abortando.\n' >&2
      exit "$last"
    else
      printf '[codesign-retry] falha transitória do TSA da Apple; nova tentativa limitada (%d/10).\n' \
        "$attempt" >&2
    fi
  fi
done
exit "$last"
