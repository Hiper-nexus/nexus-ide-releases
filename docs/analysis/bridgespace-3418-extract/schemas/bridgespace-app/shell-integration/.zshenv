# BridgeSpace Terminal - Load user environment
USER_ZDOTDIR="${__BS_ORIG_ZDOTDIR:-$HOME}"
[[ -f "$USER_ZDOTDIR/.zshenv" ]] && source "$USER_ZDOTDIR/.zshenv"
# Source /etc/zprofile unconditionally so macOS path_helper populates PATH
# from /etc/paths and /etc/paths.d/* even for fast-shell (non-login) terminals.
if [[ -z "$__BS_ETC_ZPROFILE_SOURCED" && -f "/etc/zprofile" ]]; then
  export __BS_ETC_ZPROFILE_SOURCED=1
  source "/etc/zprofile"
fi
