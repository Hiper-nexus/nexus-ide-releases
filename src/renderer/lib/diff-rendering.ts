// Adapted from pingdotgg/t3code @ 26285ab80513260d1ff29d2c3fbe18f21990cb62
// Copyright (c) 2026 T3 Tools Inc. — MIT License
// See third_party/licenses/t3code-MIT.txt. Nexus changes: apps/web/src/lib/diffRendering.ts
// (parser, cache key, compactPartialHunkOffsets, content version, surface CSS on Nexus tokens)
// plus the diff-range helpers of apps/web/src/reviewCommentContext.ts; drops the whitespace
// filter and Effect Schema; adds raw fallback for binary/placeholder/truncated patches.
import {
  parsePatchFiles,
  type AnnotationSide,
  type FileDiffMetadata,
  type SelectedLineRange,
  type SelectionSide,
} from '@pierre/diffs';

const DIFF_THEME_NAMES = {
  light: 'pierre-light',
  dark: 'pierre-dark',
} as const;

export type DiffColorScheme = 'light' | 'dark';
export type DiffThemeName = (typeof DIFF_THEME_NAMES)[keyof typeof DIFF_THEME_NAMES];

export function resolveDiffThemeName(scheme: DiffColorScheme): DiffThemeName {
  return scheme === 'light' ? DIFF_THEME_NAMES.light : DIFF_THEME_NAMES.dark;
}

/** O tema claro do Nexus é o único que pede a paleta clara do realce. */
export function readDiffColorScheme(root: HTMLElement = document.documentElement): DiffColorScheme {
  return root.dataset.theme === 'nexus-light' ? 'light' : 'dark';
}

/**
 * Motor JS do Shiki: o mesmo realce sem carregar WASM no worker. O upstream usa
 * `shiki-wasm`; aqui o CSP permite os dois, e o JS evita um asset a mais no pacote.
 */
export const DIFF_PREFERRED_HIGHLIGHTER = 'shiki-js' as const;

const FNV_OFFSET_BASIS_32 = 0x811c9dc5;
const FNV_PRIME_32 = 0x01000193;
const SECONDARY_HASH_SEED = 0x9e3779b9;
const SECONDARY_HASH_MULTIPLIER = 0x85ebca6b;

export function fnv1a32(
  input: string,
  seed = FNV_OFFSET_BASIS_32,
  multiplier = FNV_PRIME_32,
): number {
  let hash = seed >>> 0;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, multiplier) >>> 0;
  }
  return hash >>> 0;
}

export function buildPatchCacheKey(patch: string, scope = 'git-panel'): string {
  const normalizedPatch = patch.trim();
  const primary = fnv1a32(normalizedPatch, FNV_OFFSET_BASIS_32, FNV_PRIME_32).toString(36);
  const secondary = fnv1a32(
    normalizedPatch,
    SECONDARY_HASH_SEED,
    SECONDARY_HASH_MULTIPLIER,
  ).toString(36);
  return `${scope}:${normalizedPatch.length}:${primary}:${secondary}`;
}

export type RenderablePatch =
  | {
      kind: 'files';
      files: FileDiffMetadata[];
      /** O main cortou o diff (GIT_SCM_MAX_DIFF_CHARS): o fim do último hunk falta. */
      truncated: boolean;
    }
  | {
      kind: 'raw';
      text: string;
      /** Vazio quando o texto é um aviso do store, não um diff. */
      reason: string;
    };

interface RenderablePatchOptions {
  /**
   * Pierre's partial-patch parser keeps hunk render starts in source-file
   * coordinates. Its virtualizer iterates partial patches as compact rows, so
   * review diffs need compact render starts while retaining collapsedBefore
   * for the "N unmodified lines" separator.
   */
  compactPartialHunkOffsets?: boolean;
}

