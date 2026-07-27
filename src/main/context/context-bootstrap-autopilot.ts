import type { ProjectExecutionScope } from '../../shared/types';
import type { ContextAttestationActor } from './context-attestation';
import {
  CliContextDraftReviewer,
  CONTEXT_DRAFT_REVIEW_UNAVAILABLE_MESSAGE,
  selectIndependentContextReviewerRoute,
} from './cli-context-draft-reviewer';
import type { ContextDraftRecord } from './context-draft-store';
import {
  getContextKnowledgeService,
  getContextWorkflowService,
} from './context-workflow-registry';
import type { ContextReadinessReport } from './context-doctor';
import {
  buildContextBootstrapProposals,
  isSafeBootstrapSourceLocator,
  isAutoReviewableBootstrapProposal,
  isMechanicallyReviewableBootstrapProposal,
  type BootstrapDocProposal,
  type SanctionedPromotedPlanBootstrapSource,
} from './orientation/orientation-bootstrap-context';
import {
  tryGetProjectOrientationService,
  type ProjectOrientationService,
} from './orientation/orientation-service';
import type { OrientationSnapshot } from '../../shared/orientation-types';
import { inspectGitBinding } from './git-binding';
import { getProjectDomainStores } from '../orch/project-domain-store-registry';
import { assertPromotedPlanSnapshot } from '../orch/plan-promotion-authority';
import { resolvePromotedPlanGitSource } from '../orch/promoted-plan-git-authority';

export type BootstrapAutopilotPhase =
  | 'ready'
  | 'proposed'
  | 'awaiting-quorum'
  | 'reviewed'
  | 'committed'
  | 'blocked';

export interface BootstrapDraftOutcome {
  readonly draftId: string;
  readonly targetPath: string;
  readonly status:
    | ContextDraftRecord['status']
    | 'propose-failed'
    | 'review-failed'
    | 'rejected-stable';
  readonly autoReviewable: boolean;
  readonly error?: string;
}

export interface ContextBootstrapAutopilotResult {
  readonly phase: BootstrapAutopilotPhase;
  readonly readiness: ContextReadinessReport;
  readonly orientation: OrientationSnapshot | null;
  readonly bootstrapProposals: readonly {
    readonly targetPath: string;
    readonly rationale: string;
    readonly sourceCount: number;
    readonly autoReviewable: boolean;
    readonly mechanicallyReviewable: boolean;
  }[];
  readonly proposedDraftIds: readonly string[];
  readonly draftOutcomes: readonly BootstrapDraftOutcome[];
  readonly appliedDraftIds: readonly string[];
  readonly rejectedDraftIds: readonly string[];
  readonly commitSha: string | null;
  readonly blockingError: string | null;
  readonly quorumAvailable: boolean;
  readonly autopilotHint: string;
}

export interface ContextBootstrapAutopilotOptions {
  readonly scope: ProjectExecutionScope;
  readonly author: ContextAttestationActor;
  readonly missionId?: string | null;
  /** When true (default), run independent CLI review when quorum exists. */
  readonly autoReview?: boolean;
  /** When true (default), commit applied drafts if readiness becomes green. */
  readonly autoCommit?: boolean;
  readonly maxAutoReviews?: number;
  readonly signal?: AbortSignal;
  readonly orientation?: ProjectOrientationService | null;
  /**
   * Test/integration seam. Undefined resolves authority from the live mission;
   * null explicitly disables promoted-plan bootstrap.
   */
  readonly promotedPlanSource?: SanctionedPromotedPlanBootstrapSource | null;
  readonly createReviewer?: () => {
    run(input: {
      scope: ProjectExecutionScope;
      draftId: string;
    }): Promise<ContextDraftRecord>;
  };
  readonly selectQuorum?: (authorProvider: string) => { adapterId: string } | null;
}

const DEFAULT_MAX_AUTO_REVIEWS_PER_PASS = 1;
const BOOTSTRAP_SOURCE_POLICY_REVIEWER = Object.freeze({
  id: 'nexus-bootstrap-policy',
  sessionId: 'source-policy-v1',
  provider: 'nexus-policy',
});
const CANONICAL_SOURCE_MECHANICAL_REVIEWER = Object.freeze({
  id: 'nexus-canonical-context-reviewer',
  sessionId: 'deterministic-read-only-v1',
  provider: 'nexus-mechanical-review',
});

