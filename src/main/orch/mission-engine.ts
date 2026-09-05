import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  missionEngineCommandSchema,
  missionResultSchema,
  missionPrepareRequestSchema,
  missionReviewSchema,
  type MissionEngineCommand,
  type MissionPrepareRequest,
  type MissionReview,
  type MissionSnapshot,
  type MissionSummarySnapshot,
} from '../../shared/mission-engine-contract';
import {
  missionIntentStateSchema,
  type MissionAttachmentSnapshot,
} from '../../shared/mission-intent';
import { missionStatusSchema } from '../../shared/orch-types';
import { PET_STUDIO_SQUAD } from '../../shared/pet-studio';
import {
  projectExecutionScopeSchema,
  type ProjectExecutionScope,
} from '../../shared/types';
import {
  sameProjectExecutionScope,
} from './project-domain-store-registry';
import {
  projectMissionSnapshot,
  projectMissionSnapshotViewSchema,
  projectMissionSummarySnapshot,
  rootRelativeProjectPathSchema,
  type ProjectMissionSnapshotView,
} from './mission-snapshot';

const missionReviewPayloadSchema = missionReviewSchema.omit({
  reviewSha256: true,
});

const missionArmResultSchema = missionReviewPayloadSchema
  .pick({
    missionId: true,
    workspaceLabel: true,
    createdAt: true,
  })
  .strict();

const missionCompilationSchema = missionReviewPayloadSchema
  .pick({
    title: true,
    objective: true,
    contextPaths: true,
    acceptanceCriteria: true,
    roster: true,
    permissions: true,
    warnings: true,
    attachments: true,
  })
  .strict();

const missionReviewFenceSchema = missionReviewSchema
  .pick({ missionId: true, reviewSha256: true })
  .extend({
    profile: z
      .object({ kind: z.literal('pet-studio') })
      .strict()
      .optional(),
    attachments: missionReviewSchema.shape.attachments,
  })
  .strict();

const missionStartInputSchema = missionReviewFenceSchema
  .pick({ missionId: true, reviewSha256: true })
  .strict();
const missionIdSchema = missionReviewSchema.shape.missionId;
const rootRelativeContextPathsSchema = z
  .array(rootRelativeProjectPathSchema)
  .max(64);
const missionSnapshotViewListSchema = z
  .array(projectMissionSnapshotViewSchema)
  .max(10_000);
const missionLifecycleFenceSchema = z
  .object({
    missionId: missionIdSchema,
    expectedStatus: missionStatusSchema,
    expectedIntentState: missionIntentStateSchema,
    expectedUpdatedAt: z.number().int().nonnegative(),
    expectedIntentVersion: z.number().int().nonnegative(),
  })
  .strict();
const missionBlockInputSchema = missionLifecycleFenceSchema
  .extend({
    description: z.string().min(1).max(65_536),
  })
  .strict();
const missionVerifiedCompletionInputSchema = missionLifecycleFenceSchema
  .extend({
    learnings: z.string().max(65_536),
    result: missionResultSchema,
    /**
     * Autoridade do OPERADOR sobre o gate de revisão independente (19/08:
     * missão Parou 0/0 sem saída — "Marcar concluída" batia em review_missing
     * e não havia cancelar). Só o IPC main-side do operador seta esta flag;
     * o caminho MCP (nexus_mission_set_status) nunca — o Maestro continua
     * incapaz de se autoconcluir sem revisor.
     */
    operatorOverride: z.literal(true).optional(),
  })
  .strict();

export type MissionArmResult = z.infer<typeof missionArmResultSchema>;
export type MissionCompilation = z.infer<typeof missionCompilationSchema>;
export type MissionReviewFence = z.infer<typeof missionReviewFenceSchema>;
export type MissionStartInput = z.infer<typeof missionStartInputSchema>;
export type MissionBlockInput = z.infer<typeof missionBlockInputSchema>;
export type MissionVerifiedCompletionInput = z.infer<
  typeof missionVerifiedCompletionInputSchema
>;
export type MissionTechnicalResumeInput = MissionBlockInput;

type RetryKickoffCommand = Extract<
  MissionEngineCommand,
  { readonly kind: 'retry-kickoff' }
>;
type ResumeCommand = Extract<
  MissionEngineCommand,
  { readonly kind: 'resume' }
