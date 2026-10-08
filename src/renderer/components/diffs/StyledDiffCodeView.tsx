// Adapted from pingdotgg/t3code @ 26285ab80513260d1ff29d2c3fbe18f21990cb62
// Copyright (c) 2026 T3 Tools Inc. — MIT License
// See third_party/licenses/t3code-MIT.txt. Nexus changes: Tailwind classes → .diff-render-surface
// (git-scm.css), shadow-root CSS on Nexus tokens (--font-ui, --accent), theme/themeType and
// color-scheme from the app theme; drops viewerRef/unsafeCSSExtra, the hunk-expansion and
// title-link rules (this viewer never loads full files, so it has neither); translates
// Pierre's English hunk separator to PT-BR in onPostRender.
import {
  CodeView,
  type CodeViewProps,
  type ControlledCodeViewProps,
} from '@pierre/diffs/react';

import {
  DIFF_PREFERRED_HIGHLIGHTER,
  DIFF_SURFACE_THEME_UNSAFE_CSS,
  resolveDiffThemeName,
  translateDiffSeparators,
} from '../../lib/diff-rendering';
import { DiffWorkerPoolProvider, useDiffColorScheme } from './DiffWorkerPoolProvider';

const DIFF_VIEW_UNSAFE_CSS = `${DIFF_SURFACE_THEME_UNSAFE_CSS}
:is(
  [data-line],
  [data-line-annotation],
  [data-merge-conflict],
  [data-merge-conflict-actions],
  [data-no-newline]
)[data-selected-line] {
  --diffs-line-bg: light-dark(
    color-mix(
      in lab,
      var(--code-background) 88%,
      color-mix(in srgb, var(--code-background) 50%, var(--diffs-modified-base))
    ),
    color-mix(
      in lab,
      var(--code-background) 80%,
      color-mix(in srgb, var(--code-background) 70%, var(--diffs-modified-base))
    )
  ) !important;
}

:is([data-gutter-buffer], [data-column-number])[data-selected-line] {
  --diffs-line-bg: light-dark(
    color-mix(
      in lab,
      var(--code-background) 91%,
      color-mix(in srgb, var(--code-background) 35%, var(--diffs-modified-base))
    ),
    color-mix(
      in lab,
      var(--code-background) 85%,
      color-mix(in srgb, var(--code-background) 60%, var(--diffs-modified-base))
    )
  ) !important;
}

[data-indicators="bars"]
  :is([data-column-number], [data-gutter-buffer="annotation"])[data-selected-line] {
  position: relative;
}

[data-indicators="bars"]
  :is([data-column-number], [data-gutter-buffer="annotation"])[data-selected-line]::before {
  position: absolute !important;
  inset-block: 0 !important;
  inset-inline-start: 0 !important;
  display: block !important;
  width: 4px !important;
  min-width: 4px !important;
  max-width: 4px !important;
  height: auto !important;
  padding: 0 !important;
  content: "" !important;
  background-color: var(--diffs-modified-base) !important;
  background-image: none !important;
}

[data-file-info] {
  background-color: var(--code-background) !important;
  border-block-color: transparent !important;
  color: var(--code-foreground) !important;
}

[data-diffs-header] {
  position: sticky !important;
  top: 0;
  z-index: 4;
  background-color: var(--code-background) !important;
  border-bottom-color: transparent !important;
  align-items: center !important;
  font-family: var(--font-ui) !important;
  font-size: 12px !important;
  line-height: 1 !important;
  min-height: 32px !important;
  padding-block: 6px !important;
  padding-inline: 8px 12px !important;
}

[data-diffs-header]:hover {
  /* A native scrollbar gutter cannot be painted by descendants. Use an inset edge cue instead
     of a full-width band that would look accidentally clipped at the gutter. */
  background-color: var(--code-background) !important;
  box-shadow: inset 3px 0 color-mix(in srgb, var(--code-foreground) 24%, transparent);
}

:is([data-separator="line-info"], [data-separator="line-info-basic"]) {
  height: 24px !important;
  margin-block: 0 !important;
  background-color: var(--code-background) !important;
}

:is([data-separator="line-info"], [data-separator="line-info-basic"])
  [data-separator-wrapper] {
  padding-inline: 8px 12px !important;
  background-color: transparent !important;
}

:is([data-separator="line-info"], [data-separator="line-info-basic"])
  [data-separator-content] {
  gap: 8px;
  padding-inline: 0 !important;
  background-color: transparent !important;
  color: color-mix(in srgb, var(--code-foreground) 52%, var(--code-background)) !important;
  font-family: var(--font-ui) !important;
  font-size: 11px !important;
  text-decoration: none !important;
}

:is([data-separator="line-info"], [data-separator="line-info-basic"])
  [data-unmodified-lines] {
  display: flex !important;
  min-width: 0;
  flex: 1 1 auto;
  align-items: center;
  gap: 8px;
}

:is([data-separator="line-info"], [data-separator="line-info-basic"])
  [data-unmodified-lines]::before,
:is([data-separator="line-info"], [data-separator="line-info-basic"])
  [data-unmodified-lines]::after {
  width: auto;
  height: 1px;
  flex: 1 1 auto;
  content: "";
  background-color: color-mix(in srgb, var(--code-background) 92%, var(--code-foreground));
}

[data-diffs-header] [data-header-content] {
  align-items: center !important;
  line-height: 1 !important;
}

/* Pierre clips file names with overflow: hidden for its start ellipsis. A 1em line box cuts off
   descenders. Only the clipped names get room: 16px plus the header's 12px of padding stays
   inside its 32px min-height, which diffHeaderHeight assumes. */
[data-diffs-header] :is([data-title], [data-prev-name]) {
  line-height: 16px !important;
}

[data-diffs-header] [data-metadata] {
  align-items: center !important;
  line-height: 1 !important;
  font-variant-numeric: tabular-nums;
}

[data-diffs-header] [data-additions-count],
[data-diffs-header] [data-deletions-count] {
  font-family: var(--font-mono) !important;
  font-size: 11px !important;
  font-variant-numeric: tabular-nums;
  line-height: 1 !important;
}

[data-diffs-header] [data-change-icon],
[data-diffs-header] [data-rename-icon] {
  display: block;
  flex-shrink: 0;
}

[data-title] {
  font-family: var(--font-ui) !important;
}
`;

