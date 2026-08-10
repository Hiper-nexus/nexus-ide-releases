# Nexus appdmg security fork

This package is derived from `appdmg` 0.6.6 by Linus Unnebäck under the MIT
license in `LICENSE`.

Nexus keeps the upstream DMG pipeline and API intact, but removes the vulnerable
`image-size` dependency. Optional DMG background dimensions are read through
macOS `/usr/bin/sips`; output is parsed strictly and dimensions outside
1–100,000 pixels are rejected. Nexus release DMGs do not currently configure a
background image, so this path is a compatibility fallback rather than part of
the normal release build.

Delete this fork when Electron Forge's DMG dependency chain ships an upstream
version without the affected `image-size` parser.
