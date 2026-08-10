import type { WebContents } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Mission } from "../shared/orch-types";
import {
  REAL_MISSION_E2E_CHANNELS,
  REAL_MISSION_E2E_GOAL,
  REAL_MISSION_E2E_PRODUCT_WIZARD_ACCEPTANCE_CRITERIA,
  productWizardReceiptSchema,
} from "../shared/real-mission-e2e";

const harness = vi.hoisted(() => {
  const handlers = new Map<
    string,
    (event: { sender: unknown }, raw: unknown) => unknown
  >();
  return {
    handlers,
    handle: vi.fn(
      (
        channel: string,
        handler: (event: { sender: unknown }, raw: unknown) => unknown,
      ) => handlers.set(channel, handler),
    ),
    removeHandler: vi.fn((channel: string) => handlers.delete(channel)),
    mission: null as unknown,
    missionCount: 0,
    observerArmed: false,
    preparedValid: false,
    scopeRoot: "/workspace/e2e",
    workspaceSha256: "c".repeat(64),
    binding: {
      squadId: "agentic-runtime-11111111-1111-4111-8111-111111111111",
      fixtureSquadId: "agentic-nexus-real-mission-e2e",
      fixtureSquadRevisionHash: "f".repeat(64),
      sourceSquadId:
        "custom-mission-setup-11111111-1111-4111-8111-111111111111",
      sourceSquadRevisionHash: "a".repeat(64),
      squadRevisionHash: "b".repeat(64),
    },
    effects: {
      paneCount: 0,
      dispatchCount: 0,
      taskCount: 0,
    },
    capture: {
      nativeDialogCount: 0,
      missionApprovalDialogCount: 0,
      missionApprovalAcceptedCount: 0,
    },
  };
});

vi.mock("electron", () => ({
  ipcMain: {
    handle: harness.handle,
    removeHandler: harness.removeHandler,
  },
}));

vi.mock("./persistence/renderer-workspace-scope", () => ({
  requireRendererWorkspaceScope: () => ({
    rootRealPath: harness.scopeRoot,
  }),
}));

vi.mock("./orch/project-domain-store-registry", () => ({
  getProjectDomainStores: () => ({
    missions: {
      get: () => harness.mission,
      list: () => Array.from({ length: harness.missionCount }),
    },
    missionPanes: {
      list: () => Array.from({ length: harness.effects.paneCount }),
    },
    taskDispatches: {
      list: () => Array.from({ length: harness.effects.dispatchCount }),
    },
    tasks: {
      list: () => Array.from({ length: harness.effects.taskCount }),
    },
  }),
}));

vi.mock("./real-mission-e2e-lifecycle", () => ({
  realMissionInteractionCapture: harness.capture,
}));

vi.mock("./real-mission-e2e-workspace", () => ({
  sha256: (value: string) => {
    if (value === harness.scopeRoot) return harness.workspaceSha256;
    let hash = 2_166_136_261;
    for (const character of value) {
      hash ^= character.codePointAt(0)!;
      hash = Math.imul(hash, 16_777_619) >>> 0;
    }
    return Array.from({ length: 8 }, (_, index) => {
      hash = Math.imul(hash ^ (index + 1), 2_246_822_519) >>> 0;
      return hash.toString(16).padStart(8, "0");
    }).join("");
  },
  productWizardSquadBinding: (mission: Mission | null | undefined) =>
    mission?.squadId === harness.binding.squadId ? harness.binding : null,
  isProductMissionSetupPreparedMission: (mission: Mission | null | undefined) =>
    harness.preparedValid && mission === harness.mission,
}));

import {
  installRealMissionProductWizardReceiptAuthority,
  scheduleProductWizardTrustedLaunchClicks,
} from "./real-mission-e2e-product-wizard";

const missionId = "mission-product-wizard";
const owner = {
  isDestroyed: () => false,
  isCrashed: () => false,
} as unknown as WebContents;

const reviewSha256 = "d".repeat(64);

