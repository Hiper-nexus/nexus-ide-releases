import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectExecutionScope } from '../../shared/types';
import type { ContextDraftRecord } from './context-draft-store';
import type { ContextReadinessReport } from './context-doctor';
import type { BootstrapDocProposal } from './orientation/orientation-bootstrap-context';
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
  proposals: [] as BootstrapDocProposal[],
  propose: vi.fn(),
  apply: vi.fn(),
  review: vi.fn(),
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
  inspectGit: vi.fn(),
  mechanicallyReviewableTargets: new Set<string>(),
}));

vi.mock('./git-binding', () => ({
  inspectGitBinding: mocks.inspectGit,
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
    review: mocks.review,
    apply: mocks.apply,
    commitApplied: mocks.commitApplied,
    activeForTarget: () => null,
    supersedeActiveForTarget: () => null,
  }),
}));

vi.mock('./orientation/orientation-bootstrap-context', async () => {
  const actual = await vi.importActual<
    typeof import('./orientation/orientation-bootstrap-context')
  >('./orientation/orientation-bootstrap-context');
  return {
    ...actual,
    buildContextBootstrapProposals: () => mocks.proposals,
    isMechanicallyReviewableBootstrapProposal: (
      _scope: ProjectExecutionScope,
      proposal: { targetPath: string },
    ) => mocks.mechanicallyReviewableTargets.has(proposal.targetPath),
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
  // Keep in sync with cli-context-draft-reviewer.ts — importing the real
  // module would drag the whole pane/pty tree into this unit test.
  CONTEXT_DRAFT_REVIEW_UNAVAILABLE_MESSAGE:
    'context draft auto-review unavailable',
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

function fileProposalSources(
  record: ContextDraftRecord,
): BootstrapDocProposal['sources'] {
  return record.sources.map((source) => {
    if (source.type !== 'file') {
      throw new Error(`expected file source, received ${source.type}`);
    }
    return Object.freeze({
      type: source.type,
      locator: source.locator,
      sourceHash: source.sourceHash,
    });
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.proposals = [];
  mocks.list.mockReturnValue([]);
  mocks.readDraft.mockReturnValue(null);
  mocks.mechanicallyReviewableTargets.clear();
  mocks.get.mockReturnValue(null);
  mocks.inspectReadiness.mockReturnValue(mocks.readiness);
  mocks.inspectGit.mockReturnValue({
    baseSha: 'a'.repeat(40),
    headSha: 'a'.repeat(40),
    diffHash: 'b'.repeat(64),
  });
  mocks.selectQuorum.mockReturnValue({ adapterId: 'claude' });
  mocks.ensure.mockResolvedValue({ docs: { hasContextScaffold: true }, status: 'ready' });
});

describe('runContextBootstrapAutopilot', () => {
  it('mechanically reviews every canonical greenfield projection without a second CLI and commits once ready', async () => {
    const ready: ContextReadinessReport = Object.freeze({
      ready: true,
      blockers: Object.freeze([]),
      warnings: Object.freeze([]),
      contextRevision: 'e'.repeat(64),
      sensorIds: Object.freeze(['typecheck', 'unit']),
    });
    const architecture = draft('draft-greenfield-architecture', 'proposed');
    const invariant = Object.freeze({
      ...draft('draft-greenfield-invariant', 'proposed'),
      targetPath: '.context/nexus/invariants/approved-greenfield-intent.json',
      content: '{"schemaVersion":1,"facts":[{"id":"inv:a"}]}\n',
    });
    mocks.proposals = [
      {
        targetPath: architecture.targetPath,
        content: architecture.content,
        sources: fileProposalSources(architecture),
        rationale: 'canonical architecture unknowns',
      },
      {
        targetPath: invariant.targetPath,
        content: invariant.content,
        sources: fileProposalSources(invariant),
        rationale: 'canonical approved intent invariant',
      },
    ];
    mocks.mechanicallyReviewableTargets.add(architecture.targetPath);
    mocks.mechanicallyReviewableTargets.add(invariant.targetPath);
    mocks.propose
      .mockReturnValueOnce(architecture)
      .mockReturnValueOnce(invariant);
    mocks.readDraft.mockImplementation((id: string) =>
      id === architecture.id ? architecture : invariant,
    );
    mocks.review.mockImplementation((id: string) =>
      Object.freeze({
        ...(id === architecture.id ? architecture : invariant),
        status: 'approved' as const,
      }),
    );
    mocks.apply.mockImplementation((id: string) => ({
      draft: Object.freeze({
        ...(id === architecture.id ? architecture : invariant),
        status: 'applied' as const,
      }),
    }));
    mocks.inspectReadiness
      .mockReturnValueOnce(mocks.readiness)
      .mockReturnValue(ready);
    mocks.selectQuorum.mockReturnValue(null);
    mocks.commitApplied.mockReturnValue({
      commitSha: 'f'.repeat(40),
      drafts: [],
      recovered: false,
    });

    const result = await runContextBootstrapAutopilot({
      scope,
      author,
      autoCommit: true,
    });

    expect(mocks.review).toHaveBeenCalledTimes(2);
    expect(mocks.review).toHaveBeenCalledWith(
      architecture.id,
      expect.objectContaining({
        decision: 'approve',
        reviewer: expect.objectContaining({
          provider: 'nexus-mechanical-review',
        }),
      }),
    );
    expect(mocks.reviewerRun).not.toHaveBeenCalled();
    expect(mocks.apply).toHaveBeenCalledTimes(2);
    expect(mocks.commitApplied).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      phase: 'committed',
      quorumAvailable: false,
      commitSha: 'f'.repeat(40),
      appliedDraftIds: [
        architecture.id,
        invariant.id,
      ],
    });
    expect(
      result.bootstrapProposals.every(
        (proposal) => proposal.mechanicallyReviewable,
      ),
    ).toBe(true);
  });

  it('policy-rejects a resumable greenfield draft whose durable bytes differ from the canonical proposal', async () => {
    const canonical = Object.freeze({
      ...draft('draft-canonical', 'proposed'),
      content: '# Architecture\nOnly canonical unknowns.\n',
    });
    const malicious = Object.freeze({
      ...draft('draft-malicious', 'proposed'),
      content: '# Architecture\nInvented stack: privileged runtime.\n',
    });
    mocks.proposals = [{
      targetPath: canonical.targetPath,
      content: canonical.content,
      sources: fileProposalSources(canonical),
      rationale: 'canonical greenfield projection',
    }];
    mocks.mechanicallyReviewableTargets.add(canonical.targetPath);
    mocks.list.mockImplementation((options?: { status?: string }) =>
      options?.status === 'proposed' ? [malicious] : [],
    );
    mocks.propose.mockReturnValue(canonical);
    mocks.readDraft.mockImplementation((id: string) =>
      id === canonical.id ? canonical : malicious,
    );
    mocks.review.mockImplementation((id: string, input: {
      decision: 'approve' | 'reject';
    }) =>
      Object.freeze({
        ...(id === canonical.id ? canonical : malicious),
        status:
          input.decision === 'approve'
            ? 'approved' as const
            : 'rejected' as const,
      }),
    );
    mocks.apply.mockReturnValue({
      draft: Object.freeze({ ...canonical, status: 'applied' as const }),
    });
    mocks.selectQuorum.mockReturnValue(null);

    const result = await runContextBootstrapAutopilot({
      scope,
      author,
      autoCommit: false,
    });

    expect(mocks.review).toHaveBeenCalledWith(
      malicious.id,
      expect.objectContaining({
        decision: 'reject',
        reviewer: expect.objectContaining({ provider: 'nexus-policy' }),
      }),
    );
    expect(mocks.apply).not.toHaveBeenCalledWith(malicious.id);
    expect(mocks.review).toHaveBeenCalledWith(
      canonical.id,
      expect.objectContaining({
        decision: 'approve',
        reviewer: expect.objectContaining({
          provider: 'nexus-mechanical-review',
        }),
      }),
    );
    expect(mocks.apply).toHaveBeenCalledWith(canonical.id);
    expect(result.rejectedDraftIds).toContain(malicious.id);
    expect(result.appliedDraftIds).toContain(canonical.id);
  });

  it('does not mutate context when bootstrap was already preempted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(runContextBootstrapAutopilot({
      scope, author, signal: controller.signal,
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(mocks.ensure).not.toHaveBeenCalled();
    expect(mocks.scaffold).not.toHaveBeenCalled();
    expect(mocks.propose).not.toHaveBeenCalled();
  });

  it('reports dirty workflow binding as blocked and routes to parallel isolated-worktree writers', async () => {
    const ready: ContextReadinessReport = Object.freeze({
      ready: true,
      blockers: Object.freeze([]),
      warnings: Object.freeze([]),
      contextRevision: 'e'.repeat(64),
      sensorIds: Object.freeze(['typecheck']),
    });
    mocks.inspectReadiness.mockReturnValue(ready);
    mocks.inspectGit.mockImplementationOnce(() => {
      throw new Error('workflow binding requires a clean committed checkout');
    });

    const result = await runContextBootstrapAutopilot({
      scope,
      author,
      autoCommit: true,
    });

    expect(result.phase).toBe('blocked');
    expect(result.blockingError).toMatch(/clean committed checkout/i);
    expect(result.autopilotHint).toMatch(/isolated_worktree/);
    expect(result.autopilotHint).toMatch(/parallel writers/i);
    expect(result.autopilotHint).not.toMatch(/one writer at a time/i);
    expect(result.autopilotHint).toMatch(/do not ask.*stash/i);
  });

  it('commits durable applied drafts left by a previous Doctor pass once context is ready', async () => {
    const ready: ContextReadinessReport = Object.freeze({
      ready: true,
      blockers: Object.freeze([]),
      warnings: Object.freeze([]),
      contextRevision: 'e'.repeat(64),
      sensorIds: Object.freeze(['typecheck']),
    });
    const pending = draft('draft-pending-commit', 'applied');
    mocks.inspectReadiness.mockReturnValue(ready);
    mocks.list.mockReturnValue([pending]);
    mocks.commitApplied.mockReturnValue({
      commitSha: 'f'.repeat(40),
      drafts: [pending],
      recovered: false,
    });

    const result = await runContextBootstrapAutopilot({
      scope,
      author,
      autoCommit: true,
    });

    expect(mocks.commitApplied).toHaveBeenCalledOnce();
    expect(result.phase).toBe('committed');
    expect(result.commitSha).toBe('f'.repeat(40));
    expect(result.appliedDraftIds).toEqual(['draft-pending-commit']);
  });

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
    expect(mocks.ensure).toHaveBeenCalledWith(scope, {
      reason: 'mcp',
      waitMs: 8_000,
      force: true,
    });
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
      maxAutoReviews: 2,
      createReviewer: () => ({ run: mocks.reviewerRun }),
    });

    expect(mocks.reviewerRun).toHaveBeenNthCalledWith(1, { scope, draftId: 'draft-stale' });
    expect(mocks.reviewerRun).toHaveBeenNthCalledWith(2, { scope, draftId: 'draft-replacement' });
    expect(result.appliedDraftIds).toContain('draft-replacement');
  });

  it('breaks the infinite Doctor loop when review keeps rejecting byte-identical bootstrap content', async () => {
    // Regression: the active-target UNIQUE index only covers proposed/approved
    // drafts, so a rejected draft frees the slot. Without rejection memory the
    // autopilot re-proposes the SAME deterministic content every Doctor pass,
    // independent review rejects it again, and the mission burns its execution
    // budget in a silent loop until it dies blocked.
    mocks.inspectReadiness.mockReturnValue(mocks.readiness);
    const proposalContent = '# Business\nObserved from README.md.\n';
    mocks.proposals = [{
      targetPath: '.context/docs/business-model.md',
      content: proposalContent,
      sources: [{ type: 'file', locator: 'README.md', sourceHash: 'b'.repeat(64) }],
      rationale: 'biz',
    }];
    // A previous Doctor pass proposed this exact content and had it rejected by
    // independent review. That rejection is durable in the store.
    const priorRejected = Object.freeze({
      ...draft('draft-prev-rejected', 'rejected'),
      targetPath: '.context/docs/business-model.md',
      content: proposalContent,
    });
    mocks.list.mockImplementation((options?: { status?: string }) =>
      options?.status === 'rejected' ? [priorRejected] : [],
    );
    mocks.selectQuorum.mockReturnValue({ adapterId: 'claude' });
    mocks.ensure.mockResolvedValue({ docs: { hasContextScaffold: true }, status: 'ready' });

    const result = await runContextBootstrapAutopilot({
      scope,
      author,
      autoCommit: false,
      createReviewer: () => ({ run: mocks.reviewerRun }),
    });

    // Must NOT re-propose or re-review byte-identical content that will only be
    // rejected again — that is the loop.
    expect(mocks.propose).not.toHaveBeenCalled();
    expect(mocks.reviewerRun).not.toHaveBeenCalled();
    // The stuck target is recorded so the loop is observable, not silent.
    expect(result.draftOutcomes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        targetPath: '.context/docs/business-model.md',
        status: 'rejected-stable',
      }),
    ]));
    expect(result.phase).toBe('blocked');
    // The hint must terminate the loop: fix sources / author by hand, do not
    // keep re-running Doctor on identical content.
    expect(result.autopilotHint).toMatch(/byte-identical|terminal/i);
    expect(result.autopilotHint).toMatch(/do not call nexus_context_doctor/i);
  });

  it('reviews one draft per Doctor pass and directs the orchestrator to continue safely', async () => {
    mocks.inspectReadiness.mockReturnValue(mocks.readiness);
    mocks.proposals = [
      {
        targetPath: '.context/docs/architecture.md',
        content: '# Architecture\nObserved layout.\n',
        sources: [{ type: 'file', locator: 'package.json', sourceHash: 'b'.repeat(64) }],
        rationale: 'arch',
      },
      {
        targetPath: '.context/docs/testing.md',
        content: '# Testing\nRun unit tests.\n',
        sources: [{ type: 'file', locator: 'package.json', sourceHash: 'b'.repeat(64) }],
        rationale: 'testing',
      },
    ];
    mocks.list.mockReturnValue([]);
    mocks.propose
      .mockReturnValueOnce(draft('draft-first', 'proposed'))
      .mockReturnValueOnce(Object.freeze({
        ...draft('draft-second', 'proposed'),
        targetPath: '.context/docs/testing.md',
      }));
    mocks.reviewerRun.mockResolvedValue(draft('draft-first', 'rejected'));
    mocks.selectQuorum.mockReturnValue({ adapterId: 'claude' });
    mocks.ensure.mockResolvedValue({ docs: { hasContextScaffold: true }, status: 'ready' });

    const result = await runContextBootstrapAutopilot({
      scope,
      author,
      autoCommit: false,
      createReviewer: () => ({ run: mocks.reviewerRun }),
    });

    expect(mocks.reviewerRun).toHaveBeenCalledTimes(1);
    expect(result.draftOutcomes).toEqual(expect.arrayContaining([
      expect.objectContaining({ draftId: 'draft-second', status: 'proposed' }),
    ]));
    expect(result.autopilotHint).toMatch(/nexus_context_doctor again/i);
    expect(result.autopilotHint).toMatch(/do not fan out nexus_context_draft_review_run/i);
  });

  it('policy-rejects a contaminated durable draft before reviewing its clean replacement', async () => {
    mocks.inspectReadiness.mockReturnValue(mocks.readiness);
    const unsafe = Object.freeze({
      ...draft('draft-unsafe', 'proposed'),
      sources: Object.freeze([Object.freeze({
        type: 'file' as const,
        locator: '.claude/worktrees/stale/package.json',
        sourceHash: 'b'.repeat(64),
      })]),
    });
    const replacement = draft('draft-clean', 'proposed');
    mocks.proposals = [{
      targetPath: '.context/docs/architecture.md',
      content: '# Architecture\nBound to the root manifest.\n',
      sources: [{ type: 'file', locator: 'package.json', sourceHash: 'b'.repeat(64) }],
      rationale: 'arch',
    }];
    mocks.list.mockReturnValue([unsafe]);
    mocks.review.mockReturnValue(Object.freeze({
      ...unsafe,
      status: 'rejected' as const,
      reviewer: Object.freeze({
        id: 'nexus-bootstrap-policy',
        sessionId: 'source-policy-v1',
        provider: 'nexus-policy',
      }),
      reviewRationale: 'unsafe source',
      reviewedAt: 2,
    }));
    mocks.propose.mockReturnValue(replacement);
    mocks.reviewerRun.mockResolvedValue(draft('draft-clean', 'approved'));
    mocks.apply.mockReturnValue({ draft: draft('draft-clean', 'applied') });
    mocks.selectQuorum.mockReturnValue({ adapterId: 'claude' });
    mocks.ensure.mockResolvedValue({ docs: { hasContextScaffold: true }, status: 'ready' });

    const result = await runContextBootstrapAutopilot({
      scope,
      author,
      autoCommit: false,
      createReviewer: () => ({ run: mocks.reviewerRun }),
    });

    expect(mocks.review).toHaveBeenCalledWith('draft-unsafe', expect.objectContaining({
      decision: 'reject',
      reviewer: expect.objectContaining({ provider: 'nexus-policy' }),
    }));
    expect(mocks.reviewerRun).toHaveBeenCalledWith({ scope, draftId: 'draft-clean' });
    expect(result.appliedDraftIds).toContain('draft-clean');
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
    // Sem 2º provider, o caminho principal é a aprovação humana na UI.
    expect(result.autopilotHint).toMatch(/human approval/i);
    expect(result.autopilotHint).toMatch(/Nexus UI/i);
  });

  it('routes drafts to human approval when autonomous review gives up', async () => {
    mocks.inspectReadiness.mockReturnValue(mocks.readiness);
    mocks.proposals = [
      {
        targetPath: '.context/docs/architecture.md',
        content: '# Architecture\nObserved layout.\n',
        sources: [{ type: 'file', locator: 'package.json', sourceHash: 'b'.repeat(64) }],
        rationale: 'arch',
      },
    ];
    mocks.propose.mockReturnValue(draft('draft-stuck', 'proposed'));
    mocks.reviewerRun.mockRejectedValue(new Error(
      'context draft auto-review unavailable: the reviewer pane never decided',
    ));
    mocks.selectQuorum.mockReturnValue({ adapterId: 'claude' });
    mocks.ensure.mockResolvedValue({ docs: { hasContextScaffold: true }, status: 'ready' });

    const result = await runContextBootstrapAutopilot({
      scope,
      author,
      autoCommit: false,
      createReviewer: () => ({ run: mocks.reviewerRun }),
    });

    expect(result.draftOutcomes).toEqual(expect.arrayContaining([
      expect.objectContaining({ draftId: 'draft-stuck', status: 'review-failed' }),
    ]));
    expect(result.autopilotHint).toMatch(/gave up/i);
    expect(result.autopilotHint).toMatch(/human approval/i);
    expect(result.autopilotHint).toMatch(/Nexus UI/i);
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

  it('teaches the sanctioned invariants path when that is the blocker', async () => {
    // Sem isto o orquestrador fica num beco sem saída: o blocker exige
    // invariantes, o autopilot "não inventa regras de negócio" e ninguém diz
    // qual é o movimento sancionado (fact file observado + revisão).
    mocks.inspectReadiness.mockReturnValue({
      ...mocks.readiness,
      blockers: [
        {
          code: 'missing-structured-invariants' as const,
          message: 'faltam invariantes',
        },
      ],
    });

    const result = await runContextBootstrapAutopilot({
      scope,
      author,
      autoCommit: false,
      createReviewer: () => ({ run: mocks.reviewerRun }),
    });

    expect(result.autopilotHint).toMatch(/\.context\/nexus\/invariants/);
    expect(result.autopilotHint).toMatch(/observed/i);
    expect(result.autopilotHint).toMatch(/review/i);
  });

  it('aplica o modelo de negócio extraído, entrega o draft ao commit e não propõe o esqueleto antigo no mesmo alvo', async () => {
    const extracted: BootstrapDocProposal = Object.freeze({
      targetPath: '.context/docs/business-model.md',
      content: '# Modelo de negócio\n\n- **close_commanda#1** regra\n',
      sources: Object.freeze([
        Object.freeze({ type: 'file' as const, locator: 'supabase/migrations/1.sql', sourceHash: 'e'.repeat(64) }),
      ]),
      rationale: 'extraído',
    });
    const extraction = {
      fingerprint: 'f',
      document: { schemaVersion: 1 as const, flows: [], invariants: [] },
      proposal: extracted,
      pendingSources: [],
    };
    const businessDraft = Object.freeze({
      ...draft('bm-1', 'proposed'),
      targetPath: extracted.targetPath,
      content: extracted.content,
      sources: extracted.sources,
    });
    mocks.proposals = [
      {
        targetPath: '.context/docs/business-model.md',
        content: '# Business model\n\n> Auto-proposed skeleton\n- TODO\n',
        sources: [{ type: 'file', locator: 'package.json', sourceHash: 'b'.repeat(64) }],
        rationale: 'skeleton',
      },
    ];
    mocks.propose.mockReturnValue(businessDraft);
    mocks.readDraft.mockReturnValue(businessDraft);
    mocks.review.mockReturnValue({ ...businessDraft, status: 'approved' });
    mocks.apply.mockReturnValue({ draft: { ...businessDraft, status: 'applied' } });

    const result = await runContextBootstrapAutopilot({
      scope,
      author,
      autoCommit: false,
      createReviewer: () => ({ run: mocks.reviewerRun }),
      businessModel: { extract: () => extraction },
    });

    expect(result.businessModel?.status).toBe('applied');
    expect(result.appliedDraftIds).toEqual(['bm-1']);
    expect(mocks.propose).toHaveBeenCalledTimes(1);
    expect(mocks.propose.mock.calls[0]![0]).toMatchObject({ content: extracted.content });
    expect(result.bootstrapProposals.map((item) => item.targetPath))
      .not.toContain('.context/docs/business-model.md');
  });

  it('modelo de negócio que falha chega ao hint (não é engolido)', async () => {
    const result = await runContextBootstrapAutopilot({
      scope,
      author,
      autoCommit: false,
      createReviewer: () => ({ run: mocks.reviewerRun }),
      businessModel: {
        extract: () => {
          throw new Error('context attestation tree is not ready: drift em outro doc');
        },
      },
    });
    expect(result.businessModel?.status).toBe('failed');
    expect(result.autopilotHint).toContain(
      'Business model (.context/docs/business-model.md) failed: context attestation tree is not ready',
    );
  });
});