>;
type StopCommand = Extract<
  MissionEngineCommand,
  { readonly kind: 'stop' }
>;
type DirectCommand = Extract<
  MissionEngineCommand,
  { readonly kind: 'direct' }
>;
type AnswerQuestionCommand = Extract<
  MissionEngineCommand,
  { readonly kind: 'answer-question' }
>;

export interface MissionEngine {
  prepare(
    scope: ProjectExecutionScope,
    request: MissionPrepareRequest,
    assertCurrentScope?: () => void,
  ): Promise<MissionReview>;
  start(
    scope: ProjectExecutionScope,
    input: MissionStartInput,
  ): Promise<MissionSnapshot>;
  command(
    scope: ProjectExecutionScope,
    command: MissionEngineCommand,
  ): Promise<MissionSnapshot>;
  blockUser(
    scope: ProjectExecutionScope,
    input: MissionBlockInput,
  ): void;
  blockTechnical(
    scope: ProjectExecutionScope,
    input: MissionBlockInput,
  ): void;
  resumeTechnical(
    scope: ProjectExecutionScope,
    input: MissionTechnicalResumeInput,
  ): void;
  completeVerified(
    scope: ProjectExecutionScope,
    input: MissionVerifiedCompletionInput,
  ): void;
  snapshot(
    scope: ProjectExecutionScope,
    missionId: string,
  ): Promise<MissionSnapshot>;
  list(scope: ProjectExecutionScope): Promise<MissionSummarySnapshot[]>;
}

export interface MainMissionEnginePorts {
  readonly arm: (
    request: MissionPrepareRequest,
    assertCurrentScope?: () => void,
  ) => Promise<MissionArmResult>;
  readonly compile: (
    request: MissionPrepareRequest,
    armed: MissionArmResult,
  ) => Promise<MissionCompilation>;
  readonly persistReviewFence: (fence: MissionReviewFence) => Promise<void>;
  readonly discardUnfencedPreparation: (
    armed: Pick<MissionArmResult, 'missionId' | 'createdAt'>,
  ) => Promise<boolean>;
  readonly readReviewFence: (
    missionId: string,
  ) => Promise<MissionReviewFence | null>;
  readonly revalidatePetStudioAttachments?: (
    snapshots: readonly MissionAttachmentSnapshot[],
  ) => readonly MissionAttachmentSnapshot[];
  readonly seal: (input: MissionStartInput) => Promise<void>;
  readonly bootstrap: (missionId: string) => Promise<void>;
  readonly retryKickoff: (command: RetryKickoffCommand) => Promise<void>;
  readonly resume: (command: ResumeCommand) => Promise<void>;
  readonly stop: (command: StopCommand) => Promise<void>;
  readonly direct: (command: DirectCommand) => Promise<void>;
  readonly answerQuestion: (command: AnswerQuestionCommand) => Promise<void>;
  readonly blockUser: (input: MissionBlockInput) => void;
  readonly resumeTechnical: (input: MissionTechnicalResumeInput) => void;
  readonly blockTechnical: (input: MissionBlockInput) => void;
  readonly completeVerified: (input: MissionVerifiedCompletionInput) => void;
  readonly readSnapshotView: (
    missionId: string,
  ) => Promise<ProjectMissionSnapshotView>;
  readonly listSnapshotViews: () => Promise<ProjectMissionSnapshotView[]>;
}

const REQUIRED_PORTS = [
  'arm',
  'compile',
  'persistReviewFence',
  'discardUnfencedPreparation',
  'readReviewFence',
  'seal',
  'bootstrap',
  'retryKickoff',
  'resume',
  'stop',
  'direct',
  'answerQuestion',
  'blockUser',
  'blockTechnical',
  'resumeTechnical',
  'completeVerified',
  'readSnapshotView',
  'listSnapshotViews',
] as const satisfies readonly (keyof MainMissionEnginePorts)[];

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      throw new TypeError('review payload contains a non-JSON value');
    }
    return serialized;
  }

  if (Array.isArray(value)) {
    return `[${value
      .map((entry) =>
        entry === undefined ||
        typeof entry === 'function' ||
        typeof entry === 'symbol'
          ? 'null'
          : canonicalJson(entry),
      )
      .join(',')}]`;
  }

  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => {
      const entry = record[key];
      return (
        entry !== undefined &&
        typeof entry !== 'function' &&
        typeof entry !== 'symbol'
      );
    })
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}
function canonicalPrepareRequest(
  request: MissionPrepareRequest,
): MissionPrepareRequest {
  const contextPaths = rootRelativeContextPathsSchema.parse(
    request.contextPaths,
  );
  if (request.profile?.kind !== 'pet-studio') {
    return missionPrepareRequestSchema.parse({ ...request, contextPaths });
  }
  return missionPrepareRequestSchema.parse({
    ...request,
    contextPaths: [],
    roster: PET_STUDIO_SQUAD.agents.map((agent) => ({
      ...agent,
      allowedTools:
        agent.allowedTools === null ? null : [...(agent.allowedTools ?? [])],
      allowedSkills:
        agent.allowedSkills === null ? null : [...(agent.allowedSkills ?? [])],
    })),
    advanced: { lane: 'standard' },
  });
}


