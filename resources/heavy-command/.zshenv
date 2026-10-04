# Only the Main-owned pane environment points ZDOTDIR here.
if [[ -n "$NEXUS_HEAVY_ORIG_ZDOTDIR" && "$NEXUS_HEAVY_ORIG_ZDOTDIR" != "$ZDOTDIR" && -r "$NEXUS_HEAVY_ORIG_ZDOTDIR/.zshenv" ]]; then
  source "$NEXUS_HEAVY_ORIG_ZDOTDIR/.zshenv"
fi
source "$NEXUS_HEAVY_DIR/shell.zsh"
