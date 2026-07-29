import type { ProjectExecutionScope } from '../../shared/types';
import type {
  MergeValidationContext,
  MergeValidationDecision,
} from '../runtime/merge-queue';
import { loadContextConfiguration } from './context-doctor';
import { CliAutomatedReviewer, type RunAutomatedReviewInput } from './cli-automated-reviewer';
import { SensorBroker, type TrustedEvidence } from './sensor-broker';
import { requireWorktreeRuntimeRegistry } from '../runtime/worktree-runtime-registry';
import { getProjectDomainStores } from '../orch/project-domain-store-registry';
import { assertMcpInvocationCurrent } from '../orch/mcp-protocol';
import {
  normalizeWorkflowIdentity,
  type ContextWorkflowService,
  type WorkflowIdentity,
} from './context-workflow-service';
import type {
  CandidateQualityAnalysis,
  RunCandidateQualityAnalysisInput,
} from './candidate-quality-scanner';
import { createCandidateQualityReviewReport } from './candidate-quality-review';

export interface MergeValidationCoordinatorDependencies {
  readonly runSensor?: (
    definitionScope: ProjectExecutionScope,
    input: {
      readonly missionId: string;
      readonly sensorId: string;
      readonly baseSha: string;
      readonly contractHash: string;
      readonly contextHash: string;
    },
    authority?: {
      readonly signal?: AbortSignal;
      readonly assertCurrentAuthority?: () => void;
    },
  ) => Promise<TrustedEvidence>;
  readonly runReview?: (
    input: RunAutomatedReviewInput,
  ) => ReturnType<CliAutomatedReviewer['run']>;
  readonly runCandidateQuality?: (
    input: RunCandidateQualityAnalysisInput,
  ) => Promise<CandidateQualityAnalysis>;
  readonly resolveAuthor?: (
    context: MergeValidationContext,
  ) => WorkflowIdentity;
  readonly loadPreExecutionReviewGuidance?: (
    context: MergeValidationContext,
  ) => string;
}

export class MergeValidationCoordinator {
  readonly #service: ContextWorkflowService;
  readonly #runSensor: NonNullable<MergeValidationCoordinatorDependencies['runSensor']>;
  readonly #runReview: NonNullable<MergeValidationCoordinatorDependencies['runReview']>;
  readonly #runCandidateQuality: NonNullable<
    MergeValidationCoordinatorDependencies['runCandidateQuality']
  >;
  readonly #resolveAuthor: NonNullable<MergeValidationCoordinatorDependencies['resolveAuthor']>;
  readonly #loadPreExecutionReviewGuidance: NonNullable<
    MergeValidationCoordinatorDependencies['loadPreExecutionReviewGuidance']
  >;