export type StyledDiffCodeViewOptions<LAnnotation> = Omit<
  NonNullable<CodeViewProps<LAnnotation, undefined>['options']>,
  | 'unsafeCSS'
  | 'itemMetrics'
  | 'layout'
  | 'theme'
  | 'themeType'
  | 'preferredHighlighter'
  | 'onPostRender'
>;

/** Estável: o CodeView reaplica as opções quando um callback muda de identidade. */
function translateAfterRender(node: HTMLElement): void {
  translateDiffSeparators(node);
}

type StyledDiffCodeViewProps<LAnnotation> = Omit<
  ControlledCodeViewProps<LAnnotation, undefined>,
  'options' | 'style'
> & {
  readonly options?: StyledDiffCodeViewOptions<LAnnotation>;
};

/** The shared CodeView surface: Nexus styling and virtualized geometry stay paired here. */
export function StyledDiffCodeView<LAnnotation = undefined>({
  options,
  className,
  ...props
}: StyledDiffCodeViewProps<LAnnotation>) {
  const colorScheme = useDiffColorScheme();
  return (
    <DiffWorkerPoolProvider>
      <CodeView<LAnnotation>
        {...props}
        // The custom element itself is focusable for keyboard scrolling. Its native outline sits
        // outside the panel clipping boundary; actual controls inside retain their own indicators.
        className={className ? `diff-render-surface ${className}` : 'diff-render-surface'}
        style={{ colorScheme }}
        options={{
          ...options,
          theme: resolveDiffThemeName(colorScheme),
          themeType: colorScheme,
          preferredHighlighter: DIFF_PREFERRED_HIGHLIGHTER,
          unsafeCSS: DIFF_VIEW_UNSAFE_CSS,
          // Separador de trechos em PT-BR ("12 linhas sem alteração").
          onPostRender: translateAfterRender,
          itemMetrics: {
            diffHeaderHeight: 32,
            hunkSeparatorHeight: 24,
            // Pierre uses its general file spacing as a fallback in expanded-file layout paths.
            // Keep it zero alongside the explicit paddingTop or expanding the first file can
            // reintroduce the library's default 8px gap above its header.
            spacing: 0,
            paddingTop: 0,
            // Unlike the gap above, the 8px under a file's last line is painted
            // unconditionally by Pierre's stylesheet (`--diffs-gap-fallback`), so the metric has
            // to count it: at zero every expanded file's virtual height ran 8px short of its
            // rendered height, and the end of the list sat past the reachable scroll range —
            // one clipped file row per expanded file above it.
            paddingBottom: 8,
          },
          layout: { paddingTop: 0, paddingBottom: 0, gap: 0 },
        }}
      />
    </DiffWorkerPoolProvider>
  );
}
