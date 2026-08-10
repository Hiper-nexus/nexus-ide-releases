/**
 * Memory notes are written by the sync pipeline, not by a human: they carry
 * editor scaffolding (an HTML instruction comment), YAML frontmatter, a
 * heading that repeats the note title, and long correlation ids.
 *
 * The panel shows the note to an operator, so it renders the readable part.
 * Nothing is deleted from disk — this is presentation only, and the raw ids
 * stay recoverable through the note's own detail surface.
 */

/** Ids Nexus emits are `label-<uuid>`; keep the label, shorten the uuid. */
const CORRELATION_ID = /\b([a-z][a-z0-9]*-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
/** Bare hex blobs (sha256, receipts) with no dashes. */
const LONG_HEX = /\b[0-9a-f]{24,}\b/gi;
const HTML_COMMENT = /<!--[\s\S]*?-->/g;
const YAML_FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;

function shortenIds(line: string): string {
  return line
    .replace(CORRELATION_ID, (match, label: string | undefined) => {
      const bare = label ? match.slice(label.length) : match;
      return `${label ?? ''}${bare.slice(0, 8)}…`;
    })
    .replace(LONG_HEX, (match) => `${match.slice(0, 8)}…`);
}

export interface ReadableMemoryNote {
  /** Presentation-ready body: no scaffolding, ids shortened. */
  readonly body: string;
  /** True when the original carried scaffolding or ids we compacted. */
  readonly compacted: boolean;
}

export function readableMemoryBody(
  rawBody: string,
  title?: string,
): ReadableMemoryNote {
  const raw = rawBody ?? '';
  let text = raw.replace(YAML_FRONTMATTER, '').replace(HTML_COMMENT, '');

  const normalizedTitle = title?.trim().toLocaleLowerCase('pt-BR');
  const lines = text.split(/\r?\n/);

  // Drop a leading markdown heading that only repeats the card title.
  while (lines.length > 0 && lines[0]!.trim() === '') lines.shift();
  if (normalizedTitle && lines.length > 0) {
    const heading = lines[0]!.trim().replace(/^#+\s*/, '');
    if (heading.toLocaleLowerCase('pt-BR') === normalizedTitle) lines.shift();
  }

  const compactedLines = lines.map(shortenIds);

  // Collapse runs of blank lines so a stripped comment leaves no hole.
  const collapsed: string[] = [];
  for (const line of compactedLines) {
    if (line.trim() === '' && collapsed.at(-1)?.trim() === '') continue;
    collapsed.push(line);
  }
  while (collapsed.length > 0 && collapsed[0]!.trim() === '') collapsed.shift();
  while (collapsed.length > 0 && collapsed.at(-1)!.trim() === '') {
    collapsed.pop();
  }

  const body = collapsed.join('\n');
  return { body, compacted: body !== raw.trim() };
}
