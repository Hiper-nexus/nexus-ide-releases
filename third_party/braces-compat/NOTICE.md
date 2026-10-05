# braces 3.0.3 with nesting-depth guards

This directory packages `braces@3.0.3` (MIT, Copyright Jon Schlinkert) with a
security patch for
[`GHSA-vfj7-8cjw-p6xm`](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm):
deeply nested patterns overflow the stack of the recursive AST walkers. No
patched release exists (the advisory covers every version up to 3.0.3), and the
release gate requires a toolchain `npm audit` of zero.

`index.js`, `lib/constants.js`, `lib/parse.js`, `lib/utils.js` and `LICENSE` are
byte-for-byte copies of the npm tarball. `lib/compile.js` and `lib/expand.js`
apply upstream pull request
[#75](https://github.com/micromatch/braces/pull/75) unchanged: an
`options.maxDepth` limit (default 64) that throws a `RangeError` mentioning
"maximum nesting depth". `lib/stringify.js` gets the same guard, which #75
misses: nested `${` groups still overflowed through it from `expand`.

The package is versioned `3.0.4-nexus.1` so that the advisory range
(`<=3.0.3`) no longer matches the patched code; it is not an upstream release.
The upstream 3.0.3 test suite passes unchanged (764 tests) together with the
#75 depth-guard tests.

Remove this package once braces publishes a patched release and the Electron
Forge glob stack (`fast-glob` → `micromatch`) resolves it, or once Forge no
longer depends on it.

Source hashes and the patch summary are recorded in
`third_party/provenance/braces-3.0.3-depth-guard.json`.