function compactPartialHunkOffsets(file: FileDiffMetadata): FileDiffMetadata {
  if (!file.isPartial) return file;

  let splitLineStart = 0;
  let unifiedLineStart = 0;
  const hunks = file.hunks.map((hunk) => {
    const compactHunk = {
      ...hunk,
      splitLineStart,
      unifiedLineStart,
    };
    splitLineStart += hunk.splitLineCount;
    unifiedLineStart += hunk.unifiedLineCount;
    return compactHunk;
  });

  return {
    ...file,
    hunks,
    splitLineCount: splitLineStart,
    unifiedLineCount: unifiedLineStart,
    ...(file.cacheKey ? { cacheKey: `${file.cacheKey}:compact-partial` } : {}),
  };
}

/** Marca que `truncateDiff` (shared/git-scm.ts) cola no fim de um diff grande. */
const TRUNCATION_MARKER = '… [diff truncado para proteção da UI]';
const BINARY_PATCH = /^(?:Binary files .* differ|GIT binary patch)$/m;
const PATCH_SHAPE = /^(?:diff --git |@@ |--- |\+\+\+ |Binary files )/m;

/**
 * Sem `diff --git`, o parser guarda `a/`/`b/` no nome e lê a mudança como
 * renome. Um cabeçalho sintético a partir de `---`/`+++` devolve o caminho real.
 */
function ensureGitHeader(patch: string): string {
  if (/^diff --git /m.test(patch)) return patch;
  const oldPath = /^--- (?:a\/(.+)|\/dev\/null)$/m.exec(patch);
  const newPath = /^\+\+\+ (?:b\/(.+)|\/dev\/null)$/m.exec(patch);
  const path = newPath?.[1] ?? oldPath?.[1];
  if (!oldPath || !newPath || !path) return patch;
  return `diff --git a/${oldPath[1] ?? path} b/${newPath[1] ?? path}\n${patch}`;
}

export function getRenderablePatch(
  patch: string | undefined,
  cacheScope = 'git-panel',
  options: RenderablePatchOptions = {},
): RenderablePatch | null {
  if (!patch) return null;
  let normalizedPatch = patch.trim();
  if (normalizedPatch.length === 0) return null;

  if (!PATCH_SHAPE.test(normalizedPatch)) {
    return { kind: 'raw', text: normalizedPatch, reason: '' };
  }
  const truncated = normalizedPatch.endsWith(TRUNCATION_MARKER);
  if (truncated) {
    normalizedPatch = normalizedPatch.slice(0, -TRUNCATION_MARKER.length).trimEnd();
  }

  try {
    const parsedPatches = parsePatchFiles(
      ensureGitHeader(normalizedPatch),
      buildPatchCacheKey(normalizedPatch, cacheScope),
    );
    const sourceFiles = parsedPatches.flatMap((parsedPatch) => parsedPatch.files);
    if (sourceFiles.length > 0 && sourceFiles.every((file) => file.hunks.length === 0)) {
      return {
        kind: 'raw',
        text: normalizedPatch,
        reason: BINARY_PATCH.test(normalizedPatch)
          ? 'Arquivo binário — não há linhas de texto para mostrar.'
          : 'Sem linhas de texto alteradas (mudança de modo ou renome).',
      };
    }
    const files = sourceFiles.map((file) =>
      options.compactPartialHunkOffsets ? compactPartialHunkOffsets(file) : file,
    );
    if (files.length > 0) {
      return { kind: 'files', files, truncated };
    }

    return {
      kind: 'raw',
      text: normalizedPatch,
      reason: 'Formato de diff não reconhecido — mostrando o texto bruto.',
    };
  } catch {
    return {
      kind: 'raw',
      text: normalizedPatch,
      reason: 'Não foi possível interpretar o diff — mostrando o texto bruto.',
    };
  }
}

/**
 * The file's own name. Git quotes and escapes a name holding a tab, a newline, a quote or a
 * backslash, and the parser decodes it, so this is the name the host knows the file by.
 */
export function resolveFileDiffPath(fileDiff: FileDiffMetadata): string {
  return fileDiff.name ?? fileDiff.prevName ?? '';
}

function hashFileDiffPart(hash: number, value: string | number | boolean | undefined): number {
  const serialized = value === undefined ? 'undefined' : String(value);
  const withLength = fnv1a32(`${typeof value}:${serialized.length}:`, hash);
  return fnv1a32(serialized, withLength);
}

