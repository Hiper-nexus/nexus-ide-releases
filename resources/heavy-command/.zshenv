# Main uses signed Resources on other platforms and a private shim/cache profile
# on macOS. Restore the bootstrap directory so every nested zsh loads this guard.
if [[ -n "$NEXUS_HEAVY_ORIG_ZDOTDIR" && "$NEXUS_HEAVY_ORIG_ZDOTDIR" != "$ZDOTDIR" && -r "$NEXUS_HEAVY_ORIG_ZDOTDIR/.zshenv" ]]; then
  # User startup (notably compinit) writes relative to ZDOTDIR. Never expose
  # the signed resource directory as the user's configuration directory.
  __nexus_heavy_zshenv_zdotdir="$ZDOTDIR"
  export ZDOTDIR="$NEXUS_HEAVY_ORIG_ZDOTDIR"
  source "$ZDOTDIR/.zshenv"
  __nexus_heavy_resource_root="${NEXUS_HEAVY_DIR:A}"
  if [[ "${NEXUS_HEAVY_DIR:t}" == heavy-command ]]; then
    __nexus_heavy_resource_root="${NEXUS_HEAVY_DIR:h:A}"
  fi
  if [[ "${ZDOTDIR:A}" == "$__nexus_heavy_resource_root" || "${ZDOTDIR:A}" == "$__nexus_heavy_resource_root/"* ]]; then
    print -u2 -- '[Nexus] Writable zsh profile overlaps sealed resources.'
    exit 78
  fi
  unset __nexus_heavy_resource_root
  export NEXUS_HEAVY_ORIG_ZDOTDIR="${ZDOTDIR-$HOME}"
  export ZDOTDIR="$__nexus_heavy_zshenv_zdotdir"
  unset __nexus_heavy_zshenv_zdotdir
fi
source "$NEXUS_HEAVY_DIR/shell.zsh"
