# Third-Party Notices

This project includes content derived from third-party work, used under the terms of its original license.

## Platform Design Skills

The `skill/reference/ios.md` and `skill/reference/android.md` platform reference files are distilled from ehmo's `platform-design-skills` (Apple Human Interface Guidelines and Material Design 3 rules), rewritten in Impeccable's voice.

**Original work:** https://github.com/ehmo/platform-design-skills
**Original license:** MIT
**Author:** ehmo

## Impeccable engine binary (not vendored)

The skill is vendored at **4.7.0** (engine `scripts/VERSION` = 0.1.16) from
https://github.com/pbakaus/impeccable, tag `cli-v4.7.0`, Apache-2.0.

The engine binary is deliberately **not** in this tree. `scripts/impeccable`
execs a sibling `scripts/bin/<os>-<arch>/impeccable` **first and without a
version probe**, so a vendored binary that lags `scripts/VERSION` is silently
run against newer skill text — which is exactly what happened while 4.3.1
shipped a 12.7 MB darwin-arm64 Mach-O pinned to engine 0.1.5. Upstream ships
no binary either: the launcher falls through to `~/.impeccable/bin/<version>/`
and fetches the right one for the current platform on first use. Keeping it out
also drops ~17 MB of base64 (mac-only) from the generated manifest.

First use therefore needs network egress once, or the binary preinstalled on
PATH — the launcher prints the exact setup line when it has neither.
