import { describe, expect, it, vi } from 'vitest';
import type { ProjectExecutionScope } from '../../shared/types';
import type { ContextDraftRecord } from './context-draft-store';
import type { ContextReadinessReport } from './context-doctor';
import type { ProjectOrientationMap } from './orientation/orientation-types';

const mocks = vi.hoisted(() => ({
  readiness: {
    ready: false,
    blockers: [
      {
        code: 'missing-business-context' as const,
        message: 'missing',
      },
    ],
    warnings: [],
    sensorIds: [],
  } as ContextReadinessReport,
  proposals: [] as Array<{
    targetPath: string;
    content: string;
    sources: Array<{ type: 'file'; locator: string; sourceHash: string }>;
    rationale: string;
  }>,
  propose: vi.fn(),
  apply: vi.fn(),
  commitApplied: vi.fn(),
  scaffold: vi.fn(),
  inspectReadiness: vi.fn(),
  map: null as ProjectOrientationMap | null,
  ensure: vi.fn(),
  get: vi.fn(),
  toSnapshot: vi.fn(),
  selectQuorum: vi.fn(),
  reviewerRun: vi.fn(),
  list: vi.fn(() => [] as ContextDraftRecord[]),
  readDraft: vi.fn(),
}));

vi.mock('./context-workflow-registry', () => ({
  getContextWorkflowService: () => ({
    inspectReadiness: mocks.inspectReadiness,
    scaffold: mocks.scaffold,
  }),
  getContextKnowledgeService: () => ({
    list: mocks.list,
    get: mocks.readDraft,
    propose: mocks.propose,
    apply: mocks.apply,
    commitApplied: mocks.commitApplied,
  }),
}));

vi.mock('./orientation/orientation-bootstrap-context', async () => {
  const actual = await vi.importActual<
    typeof import('./orientation/orientation-bootstrap-context')
  >('./orientation/orientation-bootstrap-context');
  return {
    ...actual,
    buildContextBootstrapProposals: () => mocks.proposals,
  };
});

vi.mock('./orientation/orientation-service', () => ({
  tryGetProjectOrientationService: () => ({
    get: mocks.get,
    ensure: mocks.ensure,
    toSnapshot: mocks.toSnapshot,
  }),
}));

vi.mock('./cli-context-draft-reviewer', () => ({
  CliContextDraftReviewer: class {
    run = mocks.reviewerRun;
  },
  selectIndependentContextReviewerRoute: (provider: string) =>
    mocks.selectQuorum(provider),
}));

import { runContextBootstrapAutopilot } from './context-bootstrap-autopilot';

const scope: ProjectExecutionScope = Object.freeze({
  version: 1,
  installationId: 'install-a',
  projectId: 'project-a',
  checkoutId: 'checkout-a',
  rootRealPath: '/tmp/project-a',
  identitySource: 'provisional',
});

const author = Object.freeze({
  id: 'orch',
  sessionId: 'session-orch',
  provider: 'codex',
});

function draft(id: string, status: ContextDraftRecord['status']): ContextDraftRecord {
  return Object.freeze({
    id,
    missionId: null,
    targetPath: '.context/docs/architecture.md',
    content: '# Architecture\nfrom package.json\n',
    contentHash: 'a'.repeat(64),
    expectedTargetHash: null,
    sources: Object.freeze([
      Object.freeze({
        type: 'file' as const,
        locator: 'package.json',
        sourceHash: 'b'.repeat(64),
      }),
    ]),
    status,
    author,
    reviewer:
      status === 'proposed'
        ? null
        : Object.freeze({
            id: 'reviewer',
            sessionId: 'session-rev',
            provider: 'claude',
          }),
    reviewRationale: status === 'proposed' ? null : 'ok',
    attestationId: status === 'applied' ? 'att-1' : null,
    appliedCommit: null,
    createdAt: 1,
    updatedAt: 1,
    reviewedAt: status === 'proposed' ? null : 2,
    appliedAt: status === 'applied' ? 3 : null,
  });
}

