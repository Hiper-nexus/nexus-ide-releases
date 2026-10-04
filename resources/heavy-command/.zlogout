if [[ -n "$NEXUS_HEAVY_ORIG_ZDOTDIR" && "$NEXUS_HEAVY_ORIG_ZDOTDIR" != "$ZDOTDIR" && -r "$NEXUS_HEAVY_ORIG_ZDOTDIR/.zlogout" ]]; then
  source "$NEXUS_HEAVY_ORIG_ZDOTDIR/.zlogout"
fi
