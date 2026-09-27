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
import { getOrchSettings } from '../persistence/settings-store';
import {
  buildDesignContractBootstrap,
  DESIGN_CONTRACT_BINDABLE_SOURCES,
  DESIGN_CONTRACT_TARGET_PATH,
  type DesignContractBootstrapDecision,
} from './design-contract-bootstrap';
import {
  describeDesignContractProposed,
  describeDesignContractRejected,
  describeDesignContractReviewDeferred,
  describeDesignContractSkip,
  type DesignContractSkipReason,
} from '../../shared/design-contract-policy';
import {
  runBusinessModelBootstrap,
  type BusinessModelBootstrapInput,
  type BusinessModelBootstrapOutcome,
} from './business-model/business-model-bootstrap';
import { BUSINESS_MODEL_TARGET_PATH } from './business-model/business-model-contract';

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

/**
 * What the design branch did this pass. `null` only when the branch is
 * explicitly disabled; otherwise it always explains itself, including the
 * skips — silence about design is exactly the state that let projects ship
 * without a contract.
 */
export interface DesignContractBootstrapOutcome {
  readonly targetPath: string;
  readonly status: 'applied' | 'proposed' | 'rejected' | 'skipped';
  /** `project-own` when the contract describes tokens the project already had. */
  readonly directionMode:
    | 'setting'
    | 'match'
    | 'neutral'
    | 'project-own'
    | null;
  readonly skipReason: DesignContractSkipReason | null;
  /** Agent-facing instruction; only present when a contract was materialized. */
  readonly hint: string | null;
  /**
   * Operator-facing prose, ALWAYS present. Every decision this branch makes —
   * including every skip — says what happened and what the operator can do.
   * The enum alone died inside the MCP payload and nobody could read it.
   */
  readonly message: string;
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
  readonly designContract: DesignContractBootstrapOutcome | null;
  /** Modelo de negócio extraído das fontes; null só quando o ramo está desligado. */
  readonly businessModel: BusinessModelBootstrapOutcome | null;
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
  /**
   * Design branch seams. `null` disables the branch entirely (rollback);
   * each `undefined` field resolves from the live mission / settings.
   */
  readonly designContract?: DesignContractBootstrapOptions | null;
  /** `null` desliga o ramo do modelo de negócio; `extract` é seam de teste. */
  readonly businessModel?: Pick<BusinessModelBootstrapInput, 'extract'> | null;
}