describe('runContextBootstrapAutopilot', () => {
  it('resumes and reviews durable drafts left by a previous Doctor session', async () => {
    mocks.inspectReadiness.mockReturnValue(mocks.readiness);
    mocks.proposals = [{
      targetPath: '.context/docs/architecture.md',
      content: '# Architecture\nObserved layout.\n',
      sources: [{ type: 'file', locator: 'package.json', sourceHash: 'b'.repeat(64) }],
      rationale: 'arch',
    }];
    mocks.list.mockReturnValue([draft('draft-existing', 'proposed')]);
    mocks.reviewerRun.mockResolvedValue(draft('draft-existing', 'approved'));
    mocks.apply.mockReturnValue({
      draft: draft('draft-existing', 'applied'),
      attestation: {},
      attestationPath: '.context/nexus/attestations/x.json',
      replacedAttestationPaths: [],
    });
    mocks.selectQuorum.mockReturnValue({ adapterId: 'claude' });
    mocks.ensure.mockResolvedValue({
      docs: { hasContextScaffold: true },
      mapHash: 'c'.repeat(64),
      status: 'ready',
    });

    const result = await runContextBootstrapAutopilot({
      scope,
      author,
      autoCommit: false,
      createReviewer: () => ({ run: mocks.reviewerRun }),
    });

    expect(mocks.propose).not.toHaveBeenCalled();
    expect(mocks.reviewerRun).toHaveBeenCalledWith({ scope, draftId: 'draft-existing' });
    expect(result.appliedDraftIds).toEqual(['draft-existing']);
    mocks.list.mockReturnValue([]);
    mocks.propose.mockClear();
    mocks.reviewerRun.mockClear();
  });
  it('replaces a rejected stale placeholder and reviews the current source-bound proposal', async () => {
    mocks.inspectReadiness.mockReturnValue(mocks.readiness);
    const stale = Object.freeze({
      ...draft('draft-stale', 'proposed'),
      content: '# Architecture\nTODO: describe it\n',
    });
    mocks.proposals = [{
      targetPath: '.context/docs/architecture.md',
      content: '# Architecture\nObserved from package.json.\n',
      sources: [{ type: 'file', locator: 'package.json', sourceHash: 'b'.repeat(64) }],
      rationale: 'arch',
    }];
    mocks.list.mockReturnValue([stale]);
    mocks.readDraft.mockReturnValue(stale);
    mocks.ensure.mockResolvedValue({ docs: { hasContextScaffold: true }, status: 'ready' });
    mocks.selectQuorum.mockReturnValue({ adapterId: 'claude' });
    mocks.reviewerRun
      .mockResolvedValueOnce(draft('draft-stale', 'rejected'))
      .mockResolvedValueOnce(draft('draft-replacement', 'approved'));
    mocks.propose.mockReturnValue(draft('draft-replacement', 'proposed'));
    mocks.apply.mockReturnValue({
      draft: draft('draft-replacement', 'applied'),
      attestation: {},
      attestationPath: '.context/nexus/attestations/x.json',
      replacedAttestationPaths: [],
    });

    const result = await runContextBootstrapAutopilot({
      scope,
      author,
      autoCommit: false,
      createReviewer: () => ({ run: mocks.reviewerRun }),
    });

    expect(mocks.reviewerRun).toHaveBeenNthCalledWith(1, { scope, draftId: 'draft-stale' });
    expect(mocks.reviewerRun).toHaveBeenNthCalledWith(2, { scope, draftId: 'draft-replacement' });
    expect(result.appliedDraftIds).toContain('draft-replacement');
    mocks.list.mockReturnValue([]);
    mocks.readDraft.mockReset();
    mocks.reviewerRun.mockReset();
    mocks.propose.mockReset();
  });
  it('proposes drafts and skips review when quorum is missing', async () => {
    mocks.inspectReadiness.mockReturnValue(mocks.readiness);
    mocks.proposals = [
      {
        targetPath: '.context/docs/architecture.md',
        content: '# Architecture\nObserved layout.\n',
        sources: [{ type: 'file', locator: 'package.json', sourceHash: 'b'.repeat(64) }],
        rationale: 'arch',
      },
    ];
    mocks.propose.mockReturnValue(draft('draft-1', 'proposed'));
    mocks.selectQuorum.mockReturnValue(null);
    mocks.ensure.mockResolvedValue({
      docs: { hasContextScaffold: true },
      mapHash: 'c'.repeat(64),
      status: 'ready',
    });
    mocks.get.mockReturnValue(null);
    mocks.toSnapshot.mockReturnValue({
      schemaVersion: 1,
      projectId: 'project-a',
      checkoutId: 'checkout-a',
      headSha: null,
      treeFingerprint: 'd'.repeat(64),
      builtAt: 't',
      buildDurationMs: 1,
      status: 'ready',
      mapHash: 'c'.repeat(64),
      contextReady: false,
      orientationMarkdown: '# map',
    });

    const result = await runContextBootstrapAutopilot({
      scope,
      author,
      autoReview: true,
      selectQuorum: () => null,
    });

    expect(result.phase).toBe('awaiting-quorum');
    expect(result.proposedDraftIds).toEqual(['draft-1']);
    expect(result.quorumAvailable).toBe(false);
    expect(mocks.reviewerRun).not.toHaveBeenCalled();
    expect(result.autopilotHint).toMatch(/quorum/i);
  });

  it('runs independent review, applies, and commits when ready', async () => {
    const notReady = mocks.readiness;
    const ready: ContextReadinessReport = Object.freeze({
      ready: true,
      blockers: Object.freeze([]),
      warnings: Object.freeze([]),
      contextRevision: 'e'.repeat(64),
      sensorIds: Object.freeze(['typecheck', 'unit']),
    });
    mocks.inspectReadiness
      .mockReturnValueOnce(notReady)
      .mockReturnValueOnce(ready);
    mocks.proposals = [
      {
        targetPath: '.context/docs/architecture.md',
        content: '# Architecture\nObserved layout from package.json.\n',
        sources: [{ type: 'file', locator: 'package.json', sourceHash: 'b'.repeat(64) }],
        rationale: 'arch',
      },
    ];
    mocks.propose.mockReturnValue(draft('draft-2', 'proposed'));
    mocks.reviewerRun.mockResolvedValue(draft('draft-2', 'approved'));
    mocks.apply.mockReturnValue({
      draft: draft('draft-2', 'applied'),
      attestation: {},
      attestationPath: '.context/nexus/attestations/x.json',
      replacedAttestationPaths: [],
    });
    mocks.commitApplied.mockReturnValue({
      commitSha: 'f'.repeat(40),
      drafts: [draft('draft-2', 'applied')],
      recovered: false,
    });
    mocks.ensure.mockResolvedValue({
      docs: { hasContextScaffold: true },
      mapHash: 'c'.repeat(64),
      status: 'ready',
    });
    mocks.toSnapshot.mockReturnValue({
      schemaVersion: 1,
      projectId: 'project-a',
      checkoutId: 'checkout-a',
      headSha: null,
      treeFingerprint: 'd'.repeat(64),
      builtAt: 't',
      buildDurationMs: 1,
      status: 'ready',
      mapHash: 'c'.repeat(64),
      contextReady: false,
      orientationMarkdown: '# map',
    });

    const result = await runContextBootstrapAutopilot({
      scope,
      author,
      autoReview: true,
      autoCommit: true,
      selectQuorum: () => ({ adapterId: 'claude' }),
      createReviewer: () => ({ run: mocks.reviewerRun }),
    });

    expect(mocks.reviewerRun).toHaveBeenCalledWith({
      scope,
      draftId: 'draft-2',
    });
    expect(mocks.apply).toHaveBeenCalledWith('draft-2');
    expect(mocks.commitApplied).toHaveBeenCalled();
    expect(result.phase).toBe('committed');
    expect(result.commitSha).toBe('f'.repeat(40));
    expect(result.appliedDraftIds).toEqual(['draft-2']);
    expect(result.autopilotHint).toMatch(/Freeze/i);
  });

  it('does not auto-review TODO product placeholders', async () => {
    mocks.inspectReadiness.mockReturnValue(mocks.readiness);
    mocks.proposals = [
      {
        targetPath: '.context/docs/business-model.md',
        content: '# Business\nTODO: who pays?\n',
        sources: [{ type: 'file', locator: 'README.md', sourceHash: 'b'.repeat(64) }],
        rationale: 'biz',
      },
    ];
    mocks.propose.mockReturnValue(
      draft('draft-todo', 'proposed'),
    );
    mocks.reviewerRun.mockClear();

    const result = await runContextBootstrapAutopilot({
      scope,
      author,
      selectQuorum: () => ({ adapterId: 'claude' }),
      createReviewer: () => ({ run: mocks.reviewerRun }),
    });

    expect(result.proposedDraftIds).toEqual(['draft-todo']);
    expect(mocks.reviewerRun).not.toHaveBeenCalled();
    expect(result.bootstrapProposals[0]?.autoReviewable).toBe(false);
  });
});