function bootstrapAbortError(): Error {
  const error = new Error('context bootstrap aborted by newer mission intent');
  error.name = 'AbortError';
  return error;
}

function throwIfBootstrapAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw bootstrapAbortError();
}

function rethrowIfBootstrapAborted(
  signal: AbortSignal | undefined,
  error: unknown,
): void {
  if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
    throw bootstrapAbortError();
  }
}

function freezeOutcomes(
  outcomes: readonly BootstrapDraftOutcome[],
): readonly BootstrapDraftOutcome[] {
  return Object.freeze(outcomes.map((item) => Object.freeze({ ...item })));
}

function exactDraftMatchesProposal(
  draft: ContextDraftRecord,
  proposal: BootstrapDocProposal,
  missionId: string | null,
): boolean {
  return (
    draft.status === 'proposed' &&
    draft.missionId === missionId &&
    draft.targetPath === proposal.targetPath &&
    draft.expectedTargetHash === null &&
    draft.content === proposal.content &&
    draft.sources.length === proposal.sources.length &&
    draft.sources.every(
      (source, index) =>
        source.type === proposal.sources[index]?.type &&
        source.locator === proposal.sources[index]?.locator &&
        source.sourceHash === proposal.sources[index]?.sourceHash,
    )
  );
}

/**
 * missing-structured-invariants era um beco sem saída: o blocker exige
 * invariantes, o autopilot não inventa regras de negócio e nada dizia qual é
 * o movimento sancionado. Invariantes OBSERVADAS de fontes reais (schema,
 * testes, configs) são evidência com proveniência — não invenção — e passam
 * pela mesma revisão independente de qualquer draft.
 */
const STRUCTURED_INVARIANTS_HINT =
  'For missing-structured-invariants: propose a draft targeting ' +
  '.context/nexus/invariants/<slug>.json with ' +
  '{"schemaVersion":1,"facts":[{"id","statement","claimKey","value",' +
  '"kind":"observed","category":"invariant"}]} derived from REAL sources ' +
  '(schema constraints, tests, configs) — observed evidence, never invented ' +
  'business rules. It goes through the same independent review.';

function invariantsGuidance(
  readiness: ContextBootstrapAutopilotResult['readiness'],
): string {
  const blocked = readiness.blockers.some(
    (blocker) => blocker.code === 'missing-structured-invariants',
  );
  return blocked ? ` ${STRUCTURED_INVARIANTS_HINT}` : '';
}

/**
 * O humano É um revisor independente sancionado (é independente do agente
 * autor): quando o quorum de providers falha — ou o auto-review desiste — o
 * caminho principal passa a ser a aprovação na UI, não "instale outro CLI".
 */
const HUMAN_CONTEXT_REVIEW_HINT =
  'Ask the user to review and approve the pending context draft(s) in the ' +
  'Nexus UI (Context drafts panel in Settings) — human approval counts as ' +
  'the independent review. Alternative: install/auth a second CLI provider, ' +
  'then nexus_context_draft_review_run on each draftId.';

