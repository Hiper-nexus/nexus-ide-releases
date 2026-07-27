import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  GUIDED_GREENFIELD_BRIEF_PATH,
  renderGuidedGreenfieldBrief,
} from '../../runtime/guided-greenfield-brief';
import { renderAuthorityBootstrapProposal } from './orientation-authority-projection-renderer';
import type { AuthorityProjectionBindings } from './orientation-authority-projection-spec';
import { verifyAuthorityBootstrapProposal } from './orientation-authority-projection-verifier';

function sourceRef(bindings: AuthorityProjectionBindings) {
  return Object.freeze([
    Object.freeze({
      type: 'file' as const,
      locator: bindings.sourceFile,
      sourceHash: bindings.sourceHash,
    }),
  ]);
}

describe('authority bootstrap projection boundary', () => {
  it('accepts exact canonical greenfield output and rejects renderer drift or injected prose', () => {
    const sourceContent = renderGuidedGreenfieldBrief({
      goal: 'Entregar o produto aprovado',
      acceptanceCriteria: ['O fluxo funciona de ponta a ponta'],
    });
    const bindings: AuthorityProjectionBindings = Object.freeze({
      kind: 'greenfield',
      sourceFile: GUIDED_GREENFIELD_BRIEF_PATH,
      sourceContent,
      sourceHash: createHash('sha256').update(sourceContent).digest('hex'),
      approvedIntent: Object.freeze({
        goal: 'Entregar o produto aprovado',
        acceptanceCriteria: Object.freeze([
          'O fluxo funciona de ponta a ponta',
        ]),
      }),
      headSha: null,
    });
    const proposal = renderAuthorityBootstrapProposal(
      '.context/docs/project-overview.md',
      bindings,
      sourceRef(bindings),
    );

    expect(proposal).not.toBeNull();
    expect(
      proposal && verifyAuthorityBootstrapProposal(proposal, bindings),
    ).toBe(true);
    expect(
      proposal &&
        verifyAuthorityBootstrapProposal(
          {
            ...proposal,
            content: proposal.content.replace(
              '## Bound source',
              '## Source binding',
            ),
          },
          bindings,
        ),
    ).toBe(false);
    expect(
      proposal &&
        verifyAuthorityBootstrapProposal(
          {
            ...proposal,
            content: `${proposal.content.slice(0, -1)}\n\n## Helpful inference\n\n- React\n`,
          },
          bindings,
        ),
    ).toBe(false);
  });

  it('binds promoted-plan AST to the exact source bytes, sections and hash', () => {
    const sourceContent = [
      '# Approved PRD',
      '',
      '## Constraints',
      '- Preserve user authority',
      '',
    ].join('\n');
    const bindings: AuthorityProjectionBindings = Object.freeze({
      kind: 'promoted-plan',
      sourceFile: 'plan.md',
      sourceContent,
      sourceHash: createHash('sha256').update(sourceContent).digest('hex'),
      approvedIntent: Object.freeze({
        goal: 'Implement the approved PRD',
        acceptanceCriteria: Object.freeze(['All criteria are verified']),
      }),
      headSha: 'a'.repeat(40),
    });
    const proposal = renderAuthorityBootstrapProposal(
      '.context/docs/architecture.md',
      bindings,
      sourceRef(bindings),
    );

    expect(proposal?.content).toContain(sourceContent);
    expect(
      proposal && verifyAuthorityBootstrapProposal(proposal, bindings),
    ).toBe(true);
    expect(
      proposal &&
        verifyAuthorityBootstrapProposal(
          {
            ...proposal,
            content: proposal.content.replace(
              'Preserve user authority',
              'Trust generated authority',
            ),
          },
          bindings,
        ),
    ).toBe(false);
    expect(
      proposal &&
        verifyAuthorityBootstrapProposal(
          {
            ...proposal,
            sources: Object.freeze([
              Object.freeze({
                ...proposal.sources[0]!,
                sourceHash: 'b'.repeat(64),
              }),
            ]),
          },
          bindings,
        ),
    ).toBe(false);
  });
});