function preparedMission(): Mission {
  return {
    id: missionId,
    title: "Release gate: missão real empacotada",
    description: REAL_MISSION_E2E_GOAL,
    status: "pending",
    squadId: harness.binding.squadId,
    milestones: [],
    learnings: "",
    intentState: "ready_to_start",
    intentVersion: 1,
    createdAt: 1,
    updatedAt: 1,
    intentContract: {
      version: 1,
      source: "typed",
      goal: REAL_MISSION_E2E_GOAL,
      acceptanceCriteria: [
        ...REAL_MISSION_E2E_PRODUCT_WIZARD_ACCEPTANCE_CRITERIA,
      ],
      risk: "normal",
      executionMode: "autopilot",
      lane: "standard",
      contextPolicy: "on-demand",
      intentVersion: 1,
      budgets: {
        planningTokens: 1_200,
        executionTokens: 8_000,
        maxWorkers: 3,
      },
      squadRevisionHash: harness.binding.squadRevisionHash,
      approvalReviewSha256: reviewSha256,
      approvedAt: 99,
      orchestratorRuntime: {
        adapterId: "codex",
        readOnly: false,
        nativeReadOnly: false,
      },
    },
  };
}

function startedMission(dispatchedAt = 105): Mission {
  const prepared = preparedMission();
  return {
    ...prepared,
    status: "running",
    intentState: "dispatched",
    intentContract: {
      ...prepared.intentContract!,
      dispatchedAt,
    },
  };
}

function begin(sender: WebContents = owner): {
  ok: true;
  runId: string;
  capability: string;
} {
  const handler = harness.handlers.get(
    REAL_MISSION_E2E_CHANNELS.beginProductWizardGesture,
  );
  if (!handler) throw new Error("mission setup gesture handler is not registered");
  return handler(
    { sender },
    { source: "trusted-mission-setup-prepare" },
  ) as {
    ok: true;
    runId: string;
    capability: string;
  };
}

function invoke(
  sender: WebContents,
  step: string,
  capability: string,
  id = missionId,
): {
  ok: true;
  nextCapability?: string;
} {
  const handler = harness.handlers.get(
    REAL_MISSION_E2E_CHANNELS.recordProductWizardStep,
  );
  if (!handler) throw new Error("product wizard handler is not registered");
  return handler({ sender }, { missionId: id, step, capability }) as {
    ok: true;
    nextCapability?: string;
  };
}

function install(runId = "run-product-wizard") {
  const onInvalid = vi.fn();
  const authority = installRealMissionProductWizardReceiptAuthority({
    owner: () => owner,
    scratchPath: () => harness.scopeRoot,
    runId,
    observerArmed: (id) => harness.observerArmed && id === missionId,
    onInvalid,
  });
  return { authority, onInvalid };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(100);
  harness.handlers.clear();
  harness.handle.mockClear();
  harness.removeHandler.mockClear();
  harness.mission = null;
  harness.missionCount = 0;
  harness.observerArmed = false;
  harness.preparedValid = false;
  harness.effects.paneCount = 0;
  harness.effects.dispatchCount = 0;
  harness.effects.taskCount = 0;
  harness.capture.nativeDialogCount = 0;
  harness.capture.missionApprovalDialogCount = 0;
  harness.capture.missionApprovalAcceptedCount = 0;
});

