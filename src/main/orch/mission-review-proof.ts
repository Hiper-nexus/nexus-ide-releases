import type { Mission } from '../../shared/orch-types';
import type { ProjectExecutionScope } from '../../shared/types';
import { getContextWorkflowService } from '../context/context-workflow-registry';
import type { ContextWorkflowService, PersistedReviewGateInspection } from '../context/context-workflow-service';
import { bindingMatchesGit, inspectGitBinding } from '../context/git-binding';
import type { ReviewBinding } from '../context/review-council';
import { sameProjectExecutionScope } from './project-domain-store-registry';

type ReviewMission = Pick<Mission, 'id' | 'intentVersion' | 'updatedAt' | 'intentState' | 'intentContract'>;
type WorkflowSnapshot = ReturnType<ContextWorkflowService['getMissionWorkflow']>;
type ReviewService = Pick<ContextWorkflowService, 'scope' | 'getMissionWorkflow' | 'inspectPersistedReviewGate'>;

export interface FrozenMissionReviewContext {
  readonly service: ReviewService;
  readonly contract: NonNullable<WorkflowSnapshot['contract']>;
  readonly workflow: NonNullable<WorkflowSnapshot['workflow']>;
}

export interface FrozenMissionReviewProof {
  readonly binding: Readonly<ReviewBinding>;
  readonly candidateCurrent: boolean;
  readonly gate: PersistedReviewGateInspection;
}

interface ProofAuthority {
  readonly scope: ProjectExecutionScope;
  readonly mission: ReviewMission;
}

const issuedProofs = new WeakMap<object, ProofAuthority>();

/** Absence is compatible with fast-lane missions; corruption is never absence. */
export function readFrozenMissionReviewContext(
  scope: ProjectExecutionScope,
  missionId: string,
  getService: (scope: ProjectExecutionScope) => ReviewService = getContextWorkflowService,
): FrozenMissionReviewContext | null {
  let service: ReviewService;
  try {
    service = getService(scope);
  } catch (error) {
    if (error instanceof Error && error.message === 'context workflow service is not initialized') return null;
    throw error;
  }
  if (!sameProjectExecutionScope(service.scope, scope)) {
    throw new Error('review workflow belongs to another project scope');
  }
  const { contract, workflow } = service.getMissionWorkflow(missionId);
  if (!contract && !workflow) return null;
  if (!contract || !workflow || workflow.binding.missionId !== missionId) {
    throw new Error('review workflow has inconsistent mission authority');
  }
  return Object.freeze({ service, contract, workflow });
}

/** Reuse the durable candidate council; never infer a report from handoff prose. */
export function resolveFrozenMissionReviewProof(
  scope: ProjectExecutionScope,
  mission: ReviewMission,
  deps: {
    readonly getService?: (scope: ProjectExecutionScope) => ReviewService;
    readonly inspectGit?: typeof inspectGitBinding;
  } = {},
): FrozenMissionReviewProof | null {
  const context = readFrozenMissionReviewContext(scope, mission.id, deps.getService);
  if (!context) return null;
  const { workflow, contract, service } = context;
  // Existing frozen receipts certify a committed candidate. Unrelated WIP is
  // not a new checkout-clean gate; the canonical civilian scanner owns that path.
  const currentGit = (deps.inspectGit ?? inspectGitBinding)(scope, workflow.binding.baseSha);
  const goal = mission.intentContract?.goal;
  const proof = Object.freeze({
    binding: Object.freeze({ ...workflow.binding }),
    candidateCurrent: bindingMatchesGit(workflow.binding, currentGit) &&
      (goal === undefined || goal === contract.contract.goal),
    gate: service.inspectPersistedReviewGate(workflow.binding),
  });
  issuedProofs.set(proof, {
    scope: Object.freeze({ ...scope }),
    mission: Object.freeze({ ...mission }),
  });
  return proof;
}

export function isFrozenMissionReviewProof(
  value: unknown,
  scope: ProjectExecutionScope,
  mission: ReviewMission,
): value is FrozenMissionReviewProof {
  if (!value || typeof value !== 'object') return false;
  const authority = issuedProofs.get(value);
  return authority !== undefined && sameProjectExecutionScope(authority.scope, scope) &&
    authority.mission.id === mission.id &&
    authority.mission.intentVersion === mission.intentVersion &&
    authority.mission.updatedAt === mission.updatedAt &&
    authority.mission.intentState === mission.intentState;
}
