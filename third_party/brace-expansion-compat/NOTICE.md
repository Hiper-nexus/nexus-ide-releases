# brace-expansion 5.0.12 compatibility package

This directory temporarily packages the unmodified CommonJS implementation
from `brace-expansion@5.0.12` behind a dual CJS/ESM compatibility boundary.

brace-expansion 5.0.12 is the first published 5.x release outside every
advisory range known when it was imported:

- [`GHSA-6j4f-fj2g-mc7p`](https://github.com/advisories/GHSA-6j4f-fj2g-mc7p)
  (CVE-2026-102276, fixed in 5.0.10): stack exhaustion through uncontrolled
  recursion in `parseCommaParts` over chained brace groups.
- [`GHSA-qhr7-859c-m2p7`](https://github.com/advisories/GHSA-qhr7-859c-m2p7)
  (CVE-2026-102278, fixed in 5.0.11): stack exhaustion through deeply nested
  brace groups; 5.0.11 adds `EXPANSION_MAX_DEPTH` (1,000 levels, past which
  the remainder is kept literal instead of recursing).
- [`GHSA-q2hr-2g5m-vwhr`](https://github.com/advisories/GHSA-q2hr-2g5m-vwhr)
  (CVE-2026-102277, fixed in 5.0.12): quadratic CPU time in the `{a},b}`
  rewrite; 5.0.12 adds `EXPANSION_MAX_REWRITES` (1,000 restarts).
- Earlier advisories already fixed by the previously packaged versions:
  [`GHSA-rgw5-rvv9-x895`](https://github.com/advisories/GHSA-rgw5-rvv9-x895)
  (5.0.9) and
  [`GHSA-mh99-v99m-4gvg`](https://github.com/advisories/GHSA-mh99-v99m-4gvg)
  (5.0.8).

The 5.x CommonJS export is an object with `.expand`; minimatch 3.x and 5.x
instead call the result of `require("brace-expansion")` directly.

`index.cjs` preserves that legacy callable export and also exposes `.expand`
and the four upstream limits (`EXPANSION_MAX`, `EXPANSION_MAX_LENGTH`,
`EXPANSION_MAX_DEPTH`, `EXPANSION_MAX_REWRITES`). `index.mjs` preserves the
5.x named ESM exports. Both wrappers delegate to the exact upstream 5.0.12
algorithm; they do not fork or alter expansion behavior.

Remove this package once compatible upstream maintenance releases have been
published, the advisory range recognizes them, and Electron Forge's complete
maker dependency tree resolves those releases. (Since 2026-09-14 upstream also
publishes patched 1.1.21, 2.1.7 and 3.0.9 lines; dropping the adapter in favor
of them requires proving every minimatch major in the Forge tree resolves a
patched line without the override.)

Source hashes and import metadata are recorded in
`third_party/provenance/brace-expansion-5.0.12-compat.json`.