  constructor(
    service: ContextWorkflowService,
    dependencies: MergeValidationCoordinatorDependencies = {},
  ) {
    this.#service = service;
    const reviewer = new CliAutomatedReviewer();
    this.#runReview = dependencies.runReview ?? ((input) => reviewer.run(input));
    this.#runCandidateQuality =
      dependencies.runCandidateQuality ??
      (async (input) => {
        // Keep the TypeScript AST engine off the Electron startup path. It is
        // loaded only when a committed merge candidate actually needs review.
        const { runCandidateQualityAnalysis } = await import(
          './candidate-quality-scanner'
        );
        return runCandidateQualityAnalysis(input);
      });
    this.#resolveAuthor = dependencies.resolveAuthor ?? ((context) => {
      const worktree = requireWorktreeRuntimeRegistry().get(
        context.scope,
        context.missionId,
        context.taskId,
      );
      if (!worktree) throw new Error('merge task worktree is missing');
      const panes = getProjectDomainStores(context.scope).missionPanes.list(
        context.missionId,
      );
      const pane = panes.find(
        (candidate) =>
          candidate.role === 'worker' &&
          candidate.agentName === worktree.workerId &&
          candidate.cwd === worktree.worktreePath,
      );
      if (!pane) throw new Error('code author pane identity is missing');
      return normalizeWorkflowIdentity({
        id: worktree.workerId,
        sessionId: pane.paneId ?? pane.id,
        provider: pane.adapterId,
      });
    });
    this.#loadPreExecutionReviewGuidance =
      dependencies.loadPreExecutionReviewGuidance ??
      ((context) => {
        if (
          typeof this.#service.compilePreExecutionReviewGuidance !==
          'function'
        ) {
          return '';
        }
        const stores = getProjectDomainStores(context.scope);
        const approved = stores.missions.get(context.missionId);
        const intentVersion = approved?.intentContract?.intentVersion;
        const receipt =
          intentVersion === undefined
            ? null
            : stores.tasks.getPlanReceipt(context.missionId, intentVersion);
        return receipt
          ? this.#service.compilePreExecutionReviewGuidance(
              context.missionId,
              {
                intentVersion: receipt.intentVersion,
                planHash: receipt.planHash,
              },
            )
          : '';
      });
    this.#runSensor = dependencies.runSensor ?? (async (scope, input, authority) => {
      const config = loadContextConfiguration(this.#service.scope);
      return new SensorBroker(config.sensors).run({ scope, ...input }, authority);
    });
  }

  async validate(context: MergeValidationContext): Promise<MergeValidationDecision> {
    assertMcpInvocationCurrent(context);
    const mission = this.#service.getMissionWorkflow(context.missionId);
    if (!mission.contract || !mission.workflow) {
      throw new Error('merge validation mission has no frozen workflow');
    }
    if (mission.workflow.stage !== 'execution') {
      throw new Error('merge validation is allowed only during execution');
    }
    const contract = mission.contract.contract;
    const candidateScope: ProjectExecutionScope = Object.freeze({
      ...context.scope,
      rootRealPath: context.checkoutPath,
    });
    const binding = Object.freeze({
      projectId: context.scope.projectId,
      checkoutId: context.scope.checkoutId,
      missionId: context.missionId,
      contractHash: contract.contractHash,
      contextHash: contract.contextRevision,
      baseSha: context.integrationBaseSha,
      headSha: context.candidateSha,
      diffHash: context.diffHash,
    });
    const evidenceIds: string[] = [];
    let sensorsPassed = true;
    for (const sensorId of contract.requiredSensors) {
      const evidence = await this.#runSensor(candidateScope, {
        missionId: context.missionId,
        sensorId,
        baseSha: context.integrationBaseSha,
        contractHash: contract.contractHash,
        contextHash: contract.contextRevision,
      }, context);
      assertMcpInvocationCurrent(context);
      if (
        evidence.baseSha !== binding.baseSha ||
        evidence.headSha !== binding.headSha ||
        evidence.diffHash !== binding.diffHash
      ) {
        throw new Error('merge sensor returned evidence for another candidate');
      }
      assertMcpInvocationCurrent(context);
      this.#service.recordMergeSensorEvidence(evidence);
      evidenceIds.push(evidence.id);
      if (evidence.exitCode !== 0 || evidence.timedOut) sensorsPassed = false;
    }
    if (!sensorsPassed) {
      assertMcpInvocationCurrent(context);
      return Object.freeze({
        sensorsPassed: false,
        reviewPassed: false,
        evidenceIds: Object.freeze(evidenceIds),
      });
    }

    if (context.phase === 'post-integration') {
      assertMcpInvocationCurrent(context);
      const persistedGate = this.#service.inspectPersistedReviewGate(binding);
      assertMcpInvocationCurrent(context);
      evidenceIds.push(...persistedGate.evidenceIds);
      if (persistedGate.ready) {
        return Object.freeze({
          sensorsPassed: true,
          reviewPassed: true,
          evidenceIds: Object.freeze([...new Set(evidenceIds)]),
        });
      }
      // Concrete findings and reviewer disagreement remain authoritative.
      // An incomplete quorum — including a partially persisted critical-risk
      // review — must continue with a fresh physical council.
      if (persistedGate.reason !== 'review-quorum-missing') {
        return Object.freeze({
          sensorsPassed: true,
          reviewPassed: false,
          evidenceIds: Object.freeze([...new Set(evidenceIds)]),
        });
      }
    }

    const author = this.#resolveAuthor(context);
    let candidateQualityMarkdown = '';
    if (context.phase === 'candidate') {
      try {
        const analysis = await this.#runCandidateQuality({
          scope: context.scope,
          checkoutPath: context.checkoutPath,
          baseSha: context.integrationBaseSha,
          headSha: context.candidateSha,
          diffHash: context.diffHash,
          changedFiles: context.changedFiles,
          ...(context.signal ? { signal: context.signal } : {}),
        });
        assertMcpInvocationCurrent(context);
        const report = createCandidateQualityReviewReport({
          risk: contract.risk,
          binding,
          author,
          analysis,
        });
        assertMcpInvocationCurrent(context);
        this.#service.recordMergeReviewReport(report);
        evidenceIds.push(`review:${report.reviewId}`);
        candidateQualityMarkdown = analysis.reviewerMarkdown;
        if (
          analysis.findings.some(
            (finding) =>
              finding.severity === 'critical' || finding.severity === 'high',
          )
        ) {
          return Object.freeze({
            sensorsPassed: true,
            reviewPassed: false,
            evidenceIds: Object.freeze([...new Set(evidenceIds)]),
          });
        }
      } catch (error) {
        // The independent physical reviewer remains authoritative when this
        // bounded advisory analyzer cannot inspect an unusual repository. An
        // authority revocation still propagates through this assertion.
        assertMcpInvocationCurrent(context);
        const detail = error instanceof Error ? error.message : String(error);
        candidateQualityMarkdown = [
          '## Main-owned candidate quality preflight',
          'Status: unavailable — continue with independent manual inspection.',
          `Reason: ${detail.replace(/[\0\r\n]/gu, ' ').slice(0, 512)}`,
          '',
          'Explicitly inspect unreachable/dead code, duplicated functions or exported APIs, process/module boundaries, integration blast radius, and missing tests or line-coverage evidence.',
        ].join('\n');
        console.warn('[merge-quality] bounded candidate analysis unavailable:', detail);
      }
    }

    assertMcpInvocationCurrent(context);
    const contextMarkdown = this.#service.compileMissionSnapshot(
      context.missionId,
    ).markdown;
    const preExecutionGuidance =
      context.phase === 'candidate'
        ? this.#loadPreExecutionReviewGuidance(context)
        : '';
    const review = await this.#runReview({
      scope: context.scope,
      checkoutPath: context.checkoutPath,
      contract,
      binding,
      author,
      reviewPurpose: 'candidate',
      designInspection: 'required',
      contextMarkdown: [
        contextMarkdown,
        preExecutionGuidance,
        candidateQualityMarkdown,
      ].filter(Boolean).join('\n\n'),
      persist: (report) => {
        assertMcpInvocationCurrent(context);
        this.#service.recordMergeReviewReport(report);
      },
      ...(context.signal ? { signal: context.signal } : {}),
      ...(context.assertCurrentAuthority
        ? { assertCurrentAuthority: context.assertCurrentAuthority }
        : {}),
    });
    assertMcpInvocationCurrent(context);
    evidenceIds.push(...review.evidenceIds);
    return Object.freeze({
      sensorsPassed: true,
      reviewPassed: review.ready,
      evidenceIds: Object.freeze([...new Set(evidenceIds)]),
    });
  }
}
