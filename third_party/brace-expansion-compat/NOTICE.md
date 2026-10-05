# brace-expansion 5.0.12 compatibility package

This directory temporarily packages the unmodified CommonJS implementation
from `brace-expansion@5.0.12` behind a dual CJS/ESM compatibility boundary.

The security advisory
[`GHSA-rgw5-rvv9-x895`](https://github.com/advisories/GHSA-rgw5-rvv9-x895)
affects brace-expansion 4.0.0–5.0.8 (DoS via unbounded intermediate arrays,
bypassing the CVE-2026-14257 mitigation).
[`GHSA-qhr7-859c-m2p7`](https://github.com/advisories/GHSA-qhr7-859c-m2p7)
(stack exhaustion on nested groups, fixed in 5.0.11) and
[`GHSA-q2hr-2g5m-vwhr`](https://github.com/advisories/GHSA-q2hr-2g5m-vwhr)
(quadratic `{a},b}` rewrite, fixed in 5.0.12) followed. The published patched
version is 5.0.12, whose CommonJS export is an object with `.expand`; minimatch 3.x and
5.x instead call the result of `require("brace-expansion")` directly.

`index.cjs` preserves that legacy callable export and also exposes `.expand`
and the four upstream limits. `index.mjs` preserves the 5.x named ESM exports.
Both wrappers delegate to the exact upstream 5.0.12 algorithm; they do not
fork or alter expansion behavior.

Remove this package once compatible upstream maintenance releases have been
published, the advisory range recognizes them, and Electron Forge's complete
maker dependency tree resolves those releases.

Source hashes and import metadata are recorded in
`third_party/provenance/brace-expansion-5.0.12-compat.json`.