describe("main-owned Mission Setup causal receipt authority", () => {
  it("seals only the exact observed prepare followed by the exact start", () => {
    const { authority, onInvalid } = install();
    const launched = begin();

    harness.preparedValid = true;
    harness.mission = preparedMission();
    harness.missionCount = 1;
    harness.observerArmed = true;
    const prepared = invoke(
      owner,
      "mission-prepared",
      launched.capability,
    );
    expect(authority.receiptForMission(missionId)).toBeNull();

    vi.setSystemTime(106);
    harness.mission = startedMission();
    expect(
      invoke(owner, "mission-started", prepared.nextCapability!),
    ).toEqual({ ok: true });

    const receipt = authority.receiptForMission(missionId);
    expect(productWizardReceiptSchema.parse(receipt)).toEqual(receipt);
    expect(receipt).toMatchObject({
      origin: "main-owned-mission-setup-causal-chain",
      missionId,
      workspaceSha256: harness.workspaceSha256,
      sourceSquadRevisionHash: harness.binding.sourceSquadRevisionHash,
      squadRevisionHash: harness.binding.squadRevisionHash,
      reviewSha256,
      preparedAt: 100,
      startedAt: 106,
    });
    expect(receipt?.preparedContractSha256).not.toBe(
      receipt?.startedContractSha256,
    );
    expect(onInvalid).not.toHaveBeenCalled();
    authority.dispose();
  });

  it("mints prepare authority only before any mission exists", () => {
    const first = install();
    harness.missionCount = 1;
    expect(() => begin()).toThrow(/after mission effects/i);
    expect(first.onInvalid).toHaveBeenCalledOnce();
    first.authority.dispose();
  });

  it("rejects prepared evidence without the observer or inert mission state", () => {
    const run = install();
    const launched = begin();
    harness.preparedValid = true;
    harness.mission = preparedMission();
    harness.missionCount = 1;

    expect(() =>
      invoke(owner, "mission-prepared", launched.capability),
    ).toThrow(/observation/i);
    expect(run.authority.receiptForMission(missionId)).toBeNull();
    expect(run.onInvalid).toHaveBeenCalledOnce();
    run.authority.dispose();
  });

  it("consumes each capability before validating the step", () => {
    const run = install();
    const launched = begin();
    harness.preparedValid = true;
    harness.mission = preparedMission();
    harness.missionCount = 1;
    harness.observerArmed = true;
    const prepared = invoke(
      owner,
      "mission-prepared",
      launched.capability,
    );

    expect(() =>
      invoke(owner, "mission-started", launched.capability),
    ).toThrow(/capability/i);
    expect(prepared.nextCapability).toMatch(/^[a-f0-9]{64}$/u);
    expect(run.onInvalid).toHaveBeenCalledOnce();
    run.authority.dispose();
  });

  it("rejects a start that predates the prepared receipt", () => {
    const run = install();
    const launched = begin();
    harness.preparedValid = true;
    harness.mission = preparedMission();
    harness.missionCount = 1;
    harness.observerArmed = true;
    const prepared = invoke(
      owner,
      "mission-prepared",
      launched.capability,
    );

    vi.setSystemTime(106);
    harness.mission = startedMission(99);
    expect(() =>
      invoke(owner, "mission-started", prepared.nextCapability!),
    ).toThrow(/causality/i);
    expect(run.authority.receiptForMission(missionId)).toBeNull();
    run.authority.dispose();
  });

  it("quiesces queued canonical steps without minting evidence", () => {
    const run = install();
    const launched = begin();
    run.authority.quiesce();
    harness.preparedValid = true;
    harness.missionCount = 1;
    harness.observerArmed = true;

    expect(
      invoke(owner, "mission-prepared", launched.capability),
    ).toEqual({ ok: true, inactive: true });
    expect(run.authority.receiptForMission(missionId)).toBeNull();
    expect(run.onInvalid).not.toHaveBeenCalled();
    run.authority.dispose();
  });
});

describe("trusted Mission Setup click scheduler", () => {
  it("clicks Prepare, waits for enabled Start, then clicks Start once", async () => {
    const probedStages: string[] = [];
    const inputEvents: unknown[] = [];
    let startProbes = 0;
    const sender = {
      isDestroyed: () => false,
      isCrashed: () => false,
      focus: vi.fn(),
      executeJavaScript: vi.fn(async (source: string) => {
        const stage = source.includes(
          'data-nexus-real-mission-wizard-launch="prepare"',
        )
          ? "prepare"
          : "start";
        probedStages.push(stage);
        if (stage === "start" && startProbes++ === 0) {
          return { kind: "disabled", title: "Review required" };
        }
        return { kind: "ready", x: 20, y: 30 };
      }),
      sendInputEvent: vi.fn((event: unknown) => {
        inputEvents.push(event);
      }),
    } as unknown as WebContents;
    const gaveUp = vi.fn();

    const stop = scheduleProductWizardTrustedLaunchClicks(
      sender,
      () => false,
      gaveUp,
    );
    await vi.advanceTimersByTimeAsync(250);
    await vi.advanceTimersByTimeAsync(250);
    await vi.advanceTimersByTimeAsync(250);

    expect(probedStages).toEqual(["prepare", "start", "start"]);
    expect(inputEvents).toHaveLength(4);
    expect(gaveUp).not.toHaveBeenCalled();
    stop();
  });
});
