export type GitDiffViewKind = 'hunk' | 'add' | 'del' | 'ctx' | 'meta';

export type GitDiffViewLine = {
  kind: GitDiffViewKind;
  text: string;
  /** 1-based line in the new file, when known. */
  newLine?: number;
  /** 1-based line in the old file, when known. */
  oldLine?: number;
};

/**
 * Parse unified diff into clickable rows. Hunk headers reset the counters.
 * Lines without a file line number (meta/hunk) are not comment targets.
 */
export function parseDiffViewLines(diff: string): GitDiffViewLine[] {
  const rows: GitDiffViewLine[] = [];
  let oldLine = 0;
  let newLine = 0;
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('@@')) {
      const m = raw.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)/);
      oldLine = m ? Number(m[1]) : oldLine;
      newLine = m ? Number(m[2]) : newLine;
      rows.push({ kind: 'hunk', text: raw });
      continue;
    }
    if (
      raw.startsWith('diff ') ||
      raw.startsWith('index ') ||
      raw.startsWith('--- ') ||
      raw.startsWith('+++ ') ||
      raw.startsWith('new file') ||
      raw.startsWith('deleted file')
    ) {
      rows.push({ kind: 'meta', text: raw });
      continue;
    }
    if (raw.startsWith('+')) {
      rows.push({ kind: 'add', text: raw, newLine });
      newLine += 1;
      continue;
    }
    if (raw.startsWith('-')) {
      rows.push({ kind: 'del', text: raw, oldLine });
      oldLine += 1;
      continue;
    }
    if (raw.startsWith('\\')) {
      rows.push({ kind: 'meta', text: raw });
      continue;
    }
    const lineNo = newLine || undefined;
    rows.push({
      kind: 'ctx',
      text: raw,
      ...(lineNo ? { newLine, oldLine } : {}),
    });
    if (lineNo) {
      oldLine += 1;
      newLine += 1;
    }
  }
  return rows;
}

export function diffLineCommentTarget(
  line: GitDiffViewLine,
): { line: number; snippet: string } | null {
  const n = line.newLine ?? line.oldLine;
  if (!n || line.kind === 'hunk' || line.kind === 'meta') return null;
  return { line: n, snippet: line.text.replace(/^[-+ ]/, '') };
}
