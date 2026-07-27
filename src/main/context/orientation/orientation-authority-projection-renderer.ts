import type { BootstrapDocProposal } from './orientation-bootstrap-types';
import {
  buildCanonicalAuthorityProjection,
  type AuthorityMarkdownBlock,
  type AuthorityProjectionAst,
  type AuthorityProjectionBindings,
} from './orientation-authority-projection-spec';

const VERBATIM_START = '<!-- nexus-promoted-prd:start -->';
const VERBATIM_END = '<!-- nexus-promoted-prd:end -->';

function renderMarkdownBlock(block: AuthorityMarkdownBlock): string {
  switch (block.kind) {
    case 'heading':
      return `${'#'.repeat(block.level)} ${block.text}`;
    case 'blockquote':
      return block.lines.map((line) => `> ${line}`).join('\n');
    case 'bullet-list':
      return block.items.map((item) => `- ${item}`).join('\n');
    case 'json-code':
      return `\`\`\`json\n${block.value}\n\`\`\``;
    case 'verbatim-source':
      return `${VERBATIM_START}\n${block.value}\n${VERBATIM_END}`;
  }
}

function renderProjection(ast: AuthorityProjectionAst): string {
  return ast.format === 'json'
    ? `${JSON.stringify(ast.document, null, 2)}\n`
    : `${ast.blocks.map(renderMarkdownBlock).join('\n\n')}\n`;
}

export function renderAuthorityBootstrapProposal(
  targetPath: string,
  bindings: AuthorityProjectionBindings,
  sources: BootstrapDocProposal['sources'],
): BootstrapDocProposal | null {
  if (
    sources.length !== 1 ||
    sources[0]?.type !== 'file' ||
    sources[0].locator !== bindings.sourceFile ||
    sources[0].sourceHash !== bindings.sourceHash
  ) {
    return null;
  }
  const projection = buildCanonicalAuthorityProjection(targetPath, bindings);
  return projection
    ? Object.freeze({
        targetPath,
        content: renderProjection(projection),
        sources,
        rationale: projection.rationale,
      })
    : null;
}