function hintFor(result: Omit<ContextBootstrapAutopilotResult, 'autopilotHint'>): string {
  if (result.blockingError) {
    return (
      `Workflow binding blocked: ${result.blockingError}. ` +
      'Use delegated workers in `same_checkout` mode, one writer at a time. ' +
      'Do not ask the user to stash, reset, clean, or switch branches.'
    );
  }
  if (result.readiness.ready && result.commitSha) {
    return 'Context authority committed. Freeze the mission contract next.';
  }
  if (result.readiness.ready) {
    return 'Context ready. Freeze the mission contract next (or nexus_context_commit if applied drafts remain).';
  }
  const autoReviewUnavailable = result.draftOutcomes.some(
    (outcome) => outcome.error?.includes(CONTEXT_DRAFT_REVIEW_UNAVAILABLE_MESSAGE),
  );
  if (autoReviewUnavailable) {
    return (
      'Autonomous independent review gave up: the reviewer pane never decided ' +
      'after repeated resumed passes. ' +
      HUMAN_CONTEXT_REVIEW_HINT
    );
  }
  const stableRejected = result.draftOutcomes.filter(
    (outcome) => outcome.status === 'rejected-stable',
  );
  if (
    stableRejected.length > 0 &&
    result.proposedDraftIds.length === 0 &&
    result.appliedDraftIds.length === 0
  ) {
    const targets = [...new Set(stableRejected.map((outcome) => outcome.targetPath))].join(', ');
    return (
      `Independent review keeps rejecting the deterministic bootstrap proposal for ${targets} ` +
      'with byte-identical content, so re-proposing would loop without ever converging. This is a ' +
      'terminal bootstrap state: fix the underlying sources (or author the doc by hand with a ' +
      'source-bound draft), then re-run once. Do not call nexus_context_doctor again for the same ' +
      'content — it will only burn the execution budget.'
    );
  }
  if (!result.quorumAvailable && result.proposedDraftIds.length > 0) {
    return (
      'Drafts proposed from the code map, but independent reviewer quorum is unavailable. ' +
      HUMAN_CONTEXT_REVIEW_HINT
    );
  }
  const hasPendingAutoReview = result.draftOutcomes.some(
    (outcome) => outcome.autoReviewable && outcome.status === 'proposed',
  );
  if (result.quorumAvailable && hasPendingAutoReview) {
    return (
      'Bounded review pass complete. Call nexus_context_doctor again to continue ' +
      'the remaining drafts; do not fan out nexus_context_draft_review_run.'
    );
  }
  if (result.rejectedDraftIds.length > 0 && result.appliedDraftIds.length === 0) {
    return (
      'Independent review rejected structural drafts. Inspect rationales, fix sources, ' +
      'and re-propose. Do not invent business rules.'
    );
  }
  if (result.appliedDraftIds.length > 0 && !result.readiness.ready) {
    return (
      `Applied ${result.appliedDraftIds.length} draft(s); readiness still blocked: ` +
      `${result.readiness.blockers.map((b) => b.code).join(', ')}. ` +
      'Fill remaining product docs (e.g. business-model) with source-bound drafts.' +
      invariantsGuidance(result.readiness)
    );
  }
  if (result.proposedDraftIds.length > 0) {
    return 'Drafts proposed. Autonomous review in progress or pending.';
  }
  return (
    'Context not ready. Use orientation hubs as evidence and propose source-bound drafts. ' +
    'Never invent business rules.' +
    invariantsGuidance(result.readiness)
  );
}

