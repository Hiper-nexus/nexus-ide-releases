import {
  REAL_MISSION_E2E_ACCEPTANCE_CRITERIA,
  REAL_MISSION_E2E_GOAL,
  REAL_MISSION_E2E_SQUAD_ID,
  realMissionE2ERendererFailureSignal,
  realMissionE2ERunPayloadSchema,
} from "../shared/real-mission-e2e";

export interface RealMissionE2EApi {
  readonly workspace: {
    open(path: string): Promise<unknown>;
  };
  readonly orch: {
    armMission(input: { title: string; squadId: string }): Promise<unknown>;
    submitMissionIntent(input: {
      missionId: string;
      goal: string;
      source: "typed";
      contextPolicy: "minimal";
      acceptanceCriteria: string[];
      lane: "standard";
    }): Promise<unknown>;
    approveMissionIntent(input: { missionId: string }): Promise<unknown>;
    bootstrapMissionOrchestrator(input: {
      missionId: string;
    }): Promise<unknown>;
  };
}

export interface RealMissionE2ERunnerDeps {
  readonly prepareFixture: (rendererFailureToken: string) => Promise<unknown>;
  readonly observeMission: (missionId: string) => Promise<unknown>;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function missionIdFrom(value: unknown): string {
  const missionId = record(value)?.id;
  if (
    typeof missionId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(missionId)
  ) {
    throw new Error("mission response did not contain a valid id");
  }
  return missionId;
}

function resultIsOk(value: unknown): boolean {
  return record(value)?.ok === true;
}

function workspaceIsOpenAt(value: unknown, expectedPath: string): boolean {
  const current = record(record(value)?.current);
  return current?.path === expectedPath;
}

/**
 * Physical UI setup stops after opening the isolated workspace and installing
 * the exact source roster. It deliberately has no code path to arm, submit,
 * approve or bootstrap a mission; those actions must come from MissionWizard.
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
    try {
      await deps.observeMission(
        realMissionE2ERendererFailureSignal(payload.rendererFailureToken),
      );
    } catch {
      // Main may already have persisted a closed setup failure.
    }
    throw error;
  }
}

/**
 * The runner exercises only the public preload bridge for product actions.
 * Its private boundaries carry only a main-issued fixture capability and a
 * strict mission id. Main owns fixture persistence and starts independent
 * store/PTY observation before the first orchestrator is spawned.
 */
export async function runRealMissionE2E(
  api: RealMissionE2EApi,
  rawPayload: unknown,
  deps: RealMissionE2ERunnerDeps,
): Promise<string> {
  const payload = realMissionE2ERunPayloadSchema.parse(rawPayload);

  try {
    // Main grants this exact scratch path before delivering the run event. Open
    // it first so renderer-scoped orchestration IPC has a bound project runtime;
    // probing squads before this point is correctly denied by main authority.
    const workspace = await api.workspace.open(payload.workspacePath);
    if (!workspaceIsOpenAt(workspace, payload.workspacePath)) {
      throw new Error("trusted scratch workspace did not open");
    }

    // This private main boundary joins the real initOrchestration singleflight
    // before persisting the compiled fixture. A squads-list probe is only a
    // cache read and is not a readiness receipt for MCP/coordinator startup.
    const prepared = await deps.prepareFixture(payload.rendererFailureToken);
    if (!resultIsOk(prepared)) {
      throw new Error("main-owned release fixture could not be prepared");
    }

    const armed = await api.orch.armMission({
      title: "Release gate: missão real empacotada",
      squadId: REAL_MISSION_E2E_SQUAD_ID,
    });
    const missionId = missionIdFrom(armed);
    const submitted = await api.orch.submitMissionIntent({
      missionId,
      goal: REAL_MISSION_E2E_GOAL,
      // Enter the ordinary beginner path so approval must invoke the
      // production Guided Planner. Automation-owned missions intentionally
      // use a different exact-worker contract and would not prove this flow.
      source: "typed",
      contextPolicy: "minimal",
      acceptanceCriteria: [...REAL_MISSION_E2E_ACCEPTANCE_CRITERIA],
      lane: "standard",
    });
    if (
      missionIdFrom(submitted) !== missionId ||
      record(submitted)?.status !== "pending"
    ) {
      throw new Error("release gate mission intent was not sealed as pending");
    }

    // Approval is itself allowed to start the main-owned bootstrap. Install the
    // store/PTY observer while the exact compiled fixture is still pending so no
    // physical spawn or kickoff edge can happen before observation is active.
    const observation = await deps.observeMission(missionId);
    if (!resultIsOk(observation)) {
      throw new Error("main observer did not arm");
    }

    // The release operator still crosses the ordinary product approval IPC.
    // Only disposable fixture preparation is main-owned; no private channel
    // may bypass the native "Aprovar e iniciar" authority boundary.
    const approved = await api.orch.approveMissionIntent({ missionId });
    if (
      missionIdFrom(approved) !== missionId ||
      record(approved)?.status !== "running"
    ) {
      throw new Error("release gate mission was not approved as running");
    }

    const bootstrap = await api.orch.bootstrapMissionOrchestrator({
      missionId,
    });
    if (!resultIsOk(bootstrap)) {
      throw new Error("main-owned orchestrator bootstrap failed");
    }
    return missionId;
  } catch (error) {
    try {
      await deps.observeMission(
        realMissionE2ERendererFailureSignal(payload.rendererFailureToken),
      );
    } catch {
      // Main may already have closed the gate for an observer/invariant error.
    }
    throw error;
  }
}