/**
 * Content-only version for CodeView reconciliation. Pierre's cache key includes
 * the whole patch, so using it here would repaint every file when one changes.
 */
export function buildFileDiffContentVersion(fileDiff: FileDiffMetadata): number {
  let hash = FNV_OFFSET_BASIS_32;
  const append = (value: string | number | boolean | undefined) => {
    hash = hashFileDiffPart(hash, value);
  };

  append(fileDiff.name);
  append(fileDiff.prevName);
  append(fileDiff.lang);
  append(fileDiff.newObjectId);
  append(fileDiff.prevObjectId);
  append(fileDiff.mode);
  append(fileDiff.prevMode);
  append(fileDiff.type);
  append(fileDiff.isPartial);
  append(fileDiff.splitLineCount);
  append(fileDiff.unifiedLineCount);

  for (const line of fileDiff.additionLines) append(line);
  for (const line of fileDiff.deletionLines) append(line);
  for (const hunk of fileDiff.hunks) {
    append(hunk.collapsedBefore);
    append(hunk.additionStart);
    append(hunk.additionCount);
    append(hunk.additionLines);
    append(hunk.additionLineIndex);
    append(hunk.deletionStart);
    append(hunk.deletionCount);
    append(hunk.deletionLines);
    append(hunk.deletionLineIndex);
    append(hunk.hunkContext);
    append(hunk.hunkSpecs);
    append(hunk.splitLineStart);
    append(hunk.splitLineCount);
    append(hunk.unifiedLineStart);
    append(hunk.unifiedLineCount);
    append(hunk.noEOFCRAdditions);
    append(hunk.noEOFCRDeletions);
    for (const content of hunk.hunkContent) {
      append(content.type);
      append(content.additionLineIndex);
      append(content.deletionLineIndex);
      append(content.type === 'change' ? content.additions : content.lines);
      append(content.type === 'change' ? content.deletions : undefined);
    }
  }

  return hash;
}

// --- Intervalos de comentário (de reviewCommentContext.ts) -------------------

interface DiffReviewLine {
  change: 'context' | 'add' | 'delete';
  oldLineNumber: number | null;
  newLineNumber: number | null;
  content: string;
}

function stripTrailingNewline(value: string): string {
  return value.endsWith('\n') ? value.slice(0, -1) : value;
}

