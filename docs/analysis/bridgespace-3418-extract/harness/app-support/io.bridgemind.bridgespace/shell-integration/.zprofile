# BridgeSpace Terminal - Login Profile Loader
USER_ZDOTDIR="${__BS_ORIG_ZDOTDIR:-$HOME}"
if [[ -z "$__BS_ETC_ZPROFILE_SOURCED" && -f "/etc/zprofile" ]]; then
  export __BS_ETC_ZPROFILE_SOURCED=1
  source "/etc/zprofile"
fi
if [[ -z "$BRIDGESPACE_FAST_SHELL" && -f "$USER_ZDOTDIR/.zprofile" ]]; then
  source "$USER_ZDOTDIR/.zprofile"
fi
