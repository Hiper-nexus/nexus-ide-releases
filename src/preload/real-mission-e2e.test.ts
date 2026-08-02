import { describe, expect, it, vi } from "vitest";

import {
  REAL_MISSION_E2E_ADVISORS,
  REAL_MISSION_E2E_ACCEPTANCE_CRITERIA,
  REAL_MISSION_E2E_GOAL,
  realMissionE2EAcceptanceCriteria,
  realMissionE2ERendererFailureSignal,
} from "../shared/real-mission-e2e";
import {
  prepareRealMissionProductWizardE2E,
  runRealMissionE2E,
  type RealMissionE2EApi,
} from "./real-mission-e2e";

const rendererFailureToken = "f".repeat(64);
const runPayload = {
  workspacePath: "/tmp/nexus-real-workspace",
  rendererFailureToken,
  admittedAdvisorClis: REAL_MISSION_E2E_ADVISORS.map(
    (advisor) => advisor.cli,
  ),
} as const;

function apiFixture(events: string[] = []): RealMissionE2EApi {
  return {
    workspace: {
      open: vi.fn(async (workspacePath: string) => ({
        current: { path: workspacePath },
      })),
    },
    orch: {
      armMission: vi.fn(async () => ({
        id: "mission-real-1",
        status: "pending",
      })),
      submitMissionIntent: vi.fn(async () => ({
        id: "mission-real-1",
        status: "pending",
      })),
      approveMissionIntent: vi.fn(async () => {
        events.push("approve");
        // Production approval starts main-owned bootstrap immediately. Keep
        // that side effect visible so this test catches observers armed only
        // after approval has already had a chance to spawn the orchestrator.
        events.push("approval-bootstrap");
        return {
          id: "mission-real-1",
          status: "running",
        };
      }),
      bootstrapMissionOrchestrator: vi.fn(async () => {
        events.push("bootstrap");
        return { ok: true, missionId: "mission-real-1" };
      }),
    },
  };
}

