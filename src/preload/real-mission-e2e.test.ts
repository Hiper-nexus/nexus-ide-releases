import { describe, expect, it, vi } from "vitest";

import type {
  MissionPrepareRequest,
  MissionReview,
  MissionSnapshot,
} from "../shared/mission-engine-contract";
import {
  REAL_MISSION_E2E_ADVISORS,
  REAL_MISSION_E2E_ACCEPTANCE_CRITERIA,
  REAL_MISSION_E2E_GOAL,
  createRealMissionE2ESquadFixture,
  realMissionE2EAcceptanceCriteria,
  realMissionE2ERendererFailureSignal,
} from "../shared/real-mission-e2e";
import {
  prepareRealMissionProductWizardE2E,
  runRealMissionE2E,
  type RealMissionE2EApi,
  type RealMissionE2EObservation,
} from "./real-mission-e2e";

const rendererFailureToken = "f".repeat(64);
const reviewSha256 = "a".repeat(64);
const runPayload = {
  workspacePath: "/tmp/nexus-real-workspace",
  rendererFailureToken,
  admittedAdvisorClis: REAL_MISSION_E2E_ADVISORS.map(
    (advisor) => advisor.cli,
  ),
} as const;

function snapshot(missionId = "mission-real-1"): MissionSnapshot {
  return {
    id: missionId,
    title: "Release gate: missão real empacotada",
    objective: REAL_MISSION_E2E_GOAL,
    workspaceLabel: runPayload.workspacePath,
    state: "running",
    progress: { completed: 0, total: 1 },
    agents: [],
    edges: [],
    units: [],
    allowedActions: ["stop"],
    version: 1,
    updatedAt: 2,
  };
}

function reviewFor(request: MissionPrepareRequest): MissionReview {
  return {
    missionId: "mission-real-1",
    title: request.title!,
    objective: request.objective,
    workspaceLabel: runPayload.workspacePath,
    contextPaths: [...request.contextPaths],
    acceptanceCriteria: [...(request.acceptanceCriteria ?? [])],
    roster: request.roster.map((agent) => ({ ...agent })),
    permissions: [
      {
        id: "workspace-write",
        label: "Alterar arquivos do projeto",
      },
    ],
    warnings: [],
    reviewSha256,
    createdAt: 1,
  };
}

function apiFixture(events: string[] = []): RealMissionE2EApi {
  return {
    workspace: {
      open: vi.fn(async (workspacePath: string) => ({
        current: { path: workspacePath },
      })),
    },
    mission: {
      prepare: vi.fn(async (request: MissionPrepareRequest) => {
        events.push("prepare");
        return reviewFor(request);
      }),
      start: vi.fn(async (input) => {
        events.push("start");
        events.push("start-bootstrap-side-effect");
        return snapshot(input.missionId);
      }),
    },
  };
}

function successfulDeps(events: string[] = []) {
  return {
    prepareFixture: vi.fn(async () => {
      events.push("prepare-fixture");
      return { ok: true };
    }),
    observeMission: vi.fn(async (input: RealMissionE2EObservation) => {
      events.push(
        input.kind === "mission-review"
          ? `observe:${input.missionId}:${input.reviewSha256}`
          : "observe:renderer-failure",
      );
      return { ok: true };
    }),
  };
}

