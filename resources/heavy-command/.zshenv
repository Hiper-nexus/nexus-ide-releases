# Only the Main-owned pane environment points ZDOTDIR here.
if [[ -n "$NEXUS_HEAVY_ORIG_ZDOTDIR" && "$NEXUS_HEAVY_ORIG_ZDOTDIR" != "$ZDOTDIR" && -r "$NEXUS_HEAVY_ORIG_ZDOTDIR/.zshenv" ]]; then
  # User startup (notably compinit) writes relative to ZDOTDIR. Never expose
  # the signed resource directory as the user's configuration directory.
  __nexus_heavy_zshenv_zdotdir="$ZDOTDIR"
  export ZDOTDIR="$NEXUS_HEAVY_ORIG_ZDOTDIR"
  source "$ZDOTDIR/.zshenv"
  export NEXUS_HEAVY_ORIG_ZDOTDIR="${ZDOTDIR-$HOME}"
  export ZDOTDIR="$__nexus_heavy_zshenv_zdotdir"
  unset __nexus_heavy_zshenv_zdotdir
fi
source "$NEXUS_HEAVY_DIR/shell.zsh"
