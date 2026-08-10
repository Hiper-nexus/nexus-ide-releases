import {
  missionPrepareRequestSchema,
  missionReviewSchema,
  missionSnapshotSchema,
  type MissionPrepareRequest,
} from "../shared/mission-engine-contract";
import {
  REAL_MISSION_E2E_ADVISORS,
  REAL_MISSION_E2E_GOAL,
  createRealMissionE2ESquadFixture,
  realMissionE2EAcceptanceCriteria,
  realMissionE2ERendererFailureSignal,
  realMissionE2ERunPayloadSchema,
  type RealMissionE2EObservePayload,
} from "../shared/real-mission-e2e";

export interface RealMissionE2EApi {
  readonly workspace: {
    open(path: string): Promise<unknown>;
  };
  readonly mission: {
    prepare(request: MissionPrepareRequest): Promise<unknown>;
    start(input: {
      missionId: string;
      reviewSha256: string;
    }): Promise<unknown>;
  };
}

export type RealMissionE2EObservation = RealMissionE2EObservePayload;

export interface RealMissionE2ERunnerDeps {
  readonly prepareFixture: (rendererFailureToken: string) => Promise<unknown>;
  readonly observeMission: (input: RealMissionE2EObservation) => Promise<unknown>;
}

const REAL_MISSION_E2E_TITLE = "Release gate: missão real empacotada";
const REAL_MISSION_E2E_CONTEXT_PATHS = Object.freeze(["README.md"]);

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function resultIsOk(value: unknown): boolean {
  return record(value)?.ok === true;
}

function workspaceIsOpenAt(value: unknown, expectedPath: string): boolean {
  const current = record(record(value)?.current);
  return current?.path === expectedPath;
}

function sameStrings(
  actual: readonly string[] | undefined,
  expected: readonly string[],
): boolean {
  return (
    actual !== undefined &&
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

function prepareRequestForPayload(
  payload: ReturnType<typeof realMissionE2ERunPayloadSchema.parse>,
): MissionPrepareRequest {
  const admitted = new Set(payload.admittedAdvisorClis);
  const canonicalAdmitted = REAL_MISSION_E2E_ADVISORS.filter(
    (advisor) =>
      admitted.has(advisor.cli) &&
      !(payload.orchestratorCli === "claude" && advisor.cli === "claude"),
  ).map((advisor) => advisor.cli);
  if (!sameStrings(payload.admittedAdvisorClis, canonicalAdmitted)) {
    throw new Error("main-issued admitted advisor roster is not canonical");
  }

  const skippedAdvisorClis = REAL_MISSION_E2E_ADVISORS.filter(
    (advisor) => !admitted.has(advisor.cli),
  ).map((advisor) => advisor.cli);
  const fixture = createRealMissionE2ESquadFixture(
    skippedAdvisorClis,
    payload.orchestratorCli,
  );
  const acceptanceCriteria = realMissionE2EAcceptanceCriteria(
    payload.orchestratorCli,
    payload.admittedAdvisorClis,
  );

  return missionPrepareRequestSchema.parse({
    title: REAL_MISSION_E2E_TITLE,
    objective: REAL_MISSION_E2E_GOAL,
    contextPaths: [...REAL_MISSION_E2E_CONTEXT_PATHS],
    acceptanceCriteria: [...acceptanceCriteria],
    roster: fixture.agents.map((agent) => ({ ...agent })),
    advanced: { lane: "standard" },
  });
}

function assertExactReview(
  rawReview: unknown,
  request: MissionPrepareRequest,
  workspacePath: string,
) {
  const parsed = missionReviewSchema.safeParse(rawReview);
  if (!parsed.success) {
    throw new Error("canonical mission review is malformed", {
      cause: parsed.error,
    });
  }
  const review = parsed.data;
  if (
    review.title !== request.title ||
    review.objective !== request.objective ||
    review.workspaceLabel !== workspacePath ||
    !sameStrings(review.contextPaths, request.contextPaths) ||
    !sameStrings(review.acceptanceCriteria, request.acceptanceCriteria ?? []) ||
    JSON.stringify(review.roster) !== JSON.stringify(request.roster)
  ) {
    throw new Error("canonical mission review changed the release authority");
  }
  return review;
}

async function reportRendererFailure(
  deps: RealMissionE2ERunnerDeps,
  rendererFailureToken: string,
): Promise<void> {
  try {
    await deps.observeMission({
      kind: "renderer-failure",
      signal: realMissionE2ERendererFailureSignal(rendererFailureToken),
    });
  } catch {
    // Main may already have persisted a closed observer/setup failure.
  }
}

/**
 * The physical product path stops after opening the isolated workspace and
 * installing the exact source roster. Canonical Mission Setup owns prepare,
 * renders the returned review, and starts only from the operator action.
 */
export async function prepareRealMissionProductWizardE2E(
  api: Pick<RealMissionE2EApi, "workspace">,
  rawPayload: unknown,
  deps: RealMissionE2ERunnerDeps,
): Promise<void> {
  const payload = realMissionE2ERunPayloadSchema.parse(rawPayload);
  try {
    const workspace = await api.workspace.open(payload.workspacePath);
    if (!workspaceIsOpenAt(workspace, payload.workspacePath)) {
      throw new Error("trusted scratch workspace did not open");
    }
    const prepared = await deps.prepareFixture(payload.rendererFailureToken);
    if (!resultIsOk(prepared)) {
      throw new Error("main-owned release fixture could not be prepared");
    }
  } catch (error) {
    await reportRendererFailure(deps, payload.rendererFailureToken);
    throw error;
  }
}

/**
 * Exercise only the canonical public mission facade. Main still owns fixture
 * persistence, the immutable review fence, bootstrap, PTY observation, and all
 * release evidence. The observer is acknowledged before mission.start can
 * perform its first seal/bootstrap side effect.
 */
export async function runRealMissionE2E(
  api: RealMissionE2EApi,
  rawPayload: unknown,
  deps: RealMissionE2ERunnerDeps,
): Promise<string> {
  const payload = realMissionE2ERunPayloadSchema.parse(rawPayload);
  const request = prepareRequestForPayload(payload);

  try {
    // Bind the main-granted project scope before fixture or mission authority.
    const workspace = await api.workspace.open(payload.workspacePath);
    if (!workspaceIsOpenAt(workspace, payload.workspacePath)) {
      throw new Error("trusted scratch workspace did not open");
    }

    const prepared = await deps.prepareFixture(payload.rendererFailureToken);
    if (!resultIsOk(prepared)) {
      throw new Error("main-owned release fixture could not be prepared");
    }

    const review = assertExactReview(
      await api.mission.prepare(request),
      request,
      payload.workspacePath,
    );
    const observation = await deps.observeMission({
      kind: "mission-review",
      missionId: review.missionId,
      reviewSha256: review.reviewSha256,
    });
    if (!resultIsOk(observation)) {
      throw new Error("main observer did not arm for the canonical review");
    }

    // start owns the single production seal/bootstrap. No renderer bootstrap
    // call follows it, so the orchestrator cannot be materialized twice.
    const started = missionSnapshotSchema.safeParse(
      await api.mission.start({
        missionId: review.missionId,
        reviewSha256: review.reviewSha256,
      }),
    );
    if (
      !started.success ||
      started.data.id !== review.missionId ||
      started.data.state !== "running"
    ) {
      throw new Error("canonical mission start did not return the running review");
    }
    return review.missionId;
  } catch (error) {
    await reportRendererFailure(deps, payload.rendererFailureToken);
    throw error;
  }
}