export class MainMissionEngine implements MissionEngine {
  readonly #scope: ProjectExecutionScope;
  readonly #ports: MainMissionEnginePorts;
  readonly #preparedPetAttachments = new Map<
    string,
    readonly MissionAttachmentSnapshot[]
  >();

  constructor(scope: ProjectExecutionScope, ports: MainMissionEnginePorts) {
    this.#scope = Object.freeze({ ...projectExecutionScopeSchema.parse(scope) });
    for (const port of REQUIRED_PORTS) {
      if (typeof ports?.[port] !== 'function') {
        throw new TypeError(`mission engine port ${port} is required`);
      }
    }
    this.#ports = Object.freeze({ ...ports });
  }

  #assertScope(rawScope: ProjectExecutionScope): void {
    const candidate = projectExecutionScopeSchema.parse(rawScope);
    if (!sameProjectExecutionScope(this.#scope, candidate)) {
      throw new Error('mission engine scope mismatch');
    }
  }

  async #readFreshSnapshot(missionId: string): Promise<MissionSnapshot> {
    const rawView = await this.#ports.readSnapshotView(missionId);
    const snapshot = projectMissionSnapshot(rawView);
    if (snapshot.id !== missionId) {
      throw new Error('mission snapshot identity mismatch');
    }
    return snapshot;
  }

  async prepare(
    scope: ProjectExecutionScope,
    request: MissionPrepareRequest,
    assertCurrentScope?: () => void,
  ): Promise<MissionReview> {
    this.#assertScope(scope);
    const parsedRequest = missionPrepareRequestSchema.parse(request);
    const safeRequest = canonicalPrepareRequest(parsedRequest);
    assertCurrentScope?.();

    const armed = missionArmResultSchema.parse(
      await (assertCurrentScope
        ? this.#ports.arm(safeRequest, assertCurrentScope)
        : this.#ports.arm(safeRequest)),
    );
    try {
      const compiled = missionCompilationSchema.parse(
        await this.#ports.compile(safeRequest, armed),
      );
      const payload = missionReviewPayloadSchema.parse({
        ...armed,
        ...compiled,
        contextPaths: rootRelativeContextPathsSchema.parse(compiled.contextPaths),
      });
      const review = missionReviewSchema.parse({
        ...payload,
        reviewSha256: createHash('sha256')
          .update(canonicalJson(payload))
          .digest('hex'),
      });
      if (
        safeRequest.profile?.kind === 'pet-studio' &&
        review.attachments?.length !== 1
      ) {
        throw new Error('pet attachment snapshot is absent from review');
      }
      const fence = missionReviewFenceSchema.parse({
        missionId: review.missionId,
        reviewSha256: review.reviewSha256,
      });

      await this.#ports.persistReviewFence(fence);
      if (safeRequest.profile?.kind === 'pet-studio') {
        this.#preparedPetAttachments.set(
          review.missionId,
          review.attachments!.map((snapshot) => ({ ...snapshot })),
        );
      }
      return review;
    } catch (error) {
      try {
        await this.#ports.discardUnfencedPreparation({
          missionId: armed.missionId,
          createdAt: armed.createdAt,
        });
      } catch (rollbackError) {
        console.warn(
          `[mission-engine] failed to discard unfenced preparation ${armed.missionId}:`,
          rollbackError,
        );
      }
      throw error;
    }
  }

  async start(
    scope: ProjectExecutionScope,
    input: MissionStartInput,
  ): Promise<MissionSnapshot> {
    this.#assertScope(scope);
    const parsedInput = missionStartInputSchema.parse(input);
    const rawFence = await this.#ports.readReviewFence(parsedInput.missionId);
    if (rawFence === null) {
      throw new Error('review fence is absent');
    }

    let fence: MissionReviewFence;
    try {
      fence = missionReviewFenceSchema.parse(rawFence);
    } catch (error) {
      throw new Error('review fence is malformed', { cause: error });
    }
    if (
      fence.missionId !== parsedInput.missionId ||
      fence.reviewSha256 !== parsedInput.reviewSha256
    ) {
      throw new Error('review fence mismatch');
    }
    const petAttachments =
      fence.profile?.kind === 'pet-studio'
        ? fence.attachments
        : this.#preparedPetAttachments.get(parsedInput.missionId);
    if (fence.profile?.kind === 'pet-studio' || petAttachments) {
      if (petAttachments?.length !== 1) {
        throw new Error('pet attachment snapshot is absent');
      }
      if (!this.#ports.revalidatePetStudioAttachments) {
        throw new Error('pet attachment validation is unavailable');
      }
      try {
        const current =
          this.#ports.revalidatePetStudioAttachments(petAttachments);
        if (
          current.length !== 1 ||
          current[0]?.path !== petAttachments[0]?.path ||
          current[0]?.sourcePath !== petAttachments[0]?.sourcePath ||
          current[0]?.sealId !== petAttachments[0]?.sealId ||
          current[0]?.sha256 !== petAttachments[0]?.sha256 ||
          current[0]?.size !== petAttachments[0]?.size ||
          current[0]?.device !== petAttachments[0]?.device ||
          current[0]?.inode !== petAttachments[0]?.inode
        ) {
          throw new Error('sealed attachment identity changed');
        }
      } catch (error) {
        throw new Error('pet attachment validation failed', { cause: error });
      }
    }


    await this.#ports.seal(parsedInput);
    await this.#ports.bootstrap(parsedInput.missionId);
    const snapshot = await this.#readFreshSnapshot(parsedInput.missionId);
    this.#preparedPetAttachments.delete(parsedInput.missionId);
    return snapshot;
  }

  async command(
    scope: ProjectExecutionScope,
    command: MissionEngineCommand,
  ): Promise<MissionSnapshot> {
    this.#assertScope(scope);
    const parsed = missionEngineCommandSchema.parse(command);

    switch (parsed.kind) {
      case 'retry-kickoff':
        await this.#ports.retryKickoff(parsed);
        break;
      case 'resume':
        await this.#ports.resume(parsed);
        break;
      case 'stop':
        await this.#ports.stop(parsed);
        break;
      case 'direct':
        await this.#ports.direct(parsed);
        break;
      case 'answer-question':
        await this.#ports.answerQuestion(parsed);
        break;
    }

    return this.#readFreshSnapshot(parsed.missionId);
  }

  blockUser(scope: ProjectExecutionScope, input: MissionBlockInput): void {
    this.#assertScope(scope);
    this.#ports.blockUser(missionBlockInputSchema.parse(input));
  }

  blockTechnical(scope: ProjectExecutionScope, input: MissionBlockInput): void {
    this.#assertScope(scope);
    this.#ports.blockTechnical(missionBlockInputSchema.parse(input));
  }

  resumeTechnical(
    scope: ProjectExecutionScope,
    input: MissionTechnicalResumeInput,
  ): void {
    this.#assertScope(scope);
    this.#ports.resumeTechnical(missionBlockInputSchema.parse(input));
  }

  completeVerified(
    scope: ProjectExecutionScope,
    input: MissionVerifiedCompletionInput,
  ): void {
    this.#assertScope(scope);
    this.#ports.completeVerified(
      missionVerifiedCompletionInputSchema.parse(input),
    );
  }

  async snapshot(
    scope: ProjectExecutionScope,
    rawMissionId: string,
  ): Promise<MissionSnapshot> {
    this.#assertScope(scope);
    return this.#readFreshSnapshot(missionIdSchema.parse(rawMissionId));
  }

  async list(scope: ProjectExecutionScope): Promise<MissionSummarySnapshot[]> {
    this.#assertScope(scope);
    const views = missionSnapshotViewListSchema.parse(
      await this.#ports.listSnapshotViews(),
    );
    return views.map((view) => projectMissionSummarySnapshot(view));
  }
}
