# BridgeSpace Terminal - Shell Integration Loader
USER_ZDOTDIR="${__BS_ORIG_ZDOTDIR:-$HOME}"
BRIDGESPACE_INTEGRATION_DIR="${BRIDGESPACE_SHELL_INTEGRATION_DIR:-/Users/cleofasrocha/Library/Application Support/io.bridgemind.bridgespace/shell-integration}"
if [[ -z "$BRIDGESPACE_FAST_SHELL" && -f "$USER_ZDOTDIR/.zshrc" ]]; then
  source "$USER_ZDOTDIR/.zshrc"
fi
source "$BRIDGESPACE_INTEGRATION_DIR/integration.zsh"
ZDOTDIR="$USER_ZDOTDIR"
