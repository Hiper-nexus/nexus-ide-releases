# Nexus IDE — optional bash OSC 133 shell integration (clean-room).
#   [[ -n "$NEXUS_SHELL_INTEGRATION" ]] && source /path/to/nexus-osc133.bash

if [[ -n "${NEXUS_OSC133_LOADED:-}" ]]; then
  return 0 2>/dev/null || exit 0
fi
NEXUS_OSC133_LOADED=1

__nexus_osc() {
  printf '\033]%s\007' "$1"
}

__nexus_preexec() {
  local cmd=$1
  __nexus_osc "133;B"
  __nexus_osc "133;E;${cmd//$'\n'/ }"
  __nexus_osc "133;C"
}

__nexus_prompt_command() {
  local code=$?
  __nexus_osc "133;D;${code}"
  __nexus_osc "133;A"
  if [[ -n "$PWD" ]]; then
    __nexus_osc "133;P;cwd=${PWD}"
  fi
}

# bash 4+ DEBUG trap for preexec
trap '__nexus_preexec "$BASH_COMMAND"' DEBUG
PROMPT_COMMAND="__nexus_prompt_command${PROMPT_COMMAND:+;$PROMPT_COMMAND}"
