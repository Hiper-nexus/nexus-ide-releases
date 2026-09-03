# BridgeSpace Shell Integration - OSC 133
export BRIDGESPACE_SHELL_INTEGRATION=1
__bs_osc133() { printf '\e]133;%s\e\\' "$1"; }
__bs_osc133p() { printf '\e]133;%s;%s\e\\' "$1" "$2"; }
__bs_osc_cwd() { printf '\e]9;9;%s\e\\' "$PWD"; }
__bs_precmd() {
  local ec=$?
  [[ -n "$__bs_cmd" ]] && { __bs_osc133p D $ec; unset __bs_cmd; }
  __bs_osc_cwd
  __bs_osc133 A
}
__bs_preexec() { __bs_cmd=1; __bs_osc133 B; __bs_osc133 C; }
precmd_functions+=(__bs_precmd)
preexec_functions+=(__bs_preexec)
__bs_osc_cwd
__bs_osc133 A
