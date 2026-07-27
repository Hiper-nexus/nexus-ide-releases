# brace-expansion 5.0.8 compatibility package

This directory temporarily packages the unmodified CommonJS implementation
from `brace-expansion@5.0.8` behind a dual CJS/ESM compatibility boundary.

The security advisory
[`GHSA-mh99-v99m-4gvg`](https://github.com/advisories/GHSA-mh99-v99m-4gvg)
affects every currently published 1.x and 2.x release used by legacy
Electron Forge dependencies. The only published patched version is 5.0.8,
whose CommonJS export is an object with `.expand`; minimatch 3.x and 5.x
instead call the result of `require("brace-expansion")` directly.

`index.cjs` preserves that legacy callable export and also exposes `.expand`
and the two upstream limits. `index.mjs` preserves the 5.x named ESM exports.
Both wrappers delegate to the exact upstream 5.0.8 algorithm; they do not
fork or alter expansion behavior.

Remove this package once compatible upstream maintenance releases have been
published, the advisory range recognizes them, and Electron Forge's complete
maker dependency tree resolves those releases. Upstream work is tracked in:

- <https://github.com/juliangruber/brace-expansion/pull/129>
- <https://github.com/juliangruber/brace-expansion/pull/130>
- <https://github.com/juliangruber/brace-expansion/pull/134>
- <https://github.com/juliangruber/brace-expansion/pull/135>

Source hashes and import metadata are recorded in
`third_party/provenance/brace-expansion-5.0.8-compat.json`.