describe("real mission E2E preload runner", () => {
  it("prepares the physical wizard without arm, submit, approve or bootstrap", async () => {
    const api = apiFixture();
    const prepareFixture = vi.fn(async () => ({ ok: true }));
    const observeMission = vi.fn(async () => ({ ok: true }));

    await expect(
      prepareRealMissionProductWizardE2E(api, runPayload, {
        prepareFixture,
        observeMission,
      }),
    ).resolves.toBeUndefined();

    expect(api.workspace.open).toHaveBeenCalledExactlyOnceWith(
      runPayload.workspacePath,
    );
    expect(prepareFixture).toHaveBeenCalledExactlyOnceWith(
      rendererFailureToken,
    );
    expect(observeMission).not.toHaveBeenCalled();
    expect(api.orch.armMission).not.toHaveBeenCalled();
    expect(api.orch.submitMissionIntent).not.toHaveBeenCalled();
    expect(api.orch.approveMissionIntent).not.toHaveBeenCalled();
    expect(api.orch.bootstrapMissionOrchestrator).not.toHaveBeenCalled();
  });

  it("opens the main-granted workspace before requesting the main-owned fixture", async () => {
    const events: string[] = [];
    const api = apiFixture(events);
    let workspaceOpened = false;
    api.workspace.open = vi.fn(async (workspacePath: string) => {
      events.push("workspace-open");
      workspaceOpened = true;
      return { current: { path: workspacePath } };
    });
    const prepareFixture = vi.fn(async () => {
      events.push("prepare-fixture");
      if (!workspaceOpened) {
        throw new Error("renderer has no authorized workspace scope");
      }
      return { ok: true };
    });

    await expect(
      runRealMissionE2E(api, runPayload, {
        prepareFixture,
        observeMission: async () => ({ ok: true }),
      }),
    ).resolves.toBe("mission-real-1");
    expect(events.slice(0, 2)).toEqual(["workspace-open", "prepare-fixture"]);
  });

  it("arms the main observer before approval can start bootstrap", async () => {
    const events: string[] = [];
    const api = apiFixture(events);
    const observeMission = vi.fn(async (missionId: string) => {
      events.push(`observe:${missionId}`);
      return { ok: true };
    });
    const prepareFixture = vi.fn(async () => {
      events.push("prepare-fixture");
      return { ok: true };
    });
    await expect(
      runRealMissionE2E(api, runPayload, { prepareFixture, observeMission }),
    ).resolves.toBe("mission-real-1");

    expect(events).toEqual([
      "prepare-fixture",
      "observe:mission-real-1",
      "approve",
      "approval-bootstrap",
      "bootstrap",
    ]);
    expect(prepareFixture).toHaveBeenCalledExactlyOnceWith(
      rendererFailureToken,
    );
    expect(api.orch.approveMissionIntent).toHaveBeenCalledExactlyOnceWith({
      missionId: "mission-real-1",
    });
    expect(api.orch.submitMissionIntent).toHaveBeenCalledWith({
      missionId: "mission-real-1",
      goal: REAL_MISSION_E2E_GOAL,
      source: "typed",
      contextPolicy: "minimal",
      acceptanceCriteria: [...REAL_MISSION_E2E_ACCEPTANCE_CRITERIA],
      lane: "standard",
    });
    expect(observeMission).toHaveBeenCalledExactlyOnceWith("mission-real-1");
  });

  it("uses the advisor roster sealed by main instead of preload process.env", async () => {
    const api = apiFixture();
    const admittedAdvisorClis = runPayload.admittedAdvisorClis.filter(
      (cli) => cli !== "grok",
    );

    await expect(
      runRealMissionE2E(
        api,
        { ...runPayload, admittedAdvisorClis },
        {
          prepareFixture: async () => ({ ok: true }),
          observeMission: async () => ({ ok: true }),
        },
      ),
    ).resolves.toBe("mission-real-1");

    expect(api.orch.submitMissionIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        acceptanceCriteria: [
          ...realMissionE2EAcceptanceCriteria("codex", admittedAdvisorClis),
        ],
      }),
    );
  });

  it("does not bootstrap when the main-owned observer rejects the mission id", async () => {
    const api = apiFixture();
    await expect(
      runRealMissionE2E(api, runPayload, {
        prepareFixture: async () => ({ ok: true }),
        observeMission: async () => ({ ok: false }),
      }),
    ).rejects.toThrow(/observer/);
    expect(api.orch.approveMissionIntent).not.toHaveBeenCalled();
    expect(api.orch.bootstrapMissionOrchestrator).not.toHaveBeenCalled();
  });

  it("reports an early sanitized failure with the main-issued nonce", async () => {
    const api = apiFixture();
    api.workspace.open = vi.fn(async () => {
      throw new Error("private provider transcript must not cross IPC");
    });
    const observeMission = vi.fn(async () => ({ ok: true }));

    await expect(
      runRealMissionE2E(api, runPayload, {
        prepareFixture: async () => ({ ok: true }),
        observeMission,
      }),
    ).rejects.toThrow(/private provider transcript/);

    expect(observeMission).toHaveBeenCalledExactlyOnceWith(
      realMissionE2ERendererFailureSignal(rendererFailureToken),
    );
    expect(JSON.stringify(observeMission.mock.calls)).not.toContain(
      "private provider transcript",
    );
    expect(api.orch.armMission).not.toHaveBeenCalled();
  });

  it("rejects forged main payload fields before any public API call", async () => {
    const api = apiFixture();
    await expect(
      runRealMissionE2E(
        api,
        {
          workspacePath: "/tmp/nexus-real-workspace",
          rendererFailureToken,
          admittedAdvisorClis: runPayload.admittedAdvisorClis,
          missionId: "forged",
          pass: true,
          rawOutput: "forged",
        },
        {
          prepareFixture: async () => ({ ok: true }),
          observeMission: async () => ({ ok: true }),
        },
      ),
    ).rejects.toThrow();
    expect(api.orch.armMission).not.toHaveBeenCalled();
  });
});