function buildDiffReviewLines(
  fileDiff: FileDiffMetadata,
  includeExpandedContext: boolean,
  slice?: { readonly startIndex: number; readonly endIndex: number },
): ReadonlyArray<DiffReviewLine> {
  const rows: DiffReviewLine[] = [];
  let rowIndex = 0;
  let oldContextStart = 1;
  let newContextStart = 1;
  const pushRow = (row: DiffReviewLine) => {
    if (!slice || (rowIndex >= slice.startIndex && rowIndex <= slice.endIndex)) {
      rows.push(row);
    }
    rowIndex += 1;
  };
  const pushContextGap = (oldStart: number, newStart: number, lineCount: number) => {
    const count = Math.max(0, lineCount);
    const firstOffset = slice ? Math.max(0, slice.startIndex - rowIndex) : 0;
    const lastOffset = slice ? Math.min(count - 1, slice.endIndex - rowIndex) : count - 1;
    for (let offset = firstOffset; offset <= lastOffset; offset += 1) {
      rows.push({
        change: 'context',
        oldLineNumber: oldStart + offset,
        newLineNumber: newStart + offset,
        content: stripTrailingNewline(fileDiff.additionLines[newStart + offset - 1] ?? ''),
      });
    }
    rowIndex += count;
  };

  for (const hunk of fileDiff.hunks) {
    if (includeExpandedContext) {
      const oldHunkStart = hunk.deletionStart + (hunk.deletionCount === 0 ? 1 : 0);
      const newHunkStart = hunk.additionStart + (hunk.additionCount === 0 ? 1 : 0);
      const contextLines = Math.min(oldHunkStart - oldContextStart, newHunkStart - newContextStart);
      pushContextGap(oldContextStart, newContextStart, contextLines);
    }

    let oldLineNumber = hunk.deletionStart;
    let newLineNumber = hunk.additionStart;
    let deletionLineIndex = hunk.deletionLineIndex;
    let additionLineIndex = hunk.additionLineIndex;

    for (const segment of hunk.hunkContent) {
      if (segment.type === 'context') {
        for (let index = 0; index < segment.lines; index += 1) {
          pushRow({
            change: 'context',
            oldLineNumber,
            newLineNumber,
            content: stripTrailingNewline(
              fileDiff.additionLines[additionLineIndex] ??
                fileDiff.deletionLines[deletionLineIndex] ??
                '',
            ),
          });
          oldLineNumber += 1;
          newLineNumber += 1;
          deletionLineIndex += 1;
          additionLineIndex += 1;
        }
        continue;
      }

      for (let index = 0; index < segment.deletions; index += 1) {
        pushRow({
          change: 'delete',
          oldLineNumber,
          newLineNumber: null,
          content: stripTrailingNewline(fileDiff.deletionLines[deletionLineIndex] ?? ''),
        });
        oldLineNumber += 1;
        deletionLineIndex += 1;
      }

      for (let index = 0; index < segment.additions; index += 1) {
        pushRow({
          change: 'add',
          oldLineNumber: null,
          newLineNumber,
          content: stripTrailingNewline(fileDiff.additionLines[additionLineIndex] ?? ''),
        });
        newLineNumber += 1;
        additionLineIndex += 1;
      }
    }

    oldContextStart = hunk.deletionStart + hunk.deletionCount;
    newContextStart = hunk.additionStart + hunk.additionCount;
    if (hunk.deletionCount === 0) oldContextStart += 1;
    if (hunk.additionCount === 0) newContextStart += 1;
  }

  if (includeExpandedContext) {
    const trailingLines = Math.min(
      fileDiff.deletionLines.length - oldContextStart + 1,
      fileDiff.additionLines.length - newContextStart + 1,
    );
    pushContextGap(oldContextStart, newContextStart, trailingLines);
  }

  return rows;
}

/** Deleção mira o arquivo antigo; adição e contexto, o novo — como `diffLineCommentTarget`. */
function getDiffReviewSelectionPoint(
  line: DiffReviewLine,
): { lineNumber: number; side: SelectionSide } | null {
  if (line.change === 'delete' && line.oldLineNumber !== null) {
    return { lineNumber: line.oldLineNumber, side: 'deletions' };
  }
  if (line.newLineNumber !== null) {
    return { lineNumber: line.newLineNumber, side: 'additions' };
  }
  if (line.oldLineNumber !== null) {
    return { lineNumber: line.oldLineNumber, side: 'deletions' };
  }
  return null;
}

