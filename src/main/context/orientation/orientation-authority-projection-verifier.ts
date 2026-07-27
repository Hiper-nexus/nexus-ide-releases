import { isDeepStrictEqual } from 'node:util';
import type { BootstrapDocProposal } from './orientation-bootstrap-types';
import {
  buildCanonicalAuthorityProjection,
  type AuthorityMarkdownBlock,
  type AuthorityProjectionAst,
  type AuthorityProjectionBindings,
} from './orientation-authority-projection-spec';

const VERBATIM_START = '<!-- nexus-promoted-prd:start -->';
const VERBATIM_END = '<!-- nexus-promoted-prd:end -->';

function readUntil(
  content: string,
  offset: number,
  delimiter: string,
): { value: string; nextOffset: number } | null {
  const end = content.indexOf(delimiter, offset);
  return end < 0
    ? null
    : {
        value: content.slice(offset, end),
        nextOffset: end,
      };
}

function parseBlock(
  content: string,
  offset: number,
  expected: AuthorityMarkdownBlock,
): { block: AuthorityMarkdownBlock; nextOffset: number } | null {
  if (expected.kind === 'verbatim-source') {
    const prefix = `${VERBATIM_START}\n`;
    if (!content.startsWith(prefix, offset)) return null;
    const sourceOffset = offset + prefix.length;
    if (!content.startsWith(expected.value, sourceOffset)) return null;
    const suffixOffset = sourceOffset + expected.value.length;
    const suffix = `\n${VERBATIM_END}`;
    if (!content.startsWith(suffix, suffixOffset)) return null;
    return {
      block: Object.freeze({
        kind: 'verbatim-source',
        value: content.slice(sourceOffset, suffixOffset),
      }),
      nextOffset: suffixOffset + suffix.length,
    };
  }
  const parsed = readUntil(content, offset, '\n\n') ??
    (content.endsWith('\n')
      ? {
          value: content.slice(offset, -1),
          nextOffset: content.length - 1,
        }
      : null);
  if (!parsed) return null;
  const lines = parsed.value.split('\n');
  let block: AuthorityMarkdownBlock;
  switch (expected.kind) {
    case 'heading': {
      if (lines.length !== 1) return null;
      const match = /^(#{1,2}) ([^\n]+)$/.exec(lines[0]!);
      if (!match) return null;
      block = Object.freeze({
        kind: 'heading',
        level: match[1]!.length as 1 | 2,
        text: match[2]!,
      });
      break;
    }
    case 'blockquote':
      if (!lines.every((line) => line.startsWith('> '))) return null;
      block = Object.freeze({
        kind: 'blockquote',
        lines: Object.freeze(lines.map((line) => line.slice(2))),
      });
      break;
    case 'bullet-list':
      if (!lines.every((line) => line.startsWith('- '))) return null;
      block = Object.freeze({
        kind: 'bullet-list',
        items: Object.freeze(lines.map((line) => line.slice(2))),
      });
      break;
    case 'json-code':
      if (
        lines[0] !== '```json' ||
        lines.at(-1) !== '```' ||
        lines.length < 3
      ) {
        return null;
      }
      block = Object.freeze({
        kind: 'json-code',
        value: lines.slice(1, -1).join('\n'),
      });
      break;
  }
  return { block, nextOffset: parsed.nextOffset };
}

function parseCanonicalMarkdown(
  content: string,
  canonical: Extract<AuthorityProjectionAst, { format: 'markdown' }>,
): Extract<AuthorityProjectionAst, { format: 'markdown' }> | null {
  if (!content.endsWith('\n') || content.endsWith('\n\n')) return null;
  const blocks: AuthorityMarkdownBlock[] = [];
  let offset = 0;
  for (const [index, expected] of canonical.blocks.entries()) {
    if (index > 0) {
      if (!content.startsWith('\n\n', offset)) return null;
      offset += 2;
    }
    const parsed = parseBlock(content, offset, expected);
    if (!parsed) return null;
    blocks.push(parsed.block);
    offset = parsed.nextOffset;
  }
  if (offset !== content.length - 1) return null;
  const allowedSections = Object.freeze(
    blocks.flatMap((block) =>
      block.kind === 'heading' && block.level === 2 ? [block.text] : [],
    ),
  );
  return Object.freeze({
    format: 'markdown',
    targetPath: canonical.targetPath,
    rationale: canonical.rationale,
    allowedSections,
    blocks: Object.freeze(blocks),
  });
}

function parseCanonicalJson(
  content: string,
  canonical: Extract<AuthorityProjectionAst, { format: 'json' }>,
): Extract<AuthorityProjectionAst, { format: 'json' }> | null {
  let document: unknown;
  try {
    document = JSON.parse(content);
  } catch {
    return null;
  }
  if (`${JSON.stringify(document, null, 2)}\n` !== content) return null;
  return Object.freeze({
    format: 'json',
    targetPath: canonical.targetPath,
    rationale: canonical.rationale,
    document: document as Extract<
      AuthorityProjectionAst,
      { format: 'json' }
    >['document'],
  });
}

/**
 * Independent mechanical review. It parses the durable proposal and compares
 * its canonical AST; it never calls the writer's renderer.
 */
export function verifyAuthorityBootstrapProposal(
  proposal: BootstrapDocProposal,
  bindings: AuthorityProjectionBindings,
): boolean {
  if (
    proposal.sources.length !== 1 ||
    proposal.sources[0]?.type !== 'file' ||
    proposal.sources[0].locator !== bindings.sourceFile ||
    proposal.sources[0].sourceHash !== bindings.sourceHash
  ) {
    return false;
  }
  const canonical = buildCanonicalAuthorityProjection(
    proposal.targetPath,
    bindings,
  );
  if (!canonical || proposal.rationale !== canonical.rationale) return false;
  const parsed =
    canonical.format === 'markdown'
      ? parseCanonicalMarkdown(proposal.content, canonical)
      : parseCanonicalJson(proposal.content, canonical);
  return Boolean(parsed && isDeepStrictEqual(parsed, canonical));
}
