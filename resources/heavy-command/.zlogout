if [[ -n "$NEXUS_HEAVY_ORIG_ZDOTDIR" && "$NEXUS_HEAVY_ORIG_ZDOTDIR" != "$ZDOTDIR" && -r "$NEXUS_HEAVY_ORIG_ZDOTDIR/.zlogout" ]]; then
  # User startup (notably compinit) writes relative to ZDOTDIR. Never expose
  # the signed resource directory as the user's configuration directory.
  __nexus_heavy_zlogout_zdotdir="$ZDOTDIR"
  export ZDOTDIR="$NEXUS_HEAVY_ORIG_ZDOTDIR"
  source "$ZDOTDIR/.zlogout"
  export NEXUS_HEAVY_ORIG_ZDOTDIR="${ZDOTDIR-$HOME}"
  export ZDOTDIR="$__nexus_heavy_zlogout_zdotdir"
  unset __nexus_heavy_zlogout_zdotdir
fi