function findDiffReviewLineIndex(
  fileDiff: FileDiffMetadata,
  lineNumber: number,
  side: SelectionSide | undefined,
  includeExpandedContext = !fileDiff.isPartial,
): number {
  const findOnSide = (selectedSide: 'left' | 'right') => {
    let rowIndex = 0;
    let oldContextStart = 1;
    let newContextStart = 1;
    const findContextIndex = (oldStart: number, newStart: number, lineCount: number) => {
      const count = Math.max(0, lineCount);
      const selectedStart = selectedSide === 'left' ? oldStart : newStart;
      const offset = lineNumber - selectedStart;
      return offset >= 0 && offset < count ? rowIndex + offset : -1;
    };

    for (const hunk of fileDiff.hunks) {
      if (includeExpandedContext) {
        const oldContextEnd = hunk.deletionStart + (hunk.deletionCount === 0 ? 1 : 0);
        const newContextEnd = hunk.additionStart + (hunk.additionCount === 0 ? 1 : 0);
        const contextLines = Math.min(
          oldContextEnd - oldContextStart,
          newContextEnd - newContextStart,
        );
        const contextIndex = findContextIndex(oldContextStart, newContextStart, contextLines);
        if (contextIndex >= 0) return contextIndex;
        rowIndex += Math.max(0, contextLines);
      }

      let oldLineNumber = hunk.deletionStart;
      let newLineNumber = hunk.additionStart;
      for (const segment of hunk.hunkContent) {
        if (segment.type === 'context') {
          const contextIndex = findContextIndex(oldLineNumber, newLineNumber, segment.lines);
          if (contextIndex >= 0) return contextIndex;
          rowIndex += segment.lines;
          oldLineNumber += segment.lines;
          newLineNumber += segment.lines;
          continue;
        }

        if (
          selectedSide === 'left' &&
          lineNumber >= oldLineNumber &&
          lineNumber < oldLineNumber + segment.deletions
        ) {
          return rowIndex + lineNumber - oldLineNumber;
        }
        rowIndex += segment.deletions;
        oldLineNumber += segment.deletions;

        if (
          selectedSide === 'right' &&
          lineNumber >= newLineNumber &&
          lineNumber < newLineNumber + segment.additions
        ) {
          return rowIndex + lineNumber - newLineNumber;
        }
        rowIndex += segment.additions;
        newLineNumber += segment.additions;
      }

      oldContextStart = hunk.deletionStart + hunk.deletionCount;
      newContextStart = hunk.additionStart + hunk.additionCount;
      if (hunk.deletionCount === 0) oldContextStart += 1;
      if (hunk.additionCount === 0) newContextStart += 1;
    }

    if (!includeExpandedContext) return -1;
    const trailingLines = Math.min(
      fileDiff.deletionLines.length - oldContextStart + 1,
      fileDiff.additionLines.length - newContextStart + 1,
    );
    return findContextIndex(oldContextStart, newContextStart, trailingLines);
  };

  const selectedSide = side === 'deletions' ? 'left' : 'right';
  const preferredIndex = findOnSide(selectedSide);
  return preferredIndex >= 0
    ? preferredIndex
    : findOnSide(selectedSide === 'left' ? 'right' : 'left');
}

function getDiffChangeMarker(change: DiffReviewLine['change']): string {
  if (change === 'add') return '+';
  if (change === 'delete') return '-';
  return ' ';
}

function formatDiffReviewRangeLabel(lines: ReadonlyArray<DiffReviewLine>): string {
  const firstLine = lines[0];
  const lastLine = lines.at(-1);
  if (!firstLine || !lastLine) return 'linha';
  const firstNumber = firstLine.newLineNumber ?? firstLine.oldLineNumber;
  const lastNumber = lastLine.newLineNumber ?? lastLine.oldLineNumber;
  if (firstNumber === null || lastNumber === null) {
    return lines.length === 1 ? 'linha' : `${lines.length} linhas`;
  }

  const firstMarker = getDiffChangeMarker(firstLine.change).trim();
  const marker =
    firstMarker.length > 0 && lines.every((line) => line.change === firstLine.change)
      ? firstMarker
      : '';
  return firstNumber === lastNumber
    ? `${marker}${firstNumber}`
    : `${marker}${firstNumber} a ${marker}${lastNumber}`;
}

/** Onde um comentário aparece no viewer e o que ele leva ao agente. */
export interface DiffSelectionTarget {
  /** Primeira linha do intervalo: a do arquivo novo, ou a do antigo numa deleção. */
  line: number;
  /** Ponto de ancoragem da anotação no viewer: o fim da seleção, no lado dela. */
  anchor: { side: AnnotationSide; lineNumber: number };
  rangeLabel: string;
  /** Linhas selecionadas, sem o marcador +/-/espaço. */
  snippet: string;
}

