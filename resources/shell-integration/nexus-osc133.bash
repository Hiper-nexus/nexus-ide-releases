# Nexus IDE — optional bash OSC 133 shell integration (clean-room).
#   [[ -n "$NEXUS_SHELL_INTEGRATION" ]] && source /path/to/nexus-osc133.bash

if [[ -n "${NEXUS_OSC133_LOADED:-}" ]]; then
  return 0 2>/dev/null || exit 0
fi
NEXUS_OSC133_LOADED=1

__nexus_osc() {
  printf '\033]%s\007' "$1"
}

__nexus_osc_escape() {
  local value=$1
  value=${value//'%'/'%25'}
  value=${value//';'/'%3B'}
  value=${value//$'\033'/'%1B'}
  value=${value//$'\007'/'%07'}
  value=${value//$'\n'/'%0A'}
  value=${value//$'\r'/'%0D'}
  printf '%s' "$value"
}

__nexus_preexec() {
  local cmd=$1
  # The DEBUG trap also fires for every command of PROMPT_COMMAND (ours and
  # other hooks'); those firings are prompt bookkeeping, not user work —
  # emitting them left the hook text pending as the next command's name.
  case "$PROMPT_COMMAND" in
    *"$cmd"*) return ;;
  esac
  __nexus_osc "133;B"
  __nexus_osc "133;E;$(__nexus_osc_escape "$cmd")"
  __nexus_osc "133;C"
}

__nexus_prompt_command() {
  local code=$?
  __nexus_osc "133;D;${code}"
  __nexus_osc "133;A"
  if [[ -n "$PWD" ]]; then
    __nexus_osc "133;P;cwd=$(__nexus_osc_escape "$PWD")"
  fi
}

# bash 4+ DEBUG trap for preexec. Armed last: while this file sources, its own
# lines must not fire the trap and leave their text pending as a command name.
PROMPT_COMMAND="__nexus_prompt_command${PROMPT_COMMAND:+;$PROMPT_COMMAND}"
trap '__nexus_preexec "$BASH_COMMAND"' DEBUG
