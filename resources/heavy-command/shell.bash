# Only the observed Grok FD5 reader is mediated, before user startup/snapshot.
# Replay skips this branch only; original BASH_ENV and DEBUG remain active.
if [[ "${NEXUS_HEAVY_GROK_REPLAY-}" == 1 ]]; then
  unset NEXUS_HEAVY_GROK_REPLAY
elif [[ -n "${NEXUS_HEAVY_JOB_BASE-}" && "${BASH_EXECUTION_STRING-}" == *'__grok_user_cmd'* && "${BASH_EXECUTION_STRING-}" == *'<&5'* ]]; then
  builtin shopt -q extglob || exit 78
  [[ "$BASH" == /bin/bash && "$#" == 0 && ( -p /dev/fd/3 || -S /dev/fd/3 ) && ( -p /dev/fd/5 || -S /dev/fd/5 ) && ! -e /dev/fd/4 ]] || exit 78
  NEXUS_HEAVY_GROK_OPTIONS_SET="${NODE_OPTIONS+x}" NEXUS_HEAVY_GROK_OPTIONS="${NODE_OPTIONS-}" NODE_OPTIONS= NEXUS_HEAVY_HELPER=1 NEXUS_HEAVY_GROK_CHANNELS=3,5 NEXUS_HEAVY_GROK_WRAPPER="$BASH_EXECUTION_STRING" exec "$NEXUS_HEAVY_NODE" "$NEXUS_HEAVY_DIR/grok-transport.cjs"
fi
# Scoped noninteractive Bash admission. Never installed in a user's profile.
# F-1184: every expansion has a default and "$@" uses ${1+"$@"} (Bash 3.2):
# the DEBUG trap runs inside the caller's script, which may `set -u`.
if [[ -n "${NEXUS_HEAVY_ORIG_BASH_ENV-}" && "${NEXUS_HEAVY_ORIG_BASH_ENV-}" != "${BASH_ENV-}" && -r "${NEXUS_HEAVY_ORIG_BASH_ENV-}" ]]; then
  . "$NEXUS_HEAVY_ORIG_BASH_ENV"
fi
# Observe the caller's channel before Node can create its own descriptors.
__nexus_inherited_fd3=0
if [[ -p /dev/fd/3 || -S /dev/fd/3 ]]; then __nexus_inherited_fd3=1; fi
if [[ -n "${NEXUS_HEAVY_JOB_BASE-}" && -z "${NEXUS_HEAVY_LEASE-}" && "${NEXUS_HEAVY_HELPER-}" != 1 && -n "${BASH_EXECUTION_STRING-}" ]]; then
  __nexus_start_kind=$(NODE_OPTIONS= NEXUS_HEAVY_HELPER=1 "$NEXUS_HEAVY_NODE" "$NEXUS_HEAVY_DIR/classify.cjs" "$BASH_EXECUTION_STRING" ${1+"$@"}) || exit 78
  if [[ -n "$__nexus_start_kind" ]]; then
    exec env NODE_OPTIONS= NEXUS_HEAVY_HELPER=1 NEXUS_HEAVY_INHERITED_FD3="$__nexus_inherited_fd3" "$NEXUS_HEAVY_NODE" "$NEXUS_HEAVY_DIR/job-launch.cjs" "$__nexus_start_kind" "$BASH" -c "$BASH_EXECUTION_STRING" "$0" ${1+"$@"}
  fi
fi
if [[ -n "${NEXUS_HEAVY_COMMAND_URL-}" && -n "${NEXUS_GATE_TOKEN-}" && "${NEXUS_HEAVY_HELPER-}" != 1 ]]; then
  __nexus_heavy_debug() {
    [[ "${__nexus_heavy_admitted-}" == 1 || "${__nexus_heavy_in_debug-}" == 1 ]] && return 0
    # Bash initializes positional parameters after BASH_ENV. A native wrapper
    # can keep the real tool command in $1; recheck before its first command.
    if [[ "${__nexus_start_checked-}" != 1 && -n "${NEXUS_HEAVY_JOB_BASE-}" && -z "${NEXUS_HEAVY_LEASE-}" && -n "${BASH_EXECUTION_STRING-}" ]]; then
      __nexus_start_checked=1
      __nexus_heavy_in_debug=1
      local nexus_start_kind
      nexus_start_kind=$(NODE_OPTIONS= NEXUS_HEAVY_HELPER=1 "$NEXUS_HEAVY_NODE" "$NEXUS_HEAVY_DIR/classify.cjs" "$BASH_EXECUTION_STRING" ${1+"$@"}) || exit 78
      if [[ -n "$nexus_start_kind" ]]; then
        exec env NODE_OPTIONS= NEXUS_HEAVY_HELPER=1 NEXUS_HEAVY_INHERITED_FD3="$__nexus_inherited_fd3" "$NEXUS_HEAVY_NODE" "$NEXUS_HEAVY_DIR/job-launch.cjs" "$nexus_start_kind" "$BASH" -c "$BASH_EXECUTION_STRING" "$0" ${1+"$@"}
      fi
      __nexus_heavy_in_debug=0
    fi
    local nexus_command="${BASH_COMMAND-}" nexus_kind nexus_lease
    case "$nexus_command" in
      *node*|*npm*|*pnpm*|*yarn*|*bun*|*tsc*|*tsgo*|*typecheck*|*vitest*|*jest*|*pytest*|*mocha*|*vite*|*esbuild*|*webpack*|*rollup*|*cargo*|*'go '*|*dotnet*|*make*|*ninja*|*gradle*|*mvn*) ;;
      *) return 0 ;;
    esac
    __nexus_heavy_in_debug=1
    nexus_kind=$(NODE_OPTIONS= NEXUS_HEAVY_HELPER=1 "$NEXUS_HEAVY_NODE" "$NEXUS_HEAVY_DIR/classify.cjs" "$nexus_command") || exit 78
    if [[ -n "$nexus_kind" ]]; then
      nexus_lease=$(NODE_OPTIONS= NEXUS_HEAVY_HELPER=1 "$NEXUS_HEAVY_NODE" "$NEXUS_HEAVY_DIR/request.cjs" "${BASHPID:-$$}" "$nexus_kind") || { printf '%s\n' '[Nexus] Heavy command not started: physical CPU/RAM admission unavailable.' >&2; exit 78; }
      export NEXUS_HEAVY_LEASE="$nexus_lease"
      __nexus_heavy_admitted=1
    fi
    __nexus_heavy_in_debug=0
    return 0
  }
  # Native tool shells do not inherit DEBUG traps by default. Function tracing
  # carries the reservation through shell functions without another RAM slot.
  set -o functrace
  trap '__nexus_heavy_debug ${1+"$@"}' DEBUG
fi
