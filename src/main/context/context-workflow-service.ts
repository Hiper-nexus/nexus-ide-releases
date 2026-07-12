import { createHash, randomUUID } from 'node:crypto';
import type { ProjectExecutionScope } from '../../shared/types';
import type { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import { createScopedMissionStore } from '../orch/mission-store';
import {
  compileMissionContract,
  type AcceptanceCriterion,
  type MissionContract,
  type WorkflowStage,
} from './contract-compiler';
import {
  ensureContextScaffold,
  inspectContextReadiness,
  loadContextConfiguration,
  type ContextReadinessReport,
} from './context-doctor';
import {
  createContextWorkflowStore,
  type StoredMissionContract,
  type WorkflowActorIdentity,
} from './context-workflow-store';
import { EventLedger } from './event-ledger';
import { inspectGitBinding, bindingMatchesGit, type GitBindingSnapshot } from './git-binding';
import { createWorkflowState, type EvidenceBinding, type WorkflowEvidence, type WorkflowState } from './prevc-engine';
import {
  ReviewCouncil,
  reviewSubmissionFromReport,
  type ReviewFindingInput,
  type ReviewGateResult,
  type ReviewReport,
} from './review-council';
import { SensorBroker, type TrustedEvidence } from './sensor-broker';
import { createSqliteEventLedgerStorage } from './sqlite-event-ledger-storage';
import { buildProjectSymbolIndex } from './symbol-index';
import { ingestProjectContext } from './context-ingestor';
import { detectContextConflicts } from './ambiguity-engine';
import { compileContextSnapshot, type ContextSnapshot } from './snapshot-compiler';
import {
  computeBlastRadius,
  ensureBlastRadius,
} from './orientation/orientation-blast-radius';
import { tryGetProjectOrientationService } from './orientation/orientation-service';

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

export interface MissionContractDraft {
  readonly missionId: string;
  readonly goal: string;
  readonly nonGoals?: readonly string[];
  readonly acceptanceCriteria: readonly AcceptanceCriterion[];
  readonly businessInvariantRefs?: readonly string[];
  readonly impactedDomains?: readonly string[];
  readonly impactedSymbols?: readonly string[];
  readonly requestedSensors?: readonly string[];
  readonly requiredArtifacts?: readonly string[];
  readonly riskHints?: readonly string[];
}

export interface WorkflowIdentity extends WorkflowActorIdentity {}

export interface IntegratedMissionResult {
  readonly worktreeId: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly diffHash: string;
}

export interface ContextWorkflowServiceDependencies {
  readonly appVersion: string;
  readonly inspectGit?: (
    scope: ProjectExecutionScope,
    baseSha?: string,
  ) => GitBindingSnapshot;
  readonly resolveIntegratedMission?: (
    scope: ProjectExecutionScope,
    missionId: string,
    baseSha: string,
  ) => IntegratedMissionResult | null;
  readonly now?: () => number;
  readonly makeId?: () => string;
}

export interface FrozenMissionWorkflow {
  readonly contract: MissionContract;
  readonly workflow: WorkflowState;
  readonly readiness: ContextReadinessReport;
}

export interface SubmitReviewInput {
  readonly missionId: string;
  readonly reviewer: WorkflowIdentity;
  readonly findings: readonly ReviewFindingInput[];
}

export interface SubmitReviewResult {
  readonly report: ReviewReport;
  readonly gate: ReviewGateResult;
}

export class ContextReadinessError extends Error {
  readonly report: ContextReadinessReport;

  constructor(report: ContextReadinessReport) {
    super(`project context is not ready: ${report.blockers.map((item) => item.code).join(', ')}`);
    this.name = 'ContextReadinessError';
    this.report = report;
  }
}

function stableIdentifier(value: string, prefix: string): string {
  const trimmed = value.trim();
  if (IDENTIFIER.test(trimmed)) return trimmed;
  return `${prefix}:${createHash('sha256').update(trimmed).digest('hex').slice(0, 32)}`;
}

export function normalizeWorkflowIdentity(identity: WorkflowIdentity): WorkflowIdentity {
  return Object.freeze({
    id: stableIdentifier(identity.id, 'actor'),
    sessionId: stableIdentifier(identity.sessionId, 'session'),
    provider: stableIdentifier(identity.provider, 'provider'),
  });
}

function bindingFor(
  contract: MissionContract,
  git: GitBindingSnapshot,
): EvidenceBinding {
  return Object.freeze({
    projectId: contract.projectId,
    checkoutId: contract.checkoutId,
    missionId: contract.missionId,
    contractHash: contract.contractHash,
    contextHash: contract.contextRevision,
    baseSha: git.baseSha,
    headSha: git.headSha,
    diffHash: git.diffHash,
  });
}

function reportSeverities(reports: readonly ReviewReport[]): WorkflowEvidence['openFindingSeverities'] {
  return Object.freeze(
    reports.flatMap((report) => report.findings)
      .filter((finding) => finding.status === 'open')
      .map((finding) => finding.severity),
  );
}

export class ContextWorkflowService {
  readonly scope: ProjectExecutionScope;
  readonly #runtimeManager: ProjectRuntimeManager;
  readonly #store: ReturnType<typeof createContextWorkflowStore>;
  readonly #missions: ReturnType<typeof createScopedMissionStore>;
  readonly #ledger: EventLedger;
  readonly #dependencies: ContextWorkflowServiceDependencies;

  constructor(
    runtimeManager: ProjectRuntimeManager,
    scope: ProjectExecutionScope,
    dependencies: ContextWorkflowServiceDependencies,
  ) {
    if (!dependencies.appVersion.trim()) throw new Error('workflow appVersion is required');
    this.scope = Object.freeze({ ...scope });
    this.#runtimeManager = runtimeManager;
    this.#store = createContextWorkflowStore(runtimeManager, this.scope, {
      now: dependencies.now,
    });
    this.#missions = createScopedMissionStore(runtimeManager, this.scope, {
      now: dependencies.now,
    });
    this.#dependencies = dependencies;
    this.#ledger = new EventLedger(
      createSqliteEventLedgerStorage(runtimeManager, this.scope),
      { now: dependencies.now, makeId: dependencies.makeId },
    );
  }

  inspectReadiness(): ContextReadinessReport {
    const orientation = tryGetProjectOrientationService()?.get(this.scope);
    // Cached maps only reconstruct hubs into the symbol set; if empty, fall
    // back to a full symbol index so stale-symbol checks stay meaningful.
    const fromMap = orientation?.symbols.symbols;
    const symbols =
      fromMap && fromMap.size > 0
        ? fromMap
        : buildProjectSymbolIndex(this.scope).symbols;
    return inspectContextReadiness(this.scope, { knownSymbols: symbols });
  }

  scaffold(): ReturnType<typeof ensureContextScaffold> {
    return ensureContextScaffold(this.scope);
  }

  /**
   * Auto-pilot enrichment: fill empty impacted symbols/domains from the
   * structural orientation map (never overrides explicit caller values).
   */
  async enrichDraftFromOrientation(
    draft: MissionContractDraft,
  ): Promise<MissionContractDraft> {
    const hasSymbols = (draft.impactedSymbols?.length ?? 0) > 0;
    const hasDomains = (draft.impactedDomains?.length ?? 0) > 0;
    if (hasSymbols && hasDomains) return draft;
    try {
      const radius = await ensureBlastRadius(this.scope, {
        goal: draft.goal,
        seedSymbols: draft.impactedSymbols,
      });
      return Object.freeze({
        ...draft,
        impactedSymbols: hasSymbols
          ? draft.impactedSymbols
          : radius.symbols.length > 0
            ? radius.symbols
            : draft.impactedSymbols,
        impactedDomains: hasDomains
          ? draft.impactedDomains
          : radius.domains.length > 0
            ? radius.domains
            : draft.impactedDomains,
      });
    } catch {
      return draft;
    }
  }

  freezeContract(
    draft: MissionContractDraft,
    rawAuthor: WorkflowIdentity,
  ): FrozenMissionWorkflow {
    if (!this.#missions.get(draft.missionId)) throw new Error('mission not found');
    if (this.#store.getContract(draft.missionId)) {
      throw new Error('mission contract is already frozen');
    }
    // Warm orientation cache for blast-radius (fire and forget if cold).
    void tryGetProjectOrientationService()
      ?.ensure(this.scope, { reason: 'pre-kickoff', waitMs: 0 })
      .catch(() => undefined);
    const readiness = this.inspectReadiness();
    if (!readiness.ready || !readiness.contextRevision) {
      throw new ContextReadinessError(readiness);
    }
    const config = loadContextConfiguration(this.scope);
    const corpus = ingestProjectContext(this.scope);
    const invariantRefs = new Set(
      corpus.facts.filter((fact) => fact.category === 'invariant')
        .map((fact) => fact.id),
    );
    // Sync enrichment from warm cache when caller left symbols/domains empty.
    let impactedSymbols = draft.impactedSymbols ? [...draft.impactedSymbols] : [];
    let impactedDomains = draft.impactedDomains ? [...draft.impactedDomains] : [];
    if (impactedSymbols.length === 0 || impactedDomains.length === 0) {
      const map = tryGetProjectOrientationService()?.get(this.scope);
      if (map) {
        const radius = computeBlastRadius(map, {
          goal: draft.goal,
          seedSymbols: impactedSymbols,
        });
        if (impactedSymbols.length === 0) impactedSymbols = [...radius.symbols];
        if (impactedDomains.length === 0) impactedDomains = [...radius.domains];
      }
    }
    const git = (this.#dependencies.inspectGit ?? inspectGitBinding)(this.scope);
    const contract = compileMissionContract(
      {
        schemaVersion: 1,
        scope: this.scope,
        missionId: draft.missionId,
        baseCommit: git.baseSha,
        contextRevision: readiness.contextRevision,
        goal: draft.goal,
        nonGoals: draft.nonGoals ? [...draft.nonGoals] : [],
        acceptanceCriteria: draft.acceptanceCriteria.map((criterion) => ({
          id: criterion.id,
          statement: criterion.statement,
          requiredSensorIds: [...criterion.requiredSensorIds],
          invariantRefs: [...criterion.invariantRefs],
          requiredArtifactIds: [...criterion.requiredArtifactIds],
        })),
        businessInvariantRefs: draft.businessInvariantRefs
          ? [...draft.businessInvariantRefs]
          : [],
        impactedDomains,
        impactedSymbols,
        requestedSensors: [
          ...new Set([
            'typecheck',
            'unit',
            ...(draft.requestedSensors ?? []),
          ]),
        ],
        requiredArtifacts: draft.requiredArtifacts ? [...draft.requiredArtifacts] : [],
        riskHints: draft.riskHints ? [...draft.riskHints] : [],
      },
      {
        invariantRefs,
        availableSensorIds: new Set(config.sensors.map((sensor) => sensor.id)),
        blockingConflictIds: readiness.blockers
          .filter((blocker) => blocker.code === 'context-conflict')
          .flatMap((blocker) => blocker.details ?? []),
      },
    );
    const workflow = createWorkflowState(contract.risk, bindingFor(contract, git));
    const author = normalizeWorkflowIdentity(rawAuthor);
    this.#store.freeze(contract, workflow, author);
    this.#ledger.append({
      projectId: this.scope.projectId,
      checkoutId: this.scope.checkoutId,
      missionId: contract.missionId,
      type: 'contract-frozen',
      actor: { kind: 'agent', id: author.id },
      payload: {
        risk: contract.risk,
        baseSha: contract.baseCommit,
        criterionIds: contract.acceptanceCriteria.map((criterion) => criterion.id),
      },
      versions: {
        appVersion: this.#dependencies.appVersion,
        contextHash: contract.contextRevision,
        contractHash: contract.contractHash,
        policyHash: config.policyHash,
        evaluatorVersion: 'prevc-v1',
      },
    });
    return Object.freeze({ contract, workflow, readiness });
  }

  getMissionWorkflow(missionId: string): {
    readonly contract: StoredMissionContract | null;
    readonly workflow: WorkflowState | null;
  } {
    return Object.freeze({
      contract: this.#store.getContract(missionId),
      workflow: this.#store.getWorkflow(missionId),
    });
  }

  compileMissionSnapshot(missionId: string): ContextSnapshot {
    const stored = this.#store.getContract(missionId);
    if (!stored) throw new Error('mission has no frozen contract');
    this.#assertContextCurrent(stored.contract);
    const corpus = ingestProjectContext(this.scope);
    const orientation = tryGetProjectOrientationService()?.get(this.scope);
    const fromMap = orientation?.symbols.symbols;
    const knownSymbols =
      fromMap && fromMap.size > 0
        ? fromMap
        : buildProjectSymbolIndex(this.scope).symbols;
    const conflicts = detectContextConflicts({
      facts: corpus.facts,
      requiredFactIds: stored.contract.businessInvariantRefs,
      knownSymbols,
      impactedDomains: stored.contract.impactedDomains,
    });
    const snapshot = compileContextSnapshot({
      projectId: this.scope.projectId,
      checkoutId: this.scope.checkoutId,
      contextRevision: stored.contract.contextRevision,
      goal: stored.contract.goal,
      impactedDomains: stored.contract.impactedDomains,
      impactedSymbols: stored.contract.impactedSymbols,
      requiredFactIds: stored.contract.businessInvariantRefs,
      facts: corpus.facts,
      conflicts,
      regressions: corpus.facts
        .filter((fact) => fact.category === 'regression')
        .map((fact) => fact.statement),
      requiredSensors: stored.contract.requiredSensors,
    });
    if (!orientation) return snapshot;
    const radius = computeBlastRadius(orientation, {
      goal: stored.contract.goal,
      seedSymbols: stored.contract.impactedSymbols,
    });
    const orientationBlock = [
      '',
      '## Structural orientation (auto — not business authority)',
      `- Map: ${orientation.mapHash.slice(0, 12)} · status ${orientation.status}`,
      `- Graph: ${orientation.graph.mode} · ${orientation.graph.edgeCount} edges`,
      `- Blast files: ${radius.files.slice(0, 12).join(', ') || 'none'}`,
      `- Hubs: ${radius.hubs.slice(0, 10).join(', ') || 'none'}`,
    ].join('\n');
    const markdown = `${snapshot.markdown}${orientationBlock}`;
    return Object.freeze({
      ...snapshot,
      markdown,
      // Keep original contextHash — orientation is advisory decoration only.
    });
  }

  #assertContextCurrent(contract: MissionContract): ContextReadinessReport {
    const readiness = this.inspectReadiness();
    if (
      !readiness.ready ||
      !readiness.contextRevision ||
      readiness.contextRevision !== contract.contextRevision
    ) {
      throw new ContextReadinessError(readiness);
    }
    return readiness;
  }

  async runSensor(missionId: string, sensorId: string): Promise<TrustedEvidence> {
    const stored = this.#store.getContract(missionId);
    const workflow = this.#store.getWorkflow(missionId);
    if (!stored || !workflow) throw new Error('mission has no frozen workflow');
    if (!workflow.stage.startsWith('validation') && workflow.stage !== 'confirmation') {
      throw new Error('trusted sensors run only during validation or confirmation');
    }
    this.#assertContextCurrent(stored.contract);
    const config = loadContextConfiguration(this.scope);
    const broker = new SensorBroker(config.sensors);
    this.#ledger.append({
      projectId: this.scope.projectId,
      checkoutId: this.scope.checkoutId,
      missionId,
      type: 'sensor-started',
      actor: { kind: 'sensor', id: stableIdentifier(sensorId, 'sensor') },
      payload: { sensorId },
      versions: {
        appVersion: this.#dependencies.appVersion,
        contextHash: stored.contract.contextRevision,
        contractHash: stored.contract.contractHash,
        policyHash: config.policyHash,
      },
    });
    try {
      const evidence = await broker.run({
        scope: this.scope,
        missionId,
        sensorId,
        baseSha: stored.contract.baseCommit,
        contractHash: stored.contract.contractHash,
        contextHash: stored.contract.contextRevision,
      });
      if (
        evidence.headSha !== workflow.binding.headSha ||
        evidence.diffHash !== workflow.binding.diffHash
      ) {
        throw new Error('sensor result does not match the integrated workflow diff');
      }
      this.#store.recordSensorEvidence(evidence);
      this.#ledger.append({
        projectId: this.scope.projectId,
        checkoutId: this.scope.checkoutId,
        missionId,
        type: 'sensor-finished',
        actor: { kind: 'sensor', id: stableIdentifier(sensorId, 'sensor') },
        payload: { evidenceId: evidence.id, sensorId, passed: evidence.exitCode === 0 && !evidence.timedOut },
        versions: {
          appVersion: this.#dependencies.appVersion,
          contextHash: stored.contract.contextRevision,
          contractHash: stored.contract.contractHash,
          policyHash: config.policyHash,
        },
      });
      return evidence;
    } catch (error) {
      this.#ledger.append({
        projectId: this.scope.projectId,
        checkoutId: this.scope.checkoutId,
        missionId,
        type: 'sensor-finished',
        actor: { kind: 'sensor', id: stableIdentifier(sensorId, 'sensor') },
        payload: { sensorId, passed: false, errorType: error instanceof Error ? error.name : 'UnknownError' },
        versions: {
          appVersion: this.#dependencies.appVersion,
          contextHash: stored.contract.contextRevision,
          contractHash: stored.contract.contractHash,
          policyHash: config.policyHash,
        },
      });
      throw error;
    }
  }

  recordMergeSensorEvidence(evidence: TrustedEvidence): TrustedEvidence {
    const stored = this.#store.getContract(evidence.missionId);
    if (!stored) throw new Error('merge evidence mission has no frozen contract');
    const recorded = this.#store.recordMergeSensorEvidence(evidence);
    this.#ledger.append({
      projectId: this.scope.projectId,
      checkoutId: this.scope.checkoutId,
      missionId: evidence.missionId,
      type: 'sensor-finished',
      actor: { kind: 'sensor', id: stableIdentifier(evidence.sensorId, 'sensor') },
      payload: {
        evidenceId: evidence.id,
        sensorId: evidence.sensorId,
        mergeCandidate: true,
        passed: evidence.exitCode === 0 && !evidence.timedOut,
      },
      versions: {
        appVersion: this.#dependencies.appVersion,
        contextHash: stored.contract.contextRevision,
        contractHash: stored.contract.contractHash,
      },
    });
    return recorded;
  }

  recordMergeReviewReport(report: ReviewReport): ReviewReport {
    const recorded = this.#store.recordMergeReviewReport(report);
    const stored = this.#store.getContract(report.binding.missionId);
    if (!stored) throw new Error('merge review mission has no frozen contract');
    this.#ledger.append({
      projectId: this.scope.projectId,
      checkoutId: this.scope.checkoutId,
      missionId: report.binding.missionId,
      type: 'review-finding',
      actor: { kind: 'reviewer', id: report.reviewerId },
      payload: {
        reviewId: report.reviewId,
        mergeCandidate: true,
        findingCount: report.findings.length,
        severities: report.findings.map((finding) => finding.severity),
      },
      versions: {
        appVersion: this.#dependencies.appVersion,
        contextHash: stored.contract.contextRevision,
        contractHash: stored.contract.contractHash,
      },
    });
    return recorded;
  }

  listPersistedEvidenceIds(missionId: string): readonly string[] {
    if (!this.#store.getContract(missionId)) {
      throw new Error('evidence mission has no frozen contract');
    }
    return Object.freeze([
      ...this.#store.listSensorEvidence(missionId).map((evidence) => evidence.id),
      ...this.#store.listReviewReports(missionId).map((report) => `review:${report.reviewId}`),
    ].sort());
  }

  #listPersistedArtifactIds(missionId: string): readonly string[] {
    const rows = this.#runtimeManager.open(this.scope).db
      .prepare(
        `SELECT id FROM media_artifacts WHERE mission_id = ?
         UNION ALL
         SELECT id FROM browser_artifacts WHERE mission_id = ?`,
      )
      .all(missionId, missionId) as Array<{ id: string }>;
    return Object.freeze([...new Set(rows.map((row) => row.id))].sort());
  }

  submitReview(input: SubmitReviewInput): SubmitReviewResult {
    const stored = this.#store.getContract(input.missionId);
    const workflow = this.#store.getWorkflow(input.missionId);
    if (!stored || !workflow) throw new Error('mission has no frozen workflow');
    if (
      workflow.stage !== 'review-primary' &&
      workflow.stage !== 'review-secondary' &&
      !workflow.stage.startsWith('validation') &&
      workflow.stage !== 'confirmation'
    ) {
      throw new Error('review is not accepted in the current workflow stage');
    }
    this.#assertContextCurrent(stored.contract);
    const reviewer = normalizeWorkflowIdentity(input.reviewer);
    const council = new ReviewCouncil(stored.contract.risk, workflow.binding);
    for (const report of this.#store.listReviewReports(input.missionId, workflow.binding.diffHash)) {
      council.submit(reviewSubmissionFromReport(report));
    }
    const report = council.submit({
      reviewId: stableIdentifier(
        this.#dependencies.makeId?.() ?? randomUUID(),
        'review',
      ),
      reviewerId: reviewer.id,
      reviewerSessionId: reviewer.sessionId,
      reviewerProvider: reviewer.provider,
      authorId: stored.author.id,
      authorSessionId: stored.author.sessionId,
      authorProvider: stored.author.provider,
      binding: workflow.binding,
      findings: [...input.findings],
    });
    this.#store.recordReviewReport(report);
    this.#ledger.append({
      projectId: this.scope.projectId,
      checkoutId: this.scope.checkoutId,
      missionId: input.missionId,
      type: 'review-finding',
      actor: { kind: 'reviewer', id: reviewer.id },
      payload: {
        reviewId: report.reviewId,
        findingCount: report.findings.length,
        severities: report.findings.map((finding) => finding.severity),
      },
      versions: {
        appVersion: this.#dependencies.appVersion,
        contextHash: stored.contract.contextRevision,
        contractHash: stored.contract.contractHash,
        evaluatorVersion: 'review-council-v1',
      },
    });
    return Object.freeze({ report, gate: council.evaluate() });
  }

  advance(missionId: string, requestedNext: WorkflowStage): WorkflowState {
    const stored = this.#store.getContract(missionId);
    const current = this.#store.getWorkflow(missionId);
    if (!stored || !current) throw new Error('mission has no frozen workflow');
    const readiness = this.#assertContextCurrent(stored.contract);
    let binding = current.binding;
    let worktreeId: string | undefined;
    if (current.stage === 'execution') {
      const integration = this.#dependencies.resolveIntegratedMission?.(
        this.scope,
        missionId,
        stored.contract.baseCommit,
      );
      if (!integration) throw new Error('mission has no trusted integrated worktree result');
      if (integration.baseSha !== stored.contract.baseCommit) {
        throw new Error('integrated worktree base does not match contract');
      }
      binding = Object.freeze({
        ...current.binding,
        headSha: integration.headSha,
        diffHash: integration.diffHash,
      });
      worktreeId = integration.worktreeId;
    }

    const reports = this.#store.listReviewReports(missionId, binding.diffHash);
    const council = new ReviewCouncil(stored.contract.risk, binding);
    for (const report of reports) council.submit(reviewSubmissionFromReport(report));
    const unusedReviewer = reports.find(
      (report) => !current.reviewers.some((reviewer) => reviewer.id === report.reviewerId),
    );
    if (
      (current.stage === 'review-primary' || current.stage === 'review-secondary') &&
      !unusedReviewer
    ) {
      throw new Error('independent review for the current binding is missing');
    }

    let integrated: GitBindingSnapshot | null = null;
    if (current.stage.startsWith('validation') || current.stage === 'confirmation') {
      const gate = council.evaluate();
      if (!gate.ready) throw new Error(`review council blocked: ${gate.reason}`);
      integrated = (this.#dependencies.inspectGit ?? inspectGitBinding)(
        this.scope,
        stored.contract.baseCommit,
      );
      if (!bindingMatchesGit(binding, integrated)) {
        throw new Error('integrated checkout no longer matches the reviewed diff');
      }
    }

    const evidenceRows = this.#store.listSensorEvidence(missionId).filter(
      (item) =>
        item.exitCode === 0 &&
        !item.timedOut &&
        item.baseSha === binding.baseSha &&
        item.headSha === binding.headSha &&
        item.diffHash === binding.diffHash &&
        item.contractHash === binding.contractHash &&
        item.contextHash === binding.contextHash,
    );
    const requiredArtifactIds = [...new Set([
      ...stored.contract.requiredArtifacts,
      ...stored.contract.acceptanceCriteria.flatMap(
        (criterion) => criterion.requiredArtifactIds,
      ),
    ])].sort();
    const evidence: WorkflowEvidence = {
      binding,
      blockingConflictIds: readiness.blockers
        .filter((blocker) => blocker.code === 'context-conflict')
        .flatMap((blocker) => blocker.details ?? []),
      openFindingSeverities: reportSeverities(reports),
      trustedSensorIds: evidenceRows.map((item) => item.sensorId),
      requiredSensorIds: stored.contract.requiredSensors,
      trustedArtifactIds: this.#listPersistedArtifactIds(missionId),
      requiredArtifactIds,
      authorId: stored.author.id,
      authorProvider: stored.author.provider,
      reviewerId: unusedReviewer?.reviewerId,
      reviewerProvider: unusedReviewer?.reviewerProvider,
      worktreeId,
      integratedHeadSha: integrated?.headSha,
      integratedDiffHash: integrated?.diffHash,
    };
    const next = this.#store.advance(
      missionId,
      current.revision,
      evidence,
      requestedNext,
    );
    if (next.stage === 'execution') this.#missions.setStatus(missionId, 'running');
    if (next.stage === 'complete') this.#missions.setStatus(missionId, 'done');
    this.#ledger.append({
      projectId: this.scope.projectId,
      checkoutId: this.scope.checkoutId,
      missionId,
      type: 'workflow-transition',
      actor: { kind: 'nexus', id: 'nexus' },
      payload: { from: current.stage, to: next.stage, revision: next.revision },
      versions: {
        appVersion: this.#dependencies.appVersion,
        contextHash: stored.contract.contextRevision,
        contractHash: stored.contract.contractHash,
        evaluatorVersion: 'prevc-v1',
      },
    });
    return next;
  }

  assertMutationAllowed(
    missionId: string,
    toolName: string,
    args: Readonly<Record<string, unknown>>,
  ): void {
    const stored = this.#store.getContract(missionId);
    const workflow = this.#store.getWorkflow(missionId);
    if (!stored || !workflow) {
      throw new Error('code mutation blocked until mission context and contract are frozen');
    }
    this.#assertContextCurrent(stored.contract);
    if (workflow.stage !== 'execution') {
      throw new Error(`code mutation blocked during workflow stage ${workflow.stage}`);
    }
    const pathValue = typeof args.path === 'string' ? args.path.replaceAll('\\', '/') : '';
    if (
      pathValue === '.context' ||
      pathValue.startsWith('.context/')
    ) {
      throw new Error('versioned context authority is read-only to executors');
    }
    if (toolName === 'nexus_git_push' || toolName === 'nexus_git_pull') {
      throw new Error('mission Git integration must use the Nexus merge queue');
    }
  }
}