/** Resolve a seleção do viewer (linhas + lado) para o comentário do Nexus. */
export function diffSelectionTarget(
  fileDiff: FileDiffMetadata,
  range: SelectedLineRange,
): DiffSelectionTarget | null {
  const includeExpandedContext = !fileDiff.isPartial;
  const startIndex = findDiffReviewLineIndex(
    fileDiff,
    range.start,
    range.side,
    includeExpandedContext,
  );
  const endIndex = findDiffReviewLineIndex(
    fileDiff,
    range.end,
    range.endSide ?? range.side,
    includeExpandedContext,
  );
  if (startIndex < 0 || endIndex < 0) return null;

  const selectedLines = buildDiffReviewLines(fileDiff, includeExpandedContext, {
    startIndex: Math.min(startIndex, endIndex),
    endIndex: Math.max(startIndex, endIndex),
  });
  const first = selectedLines[0];
  const start = first ? getDiffReviewSelectionPoint(first) : null;
  if (!start) return null;
  return {
    line: start.lineNumber,
    anchor: {
      side: (range.endSide ?? range.side) === 'deletions' ? 'deletions' : 'additions',
      lineNumber: range.end,
    },
    rangeLabel: formatDiffReviewRangeLabel(selectedLines),
    snippet: selectedLines.map((line) => line.content).join('\n'),
  };
}

/**
 * Maps every diff surface the @pierre/diffs renderer paints onto Nexus tokens
 * (DESIGN.md: --surface-0, --text, --diff-addition, --diff-deletion, --font-ui,
 * --font-mono). `--code-background`/`--code-foreground` are bridged on the host
 * (`.diff-render-surface`, git-scm.css); custom properties cross the shadow root.
 */
export const DIFF_SURFACE_THEME_UNSAFE_CSS = `
[data-diffs-header],
[data-diff],
[data-file],
[data-error-wrapper],
[data-virtualizer-buffer] {
  --diffs-header-font-family: var(--font-ui) !important;
  --diffs-font-family: var(--font-mono) !important;
  --diffs-bg: var(--code-background) !important;
  --diffs-light-bg: var(--code-background) !important;
  --diffs-dark-bg: var(--code-background) !important;
  --diffs-token-light-bg: transparent;
  --diffs-token-dark-bg: transparent;

  /* Gutter, context, and row tints all derive from the code surface the diff
     body sits on — mixing from the canvas leaves the gutter looking unthemed
     when a palette separates the two. */
  --diffs-bg-context-override: color-mix(in srgb, var(--code-background) 97%, var(--code-foreground));
  --diffs-bg-hover-override: color-mix(in srgb, var(--code-background) 94%, var(--code-foreground));
  --diffs-bg-separator-override: color-mix(
    in srgb,
    var(--code-background) 95%,
    var(--code-foreground)
  );
  --diffs-bg-buffer-override: color-mix(in srgb, var(--code-background) 90%, var(--code-foreground));

  --diffs-bg-addition-override: light-dark(
    color-mix(in srgb, var(--code-background) 50%, var(--diff-addition)),
    color-mix(in srgb, var(--code-background) 70%, var(--diff-addition))
  );
  --diffs-bg-addition-number-override: light-dark(
    color-mix(in srgb, var(--code-background) 35%, var(--diff-addition)),
    color-mix(in srgb, var(--code-background) 60%, var(--diff-addition))
  );
  --diffs-bg-addition-hover-override: color-mix(in srgb, var(--code-background) 85%, var(--diff-addition));
  --diffs-bg-addition-emphasis-override: color-mix(
    in srgb,
    var(--code-background) 80%,
    var(--diff-addition)
  );

  --diffs-bg-deletion-override: light-dark(
    color-mix(in srgb, var(--code-background) 50%, var(--diff-deletion)),
    color-mix(in srgb, var(--code-background) 70%, var(--diff-deletion))
  );
  --diffs-bg-deletion-number-override: light-dark(
    color-mix(in srgb, var(--code-background) 35%, var(--diff-deletion)),
    color-mix(in srgb, var(--code-background) 60%, var(--diff-deletion))
  );
  --diffs-bg-deletion-hover-override: color-mix(
    in srgb,
    var(--code-background) 85%,
    var(--diff-deletion)
  );
  --diffs-bg-deletion-emphasis-override: color-mix(
    in srgb,
    var(--code-background) 80%,
    var(--diff-deletion)
  );

  background-color: var(--diffs-bg) !important;
  color: var(--code-foreground) !important;
}
`;
