# BridgeSpace Shell Integration - OSC 133
export BRIDGESPACE_SHELL_INTEGRATION=1
__bs_osc133() { printf '\e]133;%s\e\\' "$1"; }
__bs_osc133p() { printf '\e]133;%s;%s\e\\' "$1" "$2"; }
__bs_osc_cwd() { printf '\e]9;9;%s\e\\' "$PWD"; }
__bs_prompt() {
  local ec=$?
  __bs_in_prompt=1
  [[ -n "$__bs_cmd" ]] && { __bs_osc133p D $ec; __bs_cmd=; }
  __bs_osc_cwd
  __bs_osc133 A
  __bs_in_prompt=
}
__bs_preexec() {
  [[ -n "$__bs_in_prompt" || -n "$__bs_cmd" || "$BASH_COMMAND" == *"__bs_"* ]] && return
  __bs_cmd=1
  __bs_osc133 B
  __bs_osc133 C
}
PROMPT_COMMAND="__bs_prompt${PROMPT_COMMAND:+;}$PROMPT_COMMAND"
trap '__bs_preexec' DEBUG
__bs_osc_cwd
__bs_osc133 A
