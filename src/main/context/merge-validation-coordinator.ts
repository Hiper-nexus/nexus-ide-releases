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
import {
  normalizeWorkflowIdentity,
  type ContextWorkflowService,
  type WorkflowIdentity,
} from './context-workflow-service';

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
  ) => Promise<TrustedEvidence>;
  readonly runReview?: (
    input: RunAutomatedReviewInput,
  ) => ReturnType<CliAutomatedReviewer['run']>;
  readonly resolveAuthor?: (
    context: MergeValidationContext,
  ) => WorkflowIdentity;
}

export class MergeValidationCoordinator {
  readonly #service: ContextWorkflowService;
  readonly #runSensor: NonNullable<MergeValidationCoordinatorDependencies['runSensor']>;
  readonly #runReview: NonNullable<MergeValidationCoordinatorDependencies['runReview']>;
  readonly #resolveAuthor: NonNullable<MergeValidationCoordinatorDependencies['resolveAuthor']>;

  constructor(
    service: ContextWorkflowService,
    dependencies: MergeValidationCoordinatorDependencies = {},
  ) {
    this.#service = service;
    const reviewer = new CliAutomatedReviewer();
    this.#runReview = dependencies.runReview ?? ((input) => reviewer.run(input));
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
    this.#runSensor = dependencies.runSensor ?? (async (scope, input) => {
      const config = loadContextConfiguration(this.#service.scope);
      return new SensorBroker(config.sensors).run({ scope, ...input });
    });
  }

  async validate(context: MergeValidationContext): Promise<MergeValidationDecision> {
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
      });
      if (
        evidence.baseSha !== binding.baseSha ||
        evidence.headSha !== binding.headSha ||
        evidence.diffHash !== binding.diffHash
      ) {
        throw new Error('merge sensor returned evidence for another candidate');
      }
      this.#service.recordMergeSensorEvidence(evidence);
      evidenceIds.push(evidence.id);
      if (evidence.exitCode !== 0 || evidence.timedOut) sensorsPassed = false;
    }
    if (!sensorsPassed) {
      return Object.freeze({
        sensorsPassed: false,
        reviewPassed: false,
        evidenceIds: Object.freeze(evidenceIds),
      });
    }

    const review = await this.#runReview({
      scope: context.scope,
      checkoutPath: context.checkoutPath,
      contract,
      binding,
      author: this.#resolveAuthor(context),
      contextMarkdown: this.#service.compileMissionSnapshot(context.missionId).markdown,
      persist: (report) => {
        this.#service.recordMergeReviewReport(report);
      },
    });
    evidenceIds.push(...review.evidenceIds);
    return Object.freeze({
      sensorsPassed: true,
      reviewPassed: review.ready,
      evidenceIds: Object.freeze([...new Set(evidenceIds)]),
    });
  }
}