describe("real mission E2E preload runner", () => {
  it("prepares the physical product path without preparing or starting a mission", async () => {
    const api = apiFixture();
    const deps = successfulDeps();

    await expect(
      prepareRealMissionProductWizardE2E(api, runPayload, deps),
    ).resolves.toBeUndefined();

    expect(api.workspace.open).toHaveBeenCalledExactlyOnceWith(
      runPayload.workspacePath,
    );
    expect(deps.prepareFixture).toHaveBeenCalledExactlyOnceWith(
      rendererFailureToken,
    );
    expect(deps.observeMission).not.toHaveBeenCalled();
    expect(api.mission.prepare).not.toHaveBeenCalled();
    expect(api.mission.start).not.toHaveBeenCalled();
  });

  it("opens workspace, installs the fixture, prepares, observes, then starts", async () => {
    const events: string[] = [];
    const api = apiFixture(events);
    api.workspace.open = vi.fn(async (workspacePath: string) => {
      events.push("workspace-open");
      return { current: { path: workspacePath } };
    });
    const deps = successfulDeps(events);

    await expect(runRealMissionE2E(api, runPayload, deps)).resolves.toBe(
      "mission-real-1",
    );

    expect(events).toEqual([
      "workspace-open",
      "prepare-fixture",
      "prepare",
      `observe:mission-real-1:${reviewSha256}`,
      "start",
      "start-bootstrap-side-effect",
    ]);
  });

  it("submits the exact admitted fixture roster and full acceptance intent", async () => {
    const api = apiFixture();
    const deps = successfulDeps();

    await runRealMissionE2E(api, runPayload, deps);

    expect(api.mission.prepare).toHaveBeenCalledExactlyOnceWith({
      title: "Release gate: missão real empacotada",
      objective: REAL_MISSION_E2E_GOAL,
      contextPaths: ["README.md"],
      acceptanceCriteria: [...REAL_MISSION_E2E_ACCEPTANCE_CRITERIA],
      roster: createRealMissionE2ESquadFixture().agents,
      advanced: { lane: "standard" },
    });
    expect(deps.observeMission).toHaveBeenCalledExactlyOnceWith({
      kind: "mission-review",
      missionId: "mission-real-1",
      reviewSha256,
    });
    expect(api.mission.start).toHaveBeenCalledExactlyOnceWith({
      missionId: "mission-real-1",
      reviewSha256,
    });
  });

  it("uses only the ordered advisor roster sealed by main", async () => {
    const api = apiFixture();
    const admittedAdvisorClis = runPayload.admittedAdvisorClis.filter(
      (cli) => cli !== "kimi",
    );

    await runRealMissionE2E(
      api,
      { ...runPayload, admittedAdvisorClis },
      successfulDeps(),
    );

    const request = vi.mocked(api.mission.prepare).mock.calls[0]![0];
    expect(request.acceptanceCriteria).toEqual([
      ...realMissionE2EAcceptanceCriteria("codex", admittedAdvisorClis),
    ]);
    expect(request.roster.map((agent) => agent.cli)).not.toContain("kimi");
    expect(request.roster).toEqual(
      createRealMissionE2ESquadFixture(["kimi"]).agents,
    );
  });

  it("fails closed on a non-canonical admitted-roster payload", async () => {
    const api = apiFixture();
    const deps = successfulDeps();

    await expect(
      runRealMissionE2E(
        api,
        {
          ...runPayload,
          admittedAdvisorClis: [
            ...runPayload.admittedAdvisorClis,
            runPayload.admittedAdvisorClis[0],
          ],
        },
        deps,
      ),
    ).rejects.toThrow(/admitted advisor roster/i);

    expect(api.workspace.open).not.toHaveBeenCalled();
    expect(api.mission.prepare).not.toHaveBeenCalled();
    expect(api.mission.start).not.toHaveBeenCalled();
  });

  it("does not start when the main observer rejects the review fence", async () => {
    const api = apiFixture();
    const deps = successfulDeps();
    deps.observeMission.mockResolvedValueOnce({ ok: false });

    await expect(runRealMissionE2E(api, runPayload, deps)).rejects.toThrow(
      /observer/,
    );
    expect(api.mission.start).not.toHaveBeenCalled();
  });

  it.each([
    ["review hash", { reviewSha256: "not-a-sha" }],
    ["acceptance intent", { acceptanceCriteria: ["weakened"] }],
    [
      "roster",
      {
        roster: createRealMissionE2ESquadFixture().agents.map((agent, index) =>
          index === 1 ? { ...agent, cli: "kimi" } : agent,
        ),
      },
    ],
  ])("rejects a mismatched canonical %s before observation", async (_name, drift) => {
    const api = apiFixture();
    const deps = successfulDeps();
    vi.mocked(api.mission.prepare).mockImplementationOnce(async (request) => ({
      ...reviewFor(request),
      ...drift,
    }));

    await expect(runRealMissionE2E(api, runPayload, deps)).rejects.toThrow(
      /canonical mission review|review/i,
    );

    expect(api.mission.start).not.toHaveBeenCalled();
    expect(deps.observeMission).toHaveBeenCalledExactlyOnceWith({
      kind: "renderer-failure",
      signal: realMissionE2ERendererFailureSignal(rendererFailureToken),
    });
  });

  it("reports an early sanitized failure with the main-issued nonce", async () => {
    const api = apiFixture();
    api.workspace.open = vi.fn(async () => {
      throw new Error("private provider transcript must not cross IPC");
    });
    const deps = successfulDeps();

    await expect(runRealMissionE2E(api, runPayload, deps)).rejects.toThrow(
      /private provider transcript/,
    );

    expect(deps.observeMission).toHaveBeenCalledExactlyOnceWith({
      kind: "renderer-failure",
      signal: realMissionE2ERendererFailureSignal(rendererFailureToken),
    });
    expect(JSON.stringify(deps.observeMission.mock.calls)).not.toContain(
      "private provider transcript",
    );
    expect(api.mission.prepare).not.toHaveBeenCalled();
    expect(api.mission.start).not.toHaveBeenCalled();
  });

  it("rejects forged main payload fields before any public API call", async () => {
    const api = apiFixture();
    const deps = successfulDeps();

    await expect(
      runRealMissionE2E(
        api,
        {
          ...runPayload,
          missionId: "forged",
          pass: true,
          rawOutput: "forged",
        },
        deps,
      ),
    ).rejects.toThrow();

    expect(api.workspace.open).not.toHaveBeenCalled();
    expect(api.mission.prepare).not.toHaveBeenCalled();
    expect(api.mission.start).not.toHaveBeenCalled();
  });
});
