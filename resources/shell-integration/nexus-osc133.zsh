# Nexus IDE — optional zsh OSC 133 shell integration (clean-room).
# Source from ~/.zshrc only when running inside Nexus:
#   [[ -n "$NEXUS_SHELL_INTEGRATION" ]] && source /path/to/nexus-osc133.zsh
# Does not alter prompt visuals beyond emitting OSC sequences for CommandBlocks.

if [[ -n "${NEXUS_OSC133_LOADED:-}" ]]; then
  return 0
fi
NEXUS_OSC133_LOADED=1

__nexus_osc() {
  printf '\033]%s\007' "$1"
}

__nexus_preexec() {
  __nexus_osc "133;B"
  __nexus_osc "133;E;${1//$'\n'/ }"
  __nexus_osc "133;C"
}

__nexus_precmd() {
  local code=$?
  __nexus_osc "133;D;${code}"
  __nexus_osc "133;A"
  if [[ -n "$PWD" ]]; then
    __nexus_osc "133;P;cwd=${PWD}"
  fi
}

autoload -Uz add-zsh-hook 2>/dev/null || true
if typeset -f add-zsh-hook >/dev/null 2>&1; then
  add-zsh-hook preexec __nexus_preexec
  add-zsh-hook precmd __nexus_precmd
fi