function workflowBindingError(scope: ProjectExecutionScope): string | null {
  try {
    inspectGitBinding(scope);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function resolveLivePromotedPlanBootstrapSource(
  options: ContextBootstrapAutopilotOptions,
): SanctionedPromotedPlanBootstrapSource | null {
  if (options.promotedPlanSource !== undefined) {
    return options.promotedPlanSource;
  }
  const missionId = options.missionId;
  if (!missionId) return null;

  let mission: ReturnType<
    ReturnType<typeof getProjectDomainStores>['missions']['get']
  >;
  try {
    mission = getProjectDomainStores(options.scope).missions.get(missionId);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === 'project-scoped domain stores are not initialized'
    ) {
      return null;
    }
    throw error;
  }
  const contract = mission?.intentContract;
  if (!contract?.promotedPlan) return null;
  if ((contract.lane ?? 'standard') !== 'standard') {
    throw new Error(
      'promoted_plan_context_invalid_lane: somente a missão standard promovida pode usar o PRD',
    );
  }
  const snapshot = assertPromotedPlanSnapshot(contract.promotedPlan);
  const source = resolvePromotedPlanGitSource(options.scope, snapshot);
  return Object.freeze({
    file: source.path,
    content: source.content,
    sourceHash: source.sourceHash,
    headSha: source.headSha,
    approvedIntent: Object.freeze({
      goal: contract.goal,
      acceptanceCriteria: Object.freeze([...contract.acceptanceCriteria]),
    }),
  });
}

/**
 * Senior bootstrap pilot: map → scaffold → propose → (quorum) review/apply → commit.
 * Never self-approves. Never fabricates business authority without independent review.
 */
export async function runContextBootstrapAutopilot(
  options: ContextBootstrapAutopilotOptions,
): Promise<ContextBootstrapAutopilotResult> {
  throwIfBootstrapAborted(options.signal);
  const autoReview = options.autoReview !== false;
  const autoCommit = options.autoCommit !== false;
  const maxAutoReviews = Math.min(
    Math.max(1, options.maxAutoReviews ?? DEFAULT_MAX_AUTO_REVIEWS_PER_PASS),
    16,
  );
  const workflow = getContextWorkflowService(options.scope);
  const knowledge = getContextKnowledgeService(options.scope);
  // Resolve before the readiness fast-path: an already-green context must not
  // hide a promoted PRD whose live mission, seal, file, HEAD or SHA drifted.
  const promotedPlanSource = resolveLivePromotedPlanBootstrapSource(options);
  const orientationService =
    options.orientation === undefined
      ? tryGetProjectOrientationService()
      : options.orientation;

  let orientationSnapshot: OrientationSnapshot | null = null;
  let map = orientationService?.get(options.scope) ?? null;
  if (orientationService) {
    try {
      map = await orientationService.ensure(options.scope, {
        reason: 'mcp',
        waitMs: 8_000,
        force: true,
        signal: options.signal,
      });
      throwIfBootstrapAborted(options.signal);
      orientationSnapshot = orientationService.toSnapshot(map);
    } catch (error) {
      rethrowIfBootstrapAborted(options.signal, error);
      // orientation is advisory; readiness still runs
    }
  }
  // Scaffold is cheap and required before proposals; always attempt when not ready later.
  try {
    throwIfBootstrapAborted(options.signal);
    if (!map?.docs.hasContextScaffold) {
      workflow.scaffold();
    }
  } catch (error) {
    rethrowIfBootstrapAborted(options.signal, error);
    // scaffold may fail if scope root is read-only; propose path will surface blockers
  }

  throwIfBootstrapAborted(options.signal);
  let readiness = workflow.inspectReadiness();
  if (readiness.ready) {
    const durableApplied = knowledge.list({ status: 'applied' })
      .filter((draft) => draft.appliedCommit === null);
    let recoveredCommitSha: string | null = null;
    let blockingError: string | null = null;
    if (autoCommit && durableApplied.length > 0) {
      try {
        throwIfBootstrapAborted(options.signal);
        recoveredCommitSha = knowledge.commitApplied().commitSha;
      } catch (error) {
        rethrowIfBootstrapAborted(options.signal, error);
        blockingError = error instanceof Error ? error.message : String(error);
      }
    }
    blockingError ??= workflowBindingError(options.scope);
    const base = {
      phase: blockingError
        ? 'blocked' as const
        : recoveredCommitSha
          ? 'committed' as const
          : 'ready' as const,
      readiness,
      orientation: orientationSnapshot,
      bootstrapProposals: Object.freeze([] as const),
      proposedDraftIds: Object.freeze([] as const),
      draftOutcomes: Object.freeze([] as const),
      appliedDraftIds: Object.freeze(durableApplied.map((draft) => draft.id)),
      rejectedDraftIds: Object.freeze([] as const),
      commitSha: recoveredCommitSha,
      blockingError,
      quorumAvailable: Boolean(
        (options.selectQuorum ?? selectIndependentContextReviewerRoute)(
          options.author.provider,
        ),
      ),
    };
    return Object.freeze({ ...base, autopilotHint: hintFor(base) });
  }

  const proposalOptions = Object.freeze({ promotedPlanSource });
  const proposals: BootstrapDocProposal[] = map
    ? [
        ...buildContextBootstrapProposals(
          options.scope,
          map,
          proposalOptions,
        ),
      ]
    : [];
  const proposalMeta = proposals.map((p) =>
    Object.freeze({
      targetPath: p.targetPath,
      rationale: p.rationale,
      sourceCount: p.sources.length,
      autoReviewable: isAutoReviewableBootstrapProposal(p),
      mechanicallyReviewable: isMechanicallyReviewableBootstrapProposal(
        options.scope,
        p,
        proposalOptions,
      ),
    }),
  );

  const proposedDraftIds: string[] = [];
  const outcomes: BootstrapDraftOutcome[] = [];
  const autoReviewQueue: string[] = [];
  const mechanicalReviewQueue: string[] = [];
  const appliedDraftIds: string[] = [];
  const rejectedDraftIds: string[] = [];

  // A previous Doctor run may have proposed drafts and then lost its CLI
  // session before review. Those records are durable authority, so resume them
  // instead of trying to re-propose the same target and returning only UNIQUE
  // constraint errors with no actionable draft IDs.
  const proposalsByTarget = new Map(proposals.map((item) => [item.targetPath, item]));
  const resumableDrafts = knowledge
    .list({ status: 'proposed' })
    .filter(
      (draft) =>
        (draft.missionId === null || draft.missionId === (options.missionId ?? null)) &&
        proposalsByTarget.has(draft.targetPath),
    );
  const resumableTargets = new Set<string>();
  for (const draft of resumableDrafts) {
    throwIfBootstrapAborted(options.signal);
    const proposal = proposalsByTarget.get(draft.targetPath)!;
    const autoReviewable = isAutoReviewableBootstrapProposal(proposal);
    const unsafeSource = draft.sources.find(
      (source) => !isSafeBootstrapSourceLocator(source.locator),
    );
    if (unsafeSource) {
      const rejected = knowledge.review(draft.id, {
        decision: 'reject',
        reviewer: BOOTSTRAP_SOURCE_POLICY_REVIEWER,
        rationale:
          `Rejected by fail-closed bootstrap source policy: ${unsafeSource.locator} ` +
          'is generated agent/runtime state or a non-semantic lockfile.',
      });
      rejectedDraftIds.push(rejected.id);
      outcomes.push({
        draftId: rejected.id,
        targetPath: rejected.targetPath,
        status: 'rejected',
        autoReviewable,
      });
      continue;
    }
    const mechanicallyReviewable =
      isMechanicallyReviewableBootstrapProposal(
        options.scope,
        proposal,
        proposalOptions,
      );
    if (
      mechanicallyReviewable &&
      !exactDraftMatchesProposal(
        draft,
        proposal,
        options.missionId ?? null,
      )
    ) {
      const rejected = knowledge.review(draft.id, {
        decision: 'reject',
        reviewer: BOOTSTRAP_SOURCE_POLICY_REVIEWER,
        rationale:
          'Rejected by fail-closed canonical-source policy: durable draft bytes, mission binding, target precondition or complete source set do not match the sanctioned proposal.',
      });
      rejectedDraftIds.push(rejected.id);
      outcomes.push({
        draftId: rejected.id,
        targetPath: rejected.targetPath,
        status: 'rejected',
        autoReviewable,
      });
      continue;
    }
    resumableTargets.add(draft.targetPath);
    proposedDraftIds.push(draft.id);
    outcomes.push({
      draftId: draft.id,
      targetPath: draft.targetPath,
      status: draft.status,
      autoReviewable,
    });
    if (mechanicallyReviewable) {
      mechanicalReviewQueue.push(draft.id);
    } else if (autoReviewable) {
      autoReviewQueue.push(draft.id);
    }
  }

  // Rejection memory across Doctor passes. idx_context_drafts_active_target is
  // UNIQUE only over proposed/approved drafts, so a rejected draft frees the
  // slot and the deterministic proposal below would happily re-insert
  // byte-identical content that independent review already rejected — an
  // infinite Doctor loop that drains the mission execution budget. Remember
  // which targets already carry a rejected draft with identical content so we
  // can escalate instead of re-proposing.
  const rejectedContentByTarget = new Map<string, Set<string>>();
  for (const draft of knowledge.list({ status: 'rejected' })) {
    if (draft.missionId !== null && draft.missionId !== (options.missionId ?? null)) continue;
    if (!proposalsByTarget.has(draft.targetPath)) continue;
    const contents = rejectedContentByTarget.get(draft.targetPath) ?? new Set<string>();
    contents.add(draft.content);
    rejectedContentByTarget.set(draft.targetPath, contents);
  }

  for (const proposal of proposals) {
    throwIfBootstrapAborted(options.signal);
    if (resumableTargets.has(proposal.targetPath)) continue;
    const autoReviewable = isAutoReviewableBootstrapProposal(proposal);
    if (rejectedContentByTarget.get(proposal.targetPath)?.has(proposal.content)) {
      // Byte-identical to a prior independent-review rejection: re-proposing
      // only loops. Record a terminal outcome and escalate via the hint.
      outcomes.push({
        draftId: '',
        targetPath: proposal.targetPath,
        status: 'rejected-stable',
        autoReviewable,
      });
      continue;
    }
    try {
      const draft = knowledge.propose(
        {
          missionId: options.missionId ?? null,
          targetPath: proposal.targetPath,
          content: proposal.content,
          expectedTargetHash: null,
          sources: proposal.sources,
        },
        options.author,
      );
      proposedDraftIds.push(draft.id);
      outcomes.push({
        draftId: draft.id,
        targetPath: proposal.targetPath,
        status: draft.status,
        autoReviewable,
      });
      if (
        isMechanicallyReviewableBootstrapProposal(
          options.scope,
          proposal,
          proposalOptions,
        )
      ) {
        mechanicalReviewQueue.push(draft.id);
      } else if (autoReviewable) {
        autoReviewQueue.push(draft.id);
      }
    } catch (error) {
      rethrowIfBootstrapAborted(options.signal, error);
      outcomes.push({
        draftId: '',
        targetPath: proposal.targetPath,
        status: 'propose-failed',
        autoReviewable,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Canonical sanctioned sources (the Main-owned PRODUCT.md envelope or the
  // exact promoted PRD resolved from live mission + sealed snapshot + Git
  // HEAD/SHA) admit byte-exact reconstruction. An independent Nexus reviewer
  // verifies those bytes without interpreting domain meaning. Author and
  // reviewer remain distinct; apply/commit stay separate.
  for (const draftId of mechanicalReviewQueue) {
    try {
      throwIfBootstrapAborted(options.signal);
      const current = knowledge.get(draftId);
      const proposal = current
        ? proposalsByTarget.get(current.targetPath)
        : undefined;
      if (
        !current ||
        !proposal ||
        !isMechanicallyReviewableBootstrapProposal(
          options.scope,
          proposal,
          proposalOptions,
        ) ||
        !exactDraftMatchesProposal(
          current,
          proposal,
          options.missionId ?? null,
        )
      ) {
        if (current?.status === 'proposed') {
          const rejected = knowledge.review(current.id, {
            decision: 'reject',
            reviewer: BOOTSTRAP_SOURCE_POLICY_REVIEWER,
            rationale:
              'Rejected by fail-closed canonical-source policy immediately before review: durable draft authority diverged from the sanctioned proposal.',
          });
          rejectedDraftIds.push(rejected.id);
        }
        throw new Error(
          'canonical-source mechanical review refused a non-canonical durable draft',
        );
      }
      const source = proposal.sources[0]!;
      const reviewed = knowledge.review(draftId, {
        decision: 'approve',
        reviewer: CANONICAL_SOURCE_MECHANICAL_REVIEWER,
        rationale:
          `Approved by deterministic read-only review: target bytes and sole sanctioned source ` +
          `${source.locator}@${source.sourceHash} match the canonical projection.`,
      });
      const applied =
        reviewed.status === 'applied'
          ? { draft: reviewed }
          : knowledge.apply(draftId);
      appliedDraftIds.push(applied.draft.id);
      const index = outcomes.findIndex((item) => item.draftId === draftId);
      if (index >= 0) outcomes[index] = { ...outcomes[index], status: 'applied' };
    } catch (error) {
      rethrowIfBootstrapAborted(options.signal, error);
      const index = outcomes.findIndex((item) => item.draftId === draftId);
      if (index >= 0) {
        outcomes[index] = {
          ...outcomes[index],
          status: 'review-failed',
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
  }

  const selectQuorum =
    options.selectQuorum ?? selectIndependentContextReviewerRoute;
  const quorum = selectQuorum(options.author.provider);
  const quorumAvailable = quorum !== null;

  if (autoReview && quorumAvailable && autoReviewQueue.length > 0) {
    const createReviewer =
      options.createReviewer ?? (() => new CliContextDraftReviewer());
    const reviewer = createReviewer();
    for (const draftId of autoReviewQueue.slice(0, maxAutoReviews)) {
      try {
        throwIfBootstrapAborted(options.signal);
        const reviewed = await reviewer.run({
          scope: options.scope,
          draftId,
          ...(options.signal
            ? { invocation: { signal: options.signal } }
            : {}),
        });
        throwIfBootstrapAborted(options.signal);
        if (reviewed.status === 'approved' || reviewed.status === 'applied') {
          const applied =
            reviewed.status === 'applied'
              ? { draft: reviewed }
              : knowledge.apply(draftId);
          appliedDraftIds.push(applied.draft.id);
          const idx = outcomes.findIndex((item) => item.draftId === draftId);
          if (idx >= 0) {
            outcomes[idx] = {
              ...outcomes[idx],
              status: 'applied',
            };
          }
        } else if (reviewed.status === 'rejected') {
          rejectedDraftIds.push(draftId);
          const idx = outcomes.findIndex((item) => item.draftId === draftId);
          if (idx >= 0) {
            outcomes[idx] = {
              ...outcomes[idx],
              status: 'rejected',
            };
          }
        } else {
          const idx = outcomes.findIndex((item) => item.draftId === draftId);
          if (idx >= 0) {
            outcomes[idx] = {
              ...outcomes[idx],
              status: reviewed.status,
            };
          }
        }
      } catch (error) {
        rethrowIfBootstrapAborted(options.signal, error);
        const idx = outcomes.findIndex((item) => item.draftId === draftId);
        if (idx >= 0) {
          outcomes[idx] = {
            ...outcomes[idx],
            status: 'review-failed',
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }
    }

    // A rejected draft may be an obsolete placeholder created by an older
    // orientation build. When the current deterministic proposal is materially
    // different and source-bound, replace and review it in this same Doctor
    // pass instead of forcing the orchestrator into another discovery loop.
    for (const rejectedId of [...rejectedDraftIds]) {
      throwIfBootstrapAborted(options.signal);
      if (appliedDraftIds.length + rejectedDraftIds.length >= maxAutoReviews) break;
      const rejected = knowledge.get(rejectedId);
      const replacement = rejected
        ? proposalsByTarget.get(rejected.targetPath)
        : undefined;
      if (
        !rejected ||
        !replacement ||
        rejected.content === replacement.content ||
        !isAutoReviewableBootstrapProposal(replacement)
      ) {
        continue;
      }
      try {
        const next = knowledge.propose(
          {
            missionId: options.missionId ?? null,
            targetPath: replacement.targetPath,
            content: replacement.content,
            expectedTargetHash: null,
            sources: replacement.sources,
          },
          options.author,
        );
        proposedDraftIds.push(next.id);
        outcomes.push({
          draftId: next.id,
          targetPath: next.targetPath,
          status: next.status,
          autoReviewable: true,
        });
        const reviewed = await reviewer.run({
          scope: options.scope,
          draftId: next.id,
          ...(options.signal
            ? { invocation: { signal: options.signal } }
            : {}),
        });
        throwIfBootstrapAborted(options.signal);
        if (reviewed.status === 'approved' || reviewed.status === 'applied') {
          const applied = reviewed.status === 'applied'
            ? { draft: reviewed }
            : knowledge.apply(next.id);
          appliedDraftIds.push(applied.draft.id);
          const index = outcomes.findIndex((item) => item.draftId === next.id);
          if (index >= 0) outcomes[index] = { ...outcomes[index], status: 'applied' };
        } else if (reviewed.status === 'rejected') {
          rejectedDraftIds.push(next.id);
          const index = outcomes.findIndex((item) => item.draftId === next.id);
          if (index >= 0) outcomes[index] = { ...outcomes[index], status: 'rejected' };
        }
      } catch (error) {
        rethrowIfBootstrapAborted(options.signal, error);
        outcomes.push({
          draftId: '',
          targetPath: replacement.targetPath,
          status: 'review-failed',
          autoReviewable: true,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  throwIfBootstrapAborted(options.signal);
  readiness = workflow.inspectReadiness();
  let commitSha: string | null = null;
  let blockingError: string | null = null;
  if (autoCommit && readiness.ready && appliedDraftIds.length > 0) {
    try {
      throwIfBootstrapAborted(options.signal);
      const committed = knowledge.commitApplied();
      commitSha = committed.commitSha;
    } catch (error) {
      rethrowIfBootstrapAborted(options.signal, error);
      blockingError = error instanceof Error ? error.message : String(error);
    }
  }
  if (readiness.ready) blockingError ??= workflowBindingError(options.scope);

  let phase: BootstrapAutopilotPhase = 'blocked';
  if (readiness.ready && !blockingError && commitSha) phase = 'committed';
  else if (readiness.ready && !blockingError) phase = 'ready';
  else if (appliedDraftIds.length > 0 || rejectedDraftIds.length > 0) phase = 'reviewed';
  else if (proposedDraftIds.length > 0 && !quorumAvailable) phase = 'awaiting-quorum';
  else if (proposedDraftIds.length > 0) phase = 'proposed';

  const base = {
    phase,
    readiness,
    orientation: orientationSnapshot,
    bootstrapProposals: Object.freeze(proposalMeta),
    proposedDraftIds: Object.freeze([...proposedDraftIds]),
    draftOutcomes: freezeOutcomes(outcomes),
    appliedDraftIds: Object.freeze([...appliedDraftIds]),
    rejectedDraftIds: Object.freeze([...rejectedDraftIds]),
    commitSha,
    blockingError,
    quorumAvailable,
  };
  return Object.freeze({
    ...base,
    autopilotHint: hintFor(base),
  });
}
