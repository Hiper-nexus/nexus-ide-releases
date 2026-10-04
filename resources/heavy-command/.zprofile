if [[ -n "$NEXUS_HEAVY_ORIG_ZDOTDIR" && "$NEXUS_HEAVY_ORIG_ZDOTDIR" != "$ZDOTDIR" && -r "$NEXUS_HEAVY_ORIG_ZDOTDIR/.zprofile" ]]; then
  source "$NEXUS_HEAVY_ORIG_ZDOTDIR/.zprofile"
fi
