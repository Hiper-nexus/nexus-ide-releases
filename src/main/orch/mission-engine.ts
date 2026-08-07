import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  missionEngineCommandSchema,
  missionPrepareRequestSchema,
  missionReviewSchema,
  type MissionEngineCommand,
  type MissionPrepareRequest,
  type MissionReview,
  type MissionSnapshot,
  type MissionSummarySnapshot,
} from '../../shared/mission-engine-contract';
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
    roster: true,
    permissions: true,
    warnings: true,
  })
  .strict();

const missionReviewFenceSchema = missionReviewSchema
  .pick({ missionId: true, reviewSha256: true })
  .strict();

const missionStartInputSchema = missionReviewFenceSchema;
const missionIdSchema = missionReviewSchema.shape.missionId;
const rootRelativeContextPathsSchema = z
  .array(rootRelativeProjectPathSchema)
  .max(64);
const missionSnapshotViewListSchema = z
  .array(projectMissionSnapshotViewSchema)
  .max(10_000);

export type MissionArmResult = z.infer<typeof missionArmResultSchema>;
export type MissionCompilation = z.infer<typeof missionCompilationSchema>;
export type MissionReviewFence = z.infer<typeof missionReviewFenceSchema>;
export type MissionStartInput = z.infer<typeof missionStartInputSchema>;

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
  ): Promise<MissionReview>;
  start(
    scope: ProjectExecutionScope,
    input: MissionStartInput,
  ): Promise<MissionSnapshot>;
  command(
    scope: ProjectExecutionScope,
    command: MissionEngineCommand,
  ): Promise<MissionSnapshot>;
  snapshot(
    scope: ProjectExecutionScope,
    missionId: string,
  ): Promise<MissionSnapshot>;
  list(scope: ProjectExecutionScope): Promise<MissionSummarySnapshot[]>;
}

export interface MainMissionEnginePorts {
  readonly arm: (
    request: MissionPrepareRequest,
  ) => Promise<MissionArmResult>;
  readonly compile: (
    request: MissionPrepareRequest,
    armed: MissionArmResult,
  ) => Promise<MissionCompilation>;
  readonly persistReviewFence: (fence: MissionReviewFence) => Promise<void>;
  readonly readReviewFence: (
    missionId: string,
  ) => Promise<MissionReviewFence | null>;
  readonly seal: (input: MissionStartInput) => Promise<void>;
  readonly bootstrap: (missionId: string) => Promise<void>;
  readonly retryKickoff: (command: RetryKickoffCommand) => Promise<void>;
  readonly resume: (command: ResumeCommand) => Promise<void>;
  readonly stop: (command: StopCommand) => Promise<void>;
  readonly direct: (command: DirectCommand) => Promise<void>;
  readonly answerQuestion: (command: AnswerQuestionCommand) => Promise<void>;
  readonly readSnapshotView: (
    missionId: string,
  ) => Promise<ProjectMissionSnapshotView>;
  readonly listSnapshotViews: () => Promise<ProjectMissionSnapshotView[]>;
}

const REQUIRED_PORTS = [
  'arm',
  'compile',
  'persistReviewFence',
  'readReviewFence',
  'seal',
  'bootstrap',
  'retryKickoff',
  'resume',
  'stop',
  'direct',
  'answerQuestion',
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
    return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  }

  return `{${Object.keys(value)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalJson(
          (value as Record<string, unknown>)[key],
        )}`,
    )
    .join(',')}}`;
}

export class MainMissionEngine implements MissionEngine {
  readonly #scope: ProjectExecutionScope;
  readonly #ports: MainMissionEnginePorts;

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
  ): Promise<MissionReview> {
    this.#assertScope(scope);
    const parsedRequest = missionPrepareRequestSchema.parse(request);
    const safeRequest = missionPrepareRequestSchema.parse({
      ...parsedRequest,
      contextPaths: rootRelativeContextPathsSchema.parse(
        parsedRequest.contextPaths,
      ),
    });

    const armed = missionArmResultSchema.parse(
      await this.#ports.arm(safeRequest),
    );
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
    const fence = missionReviewFenceSchema.parse({
      missionId: review.missionId,
      reviewSha256: review.reviewSha256,
    });

    await this.#ports.persistReviewFence(fence);
    return review;
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

    await this.#ports.seal(parsedInput);
    await this.#ports.bootstrap(parsedInput.missionId);
    return this.#readFreshSnapshot(parsedInput.missionId);
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
