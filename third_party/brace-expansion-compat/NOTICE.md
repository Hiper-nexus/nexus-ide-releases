# brace-expansion 5.0.9 compatibility package

This directory temporarily packages the unmodified CommonJS implementation
from `brace-expansion@5.0.9` behind a dual CJS/ESM compatibility boundary.

The security advisory
[`GHSA-rgw5-rvv9-x895`](https://github.com/advisories/GHSA-rgw5-rvv9-x895)
affects brace-expansion 4.0.0–5.0.8 (DoS via unbounded intermediate arrays,
bypassing the CVE-2026-14257 mitigation). The published patched version is
5.0.9, whose CommonJS export is an object with `.expand`; minimatch 3.x and
5.x instead call the result of `require("brace-expansion")` directly.

`index.cjs` preserves that legacy callable export and also exposes `.expand`
and the two upstream limits. `index.mjs` preserves the 5.x named ESM exports.
Both wrappers delegate to the exact upstream 5.0.9 algorithm; they do not
fork or alter expansion behavior.

Remove this package once compatible upstream maintenance releases have been
published, the advisory range recognizes them, and Electron Forge's complete
maker dependency tree resolves those releases.

Source hashes and import metadata are recorded in
`third_party/provenance/brace-expansion-5.0.9-compat.json`.
