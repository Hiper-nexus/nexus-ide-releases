# Scoped zsh DEBUG runs before an external command, including absolute paths.
if [[ -n "$NEXUS_HEAVY_JOB_BASE" && -z "$NEXUS_HEAVY_LEASE" && "$NEXUS_HEAVY_HELPER" != 1 && -n "$ZSH_EXECUTION_STRING" ]]; then
  __nexus_start_kind=$(NODE_OPTIONS= NEXUS_HEAVY_HELPER=1 "$NEXUS_HEAVY_NODE" "$NEXUS_HEAVY_DIR/classify.cjs" "$ZSH_EXECUTION_STRING") || exit 78
  if [[ -n "$__nexus_start_kind" ]]; then
    exec env NODE_OPTIONS= NEXUS_HEAVY_HELPER=1 "$NEXUS_HEAVY_NODE" "$NEXUS_HEAVY_DIR/job-launch.cjs" "$__nexus_start_kind" /bin/zsh -c "$ZSH_EXECUTION_STRING" "$0" "$@"
  fi
fi
if [[ -n "$NEXUS_HEAVY_COMMAND_URL" && -n "$NEXUS_GATE_TOKEN" && "$NEXUS_HEAVY_HELPER" != 1 ]]; then
  if (( $+functions[TRAPDEBUG] )); then
    functions[__nexus_heavy_previous_debug]=$functions[TRAPDEBUG]
  fi
  TRAPDEBUG() {
    if (( $+functions[__nexus_heavy_previous_debug] )); then __nexus_heavy_previous_debug "$@"; fi
    [[ "$__nexus_heavy_admitted" == 1 || "$__nexus_heavy_in_debug" == 1 ]] && return 0
    local nexus_command="$ZSH_DEBUG_CMD" nexus_kind nexus_lease
    case "$nexus_command" in
      *node*|*npm*|*pnpm*|*yarn*|*bun*|*tsc*|*tsgo*|*typecheck*|*vitest*|*jest*|*pytest*|*mocha*|*vite*|*esbuild*|*webpack*|*rollup*|*cargo*|*'go '*|*dotnet*|*make*|*ninja*|*gradle*|*mvn*) ;;
      *) return 0 ;;
    esac
    __nexus_heavy_in_debug=1
    nexus_kind=$(NODE_OPTIONS= NEXUS_HEAVY_HELPER=1 "$NEXUS_HEAVY_NODE" "$NEXUS_HEAVY_DIR/classify.cjs" "$nexus_command") || exit 78
    if [[ -n "$nexus_kind" ]]; then
      nexus_lease=$(NODE_OPTIONS= NEXUS_HEAVY_HELPER=1 "$NEXUS_HEAVY_NODE" "$NEXUS_HEAVY_DIR/request.cjs" "$$" "$nexus_kind") || { print -u2 -- '[Nexus] Heavy command not started: physical CPU/RAM admission unavailable.'; exit 78; }
      export NEXUS_HEAVY_LEASE="$nexus_lease"
      __nexus_heavy_admitted=1
    fi
    __nexus_heavy_in_debug=0
    return 0
  }
  setopt DEBUG_BEFORE_CMD
fi
