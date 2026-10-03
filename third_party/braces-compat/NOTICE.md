# braces 3.0.3 security build (3.0.4-nexus.1)

This directory temporarily packages `braces@3.0.3` (MIT, Copyright (c)
2014-present, Jon Schlinkert) with one minimal Nexus security patch. It is a
Nexus build, not the upstream 3.0.4 release; the `-nexus.1` prerelease suffix
keeps that visible in the lockfile and SBOM.

## Why

[`GHSA-vfj7-8cjw-p6xm`](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm)
(CVE-2026-93687, upstream issue
[micromatch/braces#70](https://github.com/micromatch/braces/issues/70))
affects every published braces release (`<= 3.0.3`; 3.0.3 is the latest).
`parse()` caps the input at 10,000 characters but not the nesting depth, and
`compile`, `expand` and `stringify` walk the AST recursively, one stack frame
per nested `{...}` or `(...)` block. A pattern of a few thousand nested
levels, well under the character cap, throws an uncaught
`RangeError: Maximum call stack size exceeded`.

In Nexus, braces is only reached by the build toolchain (`fast-glob` and
`micromatch` under Electron Forge); it is not part of the packaged app.

## The patch

Only `lib/parse.js` changes. Before opening a brace or parenthesis block,
`parse()` now checks the nesting depth that block would have and throws
`SyntaxError: Input nesting depth (N), exceeds max depth (512)` above 512
levels, the same failure mode the parser already uses for over-long input.
Every string pattern goes through `parse()` before any walker runs, and the
end-of-input cleanup only flattens unclosed blocks, so no walker can recurse
deeper than 512 levels on string input. 512 is far above any real glob (a
handful of levels) and far below where the stack runs out (about 3,500
levels on Node 22).

Behavior differences from 3.0.3, all on pathological input only:

- patterns with more than 512 nested blocks now throw `SyntaxError` instead
  of either working (513 to ~3,500 levels) or crashing with `RangeError`;
- this includes more than 512 *unclosed* `{` or `(`, which 3.0.3 treated as
  literal text.

Not covered (unchanged from upstream): ASTs built by the caller and passed
directly to `braces.compile(ast)`, `braces.expand(ast)` or
`braces.stringify(ast)` are trusted input and are walked without a depth
check, as in 3.0.3. No consumer in the Forge tree does that.

All other files are byte-for-byte copies of the `braces@3.0.3` npm tarball
(integrity verified against the registry), including upstream quirks such as
the stray `console.log` in `lib/compile.js`.

## Removal criteria

Remove this package, its `devDependencies`/`overrides` entries and its
provenance file as soon as upstream publishes a braces release that fixes
GHSA-vfj7-8cjw-p6xm and the advisory lists it as patched. Note that `npm
audit` compares prerelease versions too: if the advisory range becomes
`< 3.0.4`, this `3.0.4-nexus.1` build is reported as vulnerable on purpose,
forcing the switch to the official release.

Source hashes, npm integrity, commit/tag pin and the patch summary are
recorded in `third_party/provenance/braces-3.0.3-compat.json`.