export interface DesignContractBootstrapOptions {
  /** Mission goal; `undefined` reads the live mission intent contract. */
  readonly missionGoal?: string | null;
  /** `undefined` reads `orch.designDefaultKit`. */
  readonly pinnedKitId?: string | null;
  /** `undefined` reads `orch.designLocalCatalogDir`. */
  readonly catalogDir?: string | null;
  readonly targetPath?: string;
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
/**
 * WHY THE DESIGN DRAFT DOES NOT GO TO THE CLI REVIEWER.
 *
 * `buildContextDraftReviewerPrompt` binds its reviewer to one method: "check
 * every material claim against all bound sources; insufficient evidence
 * requires rejection." That method fits a DESCRIPTIVE draft — a doc that
 * asserts facts about the repository. A design contract is PRESCRIPTIVE: apart
 * from the project name (bound to `package.json`) it asserts nothing about the
 * repository at all; the rest is Nexus's own house template plus an
 * identifier + hash of a reference file. Handing that to the CLI reviewer
 * would buy either an arbitrary approval (fabricated evidence) or a permanent
 * rejection (a deadlock that leaves the project with no contract). Both are
 * worse than the truth.
 *
 * So the design draft is verified the way the canonical projections above are
 * verified: an independent Nexus identity RE-DERIVES the document from the
 * same inputs and approves only on a byte-exact match. That covers 100% of
 * what the document actually claims — its provenance, its bound source hash,
 * and the fact that no foreign content was injected. It is a distinct
 * identity from the author, and apply/commit remain separate steps.
 */
const DESIGN_CONTRACT_MECHANICAL_REVIEWER = Object.freeze({
  id: 'nexus-design-contract-reviewer',
  sessionId: 'deterministic-house-contract-v1',
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

/**
 * Skips that a mission does not need to hear about on its loudest channel: the
 * goal is not about UI at all, so leading every backend hint with design prose
 * would be noise. Their `message` still travels in the payload — silence in the
 * hint is a volume decision, never a decision to hide.
 */
const QUIET_DESIGN_SKIPS: ReadonlySet<DesignContractSkipReason> = new Set([
  'no-goal',
  'not-visual-work',
  'asset-not-interface',
]);

/**
 * The design branch leads the hint whenever it has something a UI mission must
 * act on — the contract it just materialized, or the reason there is none.
 *
 * It used to speak ONLY on `applied`. Every other outcome (six skip reasons, a
 * rejection, a deferred review) was an enum in a payload with no prose anywhere
 * in the product, so the operator could not tell "no contract was needed" from
 * "the contract failed to materialize".
 */
function hintFor(result: Omit<ContextBootstrapAutopilotResult, 'autopilotHint'>): string {
  const design = result.designContract;
  const quiet =
    !design ||
    (design.status === 'skipped' &&
      design.skipReason !== null &&
      QUIET_DESIGN_SKIPS.has(design.skipReason));
  const lead = quiet
    ? ''
    : design.status === 'applied' && design.hint
      ? `${design.hint} `
      : `${design.message} `;
  return `${lead}${structuralHintFor(result)}${businessModelHintFor(result.businessModel)}`;
}

/**
 * O ramo do modelo de negócio só fala quando o agente precisa agir: falhou,
 * foi rejeitado ou ficou adiado. Aplicado/em dia/sem fonte é silencioso.
 */
function businessModelHintFor(outcome: BusinessModelBootstrapOutcome | null): string {
  if (!outcome || outcome.status === 'applied' || outcome.status === 'up-to-date') return '';
  if (outcome.status === 'skipped' && outcome.flows === 0 && outcome.invariants === 0) return '';
  return ` Business model (${outcome.targetPath}) ${outcome.status}: ${outcome.message}`;
}

function structuralHintFor(
  result: Omit<ContextBootstrapAutopilotResult, 'autopilotHint'>,
): string {
  if (result.blockingError) {
    return (
      `Workflow binding blocked: ${result.blockingError}. ` +
      'Delegate writers in isolated worktrees (`isolated_worktree`): parallel writers are fine, ' +
      'each on its own worktree and branch, merged through the queue; a second `same_checkout` writer is auto-isolated. ' +
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

/**
 * The mission goal, read from the live intent contract. Design is additive:
 * any failure to read the goal means "do not propose a design contract",
 * never "fail the bootstrap".
 */
function resolveMissionGoal(
  options: ContextBootstrapAutopilotOptions,
): string | null {
  const configured = options.designContract?.missionGoal;
  if (configured !== undefined) return configured;
  const missionId = options.missionId;
  if (!missionId) return null;
  try {
    const mission = getProjectDomainStores(options.scope).missions.get(missionId);
    return mission?.intentContract?.goal ?? null;
  } catch {
    return null;
  }
}

function resolveDesignSettings(options: ContextBootstrapAutopilotOptions): {
  pinnedKitId: string | null;
  catalogDir: string | null;
} {
  const explicit = options.designContract ?? {};
  const needsSettings =
    explicit.pinnedKitId === undefined || explicit.catalogDir === undefined;
  let settingsPin: string | null = null;
  let settingsDir: string | null = null;
  if (needsSettings) {
    try {
      const settings = getOrchSettings();
      settingsPin = settings.designDefaultKit;
      settingsDir = settings.designLocalCatalogDir;
    } catch {
      // Settings must never be the reason a project ships with no contract.
    }
  }
  return {
    pinnedKitId:
      explicit.pinnedKitId === undefined ? settingsPin : explicit.pinnedKitId,
    catalogDir:
      explicit.catalogDir === undefined ? settingsDir : explicit.catalogDir,
  };
}

/**
 * Another author already owns this target when a proposed/approved draft sits
 * there that this pass could not resume (different bytes, or bound to another
 * mission). Their work wins: the autopilot steps aside instead of racing the
 * UNIQUE active-target index or rejecting a human's import under a policy that
 * was never written for it.
 */
function designTargetOwnedByAnotherDraft(
  knowledge: ReturnType<typeof getContextKnowledgeService>,
  proposal: BootstrapDocProposal,
  missionId: string | null,
): boolean {
  const occupying = [
    ...knowledge.list({ status: 'proposed' }),
    ...knowledge.list({ status: 'approved' }),
  ].filter((draft) => draft.targetPath === proposal.targetPath);
  return occupying.some(
    (draft) =>
      draft.content !== proposal.content ||
      (draft.missionId !== null && draft.missionId !== missionId),
  );
}

/**
 * The outcome of the design draft's independent re-derivation.
 *
 * WHY THIS IS THREE STATES AND NOT `proposal | null` (A1)
 * ------------------------------------------------------
 * It used to swallow every throw and answer `null`, and `null` meant "reject".
 * But `buildDesignContractBootstrap` throws for TRANSIENT reasons too:
 * `findExistingDesignContractInScope` re-raises anything that is not ENOENT, so
 * one momentary EACCES/EISDIR on DESIGN.md became a DURABLE rejection. The next
 * pass then re-derived byte-identical content, matched the rejection memory,
 * recorded `rejected-stable` and never proposed again — and the one recovery
 * path, the "replace a rejected draft" loop, excludes design explicitly. The
 * target was blocked forever, with nothing in the product able to unblock it.
 *
 * A read failure is not evidence that a document is irreproducible. So:
 *   - `derived`     — it ran and produced a proposal; compare the bytes.
 *   - `refused`     — it ran and decided NOT to build (a contract appeared, the
 *                     evidence vanished). That is a real non-reproducibility.
 *   - `unavailable` — it could not run. Neither approve nor reject; retry.
 */
type DesignReDerivation =
  | { readonly kind: 'derived'; readonly proposal: BootstrapDocProposal }
  | { readonly kind: 'refused'; readonly detail: string }
  | { readonly kind: 'unavailable'; readonly error: string };

/**
 * A second, independent pass over exactly the same pure inputs. This is the
 * design draft's reviewer: it does not read the draft first and then look for
 * agreement — it rebuilds the document from scratch and the caller demands the
 * same bytes.
 */
async function reDeriveDesignProposal(
  options: ContextBootstrapAutopilotOptions,
  targetPath: string,
): Promise<DesignReDerivation> {
  const settings = resolveDesignSettings(options);
  let decision: DesignContractBootstrapDecision;
  try {
    decision = await buildDesignContractBootstrap({
      scope: options.scope,
      goal: resolveMissionGoal(options),
      pinnedKitId: settings.pinnedKitId,
      catalogDir: settings.catalogDir,
      targetPath,
    });
  } catch (error) {
    rethrowIfBootstrapAborted(options.signal, error);
    return Object.freeze({
      kind: 'unavailable' as const,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return decision.proposal
    ? Object.freeze({ kind: 'derived' as const, proposal: decision.proposal })
    : Object.freeze({
        kind: 'refused' as const,
        detail: decision.skipReason ?? 'unknown',
      });
}

/** Named so the outcome error is greppable and the hint can key off it. */
const DESIGN_CONTRACT_REVIEW_DEFERRED =
  'design-contract mechanical review could not re-derive the contract in this pass';

function sameProposalBytes(
  left: BootstrapDocProposal,
  right: BootstrapDocProposal,
): boolean {
  return (
    left.targetPath === right.targetPath &&
    left.content === right.content &&
    left.sources.length === right.sources.length &&
    left.sources.every(
      (source, index) =>
        source.type === right.sources[index]?.type &&
        source.locator === right.sources[index]?.locator &&
        source.sourceHash === right.sources[index]?.sourceHash,
    )
  );
}

function designDirectionMode(
  decision: DesignContractBootstrapDecision,
): DesignContractBootstrapOutcome['directionMode'] {
  if (decision.choice) return decision.choice.mode;
  return decision.contractKind === 'project-derived' ? 'project-own' : null;
}

function designMessage(input: {
  readonly decision: DesignContractBootstrapDecision;
  readonly targetPath: string;
  readonly status: DesignContractBootstrapOutcome['status'];
  readonly skipReason: DesignContractSkipReason | null;
  readonly reviewDeferredError: string | null;
}): string {
  const { decision, targetPath, status, skipReason } = input;
  if (status === 'skipped') {
    return describeDesignContractSkip({
      reason: skipReason ?? 'not-visual-work',
      targetPath,
      workKind: decision.workKind?.kind ?? null,
      workKindReason: decision.workKind?.reason ?? null,
      existingContractPath: decision.existingContractPath,
      bindableSources: DESIGN_CONTRACT_BINDABLE_SOURCES,
    });
  }
  if (status === 'applied') {
    return decision.hint ?? describeDesignContractProposed(targetPath);
  }
  if (status === 'rejected') return describeDesignContractRejected(targetPath);
  return input.reviewDeferredError !== null
    ? describeDesignContractReviewDeferred(targetPath, input.reviewDeferredError)
    : describeDesignContractProposed(targetPath);
}

function designOutcome(
  decision: DesignContractBootstrapDecision,
  targetPath: string,
  status: DesignContractBootstrapOutcome['status'],
  skipReason: DesignContractSkipReason | null = null,
  reviewDeferredError: string | null = null,
): DesignContractBootstrapOutcome {
  const resolvedSkipReason =
    status === 'skipped' ? (skipReason ?? decision.skipReason) : null;
  return Object.freeze({
    targetPath,
    status,
    directionMode: designDirectionMode(decision),
    skipReason: resolvedSkipReason,
    hint: status !== 'skipped' ? decision.hint : null,
    message: designMessage({
      decision,
      targetPath,
      status,
      skipReason: resolvedSkipReason,
      reviewDeferredError,
    }),
  });
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
  // Via Rápida: a promoção de plano morreu com o motor cerimonial. Apenas a
  // fonte injetada explicitamente (testes/seams) continua aceita.
  return options.promotedPlanSource ?? null;
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

  // BUSINESS-MODEL BRANCH. Também antes do fast-path: um corpus verde não
  // impede que migrations/regras mudem, e o modelo precisa acompanhar.
  throwIfBootstrapAborted(options.signal);
  const businessModel = options.businessModel === null
    ? null
    : await runBusinessModelBootstrap({
        scope: options.scope,
        knowledge,
        extract: options.businessModel?.extract,
      });
  const businessModelOwnsTarget =
    businessModel !== null &&
    ['applied', 'up-to-date'].includes(businessModel.status);

  // DESIGN BRANCH. Resolved before the readiness fast-path on purpose: a
  // project can have a perfectly green context corpus and still have no design
  // contract at all, which is precisely the state in which a UI mission starts
  // inventing its own palette. Structural readiness must not hide it.
  throwIfBootstrapAborted(options.signal);
  const designTargetPath =
    options.designContract?.targetPath ?? DESIGN_CONTRACT_TARGET_PATH;
  let designDecision: DesignContractBootstrapDecision | null = null;
  let designProposal: BootstrapDocProposal | null = null;
  let designOwnedByAnother = false;
  /** Set when the re-derivation could not run at all; see A1. */
  let designReviewDeferredError: string | null = null;
  if (options.designContract !== null) {
    const designSettings = resolveDesignSettings(options);
    try {
      designDecision = await buildDesignContractBootstrap({
        scope: options.scope,
        goal: resolveMissionGoal(options),
        pinnedKitId: designSettings.pinnedKitId,
        catalogDir: designSettings.catalogDir,
        targetPath: designTargetPath,
      });
      throwIfBootstrapAborted(options.signal);
      designProposal = designDecision.proposal;
      if (
        designProposal &&
        designTargetOwnedByAnotherDraft(
          knowledge,
          designProposal,
          options.missionId ?? null,
        )
      ) {
        designOwnedByAnother = true;
        designProposal = null;
      }
    } catch (error) {
      rethrowIfBootstrapAborted(options.signal, error);
      // Additive by construction: a broken catalog or an unreadable
      // package.json must never take the structural bootstrap down with it.
      designDecision = null;
      designProposal = null;
    }
  }
  const designSkipOutcome = (): DesignContractBootstrapOutcome | null =>
    designDecision
      ? designOutcome(
          designDecision,
          designTargetPath,
          'skipped',
          designOwnedByAnother ? 'foreign-active-draft' : null,
        )
      : null;

  throwIfBootstrapAborted(options.signal);
  let readiness = workflow.inspectReadiness();
  if (readiness.ready && !designProposal) {
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
      designContract: designSkipOutcome(),
      businessModel,
    };
    return Object.freeze({ ...base, autopilotHint: hintFor(base) });
  }

  const proposalOptions = Object.freeze({ promotedPlanSource });
  // Design is APPENDED, never merged into the structural builder: the
  // greenfield and promoted-plan branches of buildContextBootstrapProposals
  // return their own closed set, and a design contract must not change what
  // those projections mean.
  const proposals: BootstrapDocProposal[] = [
    ...(map
      ? buildContextBootstrapProposals(options.scope, map, proposalOptions)
      : []),
    ...(designProposal ? [designProposal] : []),
  ].filter(
    (proposal) =>
      !businessModelOwnsTarget || proposal.targetPath !== BUSINESS_MODEL_TARGET_PATH,
  );
  const isDesignProposal = (proposal: BootstrapDocProposal): boolean =>
    designProposal !== null && proposal.targetPath === designProposal.targetPath;
  // The design contract is mechanically reviewable by construction: it was
  // rendered from a pure function of scope + goal + settings in this very
  // pass, and the review step re-derives it before approving.
  const isMechanicallyReviewable = (proposal: BootstrapDocProposal): boolean =>
    isDesignProposal(proposal) ||
    isMechanicallyReviewableBootstrapProposal(
      options.scope,
      proposal,
      proposalOptions,
    );
  const proposalMeta = proposals.map((p) =>
    Object.freeze({
      targetPath: p.targetPath,
      rationale: p.rationale,
      sourceCount: p.sources.length,
      autoReviewable: isAutoReviewableBootstrapProposal(p),
      mechanicallyReviewable: isMechanicallyReviewable(p),
    }),
  );

  const proposedDraftIds: string[] = [];
  const outcomes: BootstrapDraftOutcome[] = [];
  const autoReviewQueue: string[] = [];
  const mechanicalReviewQueue: string[] = [];
  const appliedDraftIds: string[] =
    businessModel?.status === 'applied' && businessModel.draftId
      ? [businessModel.draftId]
      : [];
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
    const mechanicallyReviewable = isMechanicallyReviewable(proposal);
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
  //
  // THE DESIGN TARGET IS EXEMPT, ON PURPOSE (A1). This memory is a guard
  // against re-asking an OPINION that already said no — an independent CLI
  // reviewer given the same bytes will answer the same way, so re-proposing
  // burns budget for nothing. The design contract has no such reviewer: it is
  // verified by a deterministic re-derivation, and that verdict is a function
  // of the ENVIRONMENT at that instant, not of the content. Remembering it as
  // if it were an opinion is what turned one rejection into a permanently
  // blocked target with no product-level way out. Re-proposing here costs one
  // pure rebuild and no CLI, and it stops the moment the environment settles.
  const rejectedContentByTarget = new Map<string, Set<string>>();
  for (const draft of knowledge.list({ status: 'rejected' })) {
    if (draft.missionId !== null && draft.missionId !== (options.missionId ?? null)) continue;
    if (!proposalsByTarget.has(draft.targetPath)) continue;
    if (draft.targetPath === designTargetPath) continue;
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
      if (isMechanicallyReviewable(proposal)) {
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
      const isDesign = Boolean(proposal && isDesignProposal(proposal));
      // Independent re-derivation for the design draft: rebuild the contract
      // from scope + goal + settings a SECOND time and demand the same bytes.
      // Anything that drifted between propose and review (catalog edited,
      // setting changed, a contract appeared) breaks the match and rejects.
      const reDerived =
        isDesign && proposal
          ? await reDeriveDesignProposal(options, designTargetPath)
          : null;
      if (isDesign) throwIfBootstrapAborted(options.signal);
      // A re-derivation that could not RUN proves nothing. Leave the draft
      // proposed and retry next pass instead of converting a transient read
      // failure into a durable rejection (A1).
      if (reDerived?.kind === 'unavailable') {
        designReviewDeferredError = reDerived.error;
        throw new Error(
          `${DESIGN_CONTRACT_REVIEW_DEFERRED}: ${reDerived.error}`,
        );
      }
      if (
        !current ||
        !proposal ||
        (isDesign
          ? reDerived?.kind !== 'derived' ||
            !sameProposalBytes(reDerived.proposal, proposal)
          : !isMechanicallyReviewableBootstrapProposal(
              options.scope,
              proposal,
              proposalOptions,
            )) ||
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
            rationale: isDesign
              ? 'Rejected by fail-closed design-contract policy: a fresh re-derivation ran for this scope and goal and did not produce these bytes.'
              : 'Rejected by fail-closed canonical-source policy immediately before review: durable draft authority diverged from the sanctioned proposal.',
          });
          rejectedDraftIds.push(rejected.id);
        }
        throw new Error(
          isDesign
            ? 'design-contract mechanical review refused a non-reproducible durable draft'
            : 'canonical-source mechanical review refused a non-canonical durable draft',
        );
      }
      const source = proposal.sources[0]!;
      const reviewed = knowledge.review(draftId, {
        decision: 'approve',
        reviewer: isDesign
          ? DESIGN_CONTRACT_MECHANICAL_REVIEWER
          : CANONICAL_SOURCE_MECHANICAL_REVIEWER,
        rationale: isDesign
          ? `Approved by deterministic re-derivation: the design contract rebuilt from this scope and goal is byte-identical, and its first bound source ${source.locator}@${source.sourceHash} still hashes as stated. No third-party kit content is present.`
          : `Approved by deterministic read-only review: target bytes and sole sanctioned source ` +
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
        // The design contract never enters CLI review (see
        // DESIGN_CONTRACT_MECHANICAL_REVIEWER). A rejected design draft is
        // re-derived and re-proposed on the NEXT pass, not smuggled into a
        // reviewer whose method does not fit a prescriptive document.
        isDesignProposal(replacement) ||
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

  const designStatus = ((): DesignContractBootstrapOutcome['status'] => {
    if (!designProposal) return 'skipped';
    const outcome = outcomes.find(
      (item) => item.targetPath === designTargetPath,
    );
    if (!outcome) return 'skipped';
    if (outcome.status === 'applied') return 'applied';
    // A refused re-derivation records `review-failed` on the outcome while the
    // durable draft is genuinely rejected; read the rejection ledger, not just
    // the loop's local status, or the mission is told "proposed" about a draft
    // that will never be applied. A DEFERRED re-derivation also records
    // `review-failed`, but nothing was rejected — so it correctly falls through
    // to `proposed`, which is exactly what it is (A1).
    if (
      outcome.status === 'rejected' ||
      outcome.status === 'rejected-stable' ||
      (outcome.draftId !== '' && rejectedDraftIds.includes(outcome.draftId))
    ) {
      return 'rejected';
    }
    return 'proposed';
  })();

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
    designContract: designDecision
      ? designOutcome(
          designDecision,
          designTargetPath,
          designStatus,
          designOwnedByAnother ? 'foreign-active-draft' : null,
          designReviewDeferredError,
        )
      : null,
    businessModel,
  };
  return Object.freeze({
    ...base,
    autopilotHint: hintFor(base),
  });
}
