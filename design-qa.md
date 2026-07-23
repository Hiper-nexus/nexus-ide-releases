# Design QA — responsive onboarding and workspace header

## Comparison targets

- Source visual truth (copy action): `/var/folders/zg/gtptvdln3l5b56b5qhx6p1rr0000gn/T/codex-clipboard-fcab3185-ec1e-4313-97b3-932925e3ba96.png`
- Rendered implementation (copy action): `/Users/cleofasrocha/Downloads/nexus-ui-qa-onboarding-copy-643.png`
- Source visual truth (workspace name): `/var/folders/zg/gtptvdln3l5b56b5qhx6p1rr0000gn/T/codex-clipboard-797c6811-72c6-46db-b498-8d72a1807efb.png`
- Rendered implementation (workspace name): `/Users/cleofasrocha/Downloads/nexus-ui-qa-workspace-640.png`

## Capture normalization

- Onboarding source: 643 × 485 px, cropped app state supplied by the user.
- Onboarding implementation: 1286 × 970 px at a 643 × 485 CSS viewport, device scale factor 2. It was judged at the same CSS size; the 2× capture preserves native text detail.
- Workspace source: 428 × 163 px, a focused crop of the narrow header supplied by the user.
- Workspace implementation: 1280 × 840 px at the app minimum 640 × 420 CSS viewport, device scale factor 2. The workspace label used `real-mission-workspace-ZqZxWt-workspace` as a visual-only fixture and the focused header region was compared.
- Theme differences are intentional user state, not redesign drift. Both implementations use the existing NexusIDE tokens and assets.

## State and interaction coverage

- Onboarding open, missing-CLI disclosure expanded, install command visible.
- Copy action exposed as a native button; its default label and accessible name were inspected.
- Copy interaction verified in the component test: clipboard receives the exact install command, the label changes to `Copiado`, `aria-label` changes to `Comando copiado`, and the success state is exposed with `data-copied="true"`.
- Workspace open at compact density with a deliberately long active-workspace name.
- Header controls, caret, and adjacent new-workspace action remained visible and separated.

## Full-view comparison evidence

- The onboarding implementation keeps the original hierarchy, tokens, provider logos, command content, hint text, and progress section. The corrected copy action has a reserved 68 px track and no longer falls back to the browser's white default button.
- The workspace implementation keeps the existing compact header composition. The long label is contained by the workspace control and does not paint over its neighboring action.

## Focused-region comparison evidence

- Copy row: source showed pale text on a white default button; implementation shows `Copiar` with the app surface, text, border, hover, focus, and success tokens. The command track can shrink independently without shrinking the button.
- Workspace identity: source showed the workspace text crossing its control boundary; implementation clips the text inside the button, preserves the caret, and leaves a visible gap before the neighboring control.

## Required fidelity surfaces

- Fonts and typography: existing app families, weights, sizes, line heights, and letter spacing are preserved. The copy label moved from an unstyled 10 px browser default to the existing UI font at 11 px/600. The workspace label is a block-level, single-line ellipsis target.
- Spacing and layout rhythm: the install row now uses explicit icon, label, command, and 68 px action tracks. At ≤560 px the command moves to its own row while the action remains visible. Workspace flex descendants now opt into shrinking with `min-width: 0`, `width: 100%`, and contained overflow.
- Colors and visual tokens: only existing `--bg`, `--text`, `--border-strong`, `--accent-soft`, `--accent`, and `--ok` tokens are used. No new palette, gradient, shadow, or radius was introduced.
- Image quality and asset fidelity: existing `ProviderLogo`, `PixelIcon`, and `NexusMark` assets are unchanged; no approximation or replacement asset was introduced.
- Copy and content: install commands and product copy are unchanged. Button casing is normalized to `Copiar`/`Copiado`, with matching accessible state text.

## Findings

- No actionable P0/P1/P2 mismatch remains in the two reported regions.
- Acceptable difference: the implementation capture reports 10 installed CLIs instead of the source's 3 because it reflects the current machine and build state.
- P3 follow-up already applied after the first workspace capture: the label now declares `display: block` and `width: 100%` so the existing `text-overflow: ellipsis` owns the complete available line instead of relying on parent clipping.

## Comparison history

1. Initial source findings:
   - P1: copy action unreadable because `Onboarding.tsx` used `onb-copy` while the design system defined `.onb__copy`.
   - P1: long workspace identity could retain intrinsic flex width and paint across adjacent header controls.
2. Fixes:
   - Matched the copy button to `.onb__copy`, reserved its grid track, added readable default/hover/focus/success states, and added narrow-row reflow.
   - Made workspace wrapper, button, and text container explicitly shrinkable and contained; made the name a full-width ellipsis target.
3. Post-fix evidence:
   - `/Users/cleofasrocha/Downloads/nexus-ui-qa-onboarding-copy-643.png`
   - `/Users/cleofasrocha/Downloads/nexus-ui-qa-workspace-640.png`
   - Reference and implementation pairs were opened together for direct comparison.

## Implementation checklist

- [x] Correct copy-button class contract.
- [x] Preserve action width and contrast.
- [x] Add keyboard focus and copied-state feedback.
- [x] Reflow the install command below 560 px.
- [x] Contain and truncate long workspace names.
- [x] Verify targeted behavior with automated tests.
- [x] Compare rendered app captures against both supplied references.

final result: passed
