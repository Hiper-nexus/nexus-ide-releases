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
    preapprovalValid: false,
    scopeRoot: "/private/nexus-real-mission",
    workspaceSha256: "c".repeat(64),
    binding: {
      squadId: "agentic-runtime-11111111-1111-4111-8111-111111111111",
      sourceSquadId: "nexus-real-mission-e2e",
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
    timing: {
      openedAt: null as number | null,
      acceptedAt: null as number | null,
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
  readRealMissionApprovalDialogTiming: () => ({ ...harness.timing }),
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
  isProductWizardPreApprovalMission: (mission: Mission | null | undefined) =>
    harness.preapprovalValid && mission === harness.mission,
}));

import { installRealMissionProductWizardReceiptAuthority } from "./real-mission-e2e-product-wizard";

const missionId = "mission-product-wizard";
const owner = {
  isDestroyed: () => false,
  isCrashed: () => false,
} as unknown as WebContents;

function armedMission(): Mission {
  return {
    id: missionId,
    title: "Nexus physical release mission",
    description: "",
    status: "pending",
    squadId: harness.binding.squadId,
    milestones: [],
    learnings: "",
    intentState: "awaiting_goal",
    intentVersion: 0,
    createdAt: 1,
    updatedAt: 1,
  };
}

function submittedMission(): Mission {
  return {
    ...armedMission(),
    intentState: "awaiting_approval",
    intentVersion: 1,
    intentContract: {
      version: 1,
      source: "typed",
      goal: REAL_MISSION_E2E_GOAL,
      acceptanceCriteria: [...REAL_MISSION_E2E_PRODUCT_WIZARD_ACCEPTANCE_CRITERIA],
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
    },
  };
}

function approvedMission(): Mission {
  const submitted = submittedMission();
  return {
    ...submitted,
    status: "running",
    intentState: "dispatched",
    intentContract: {
      ...submitted.intentContract!,
      squadRevisionHash: harness.binding.squadRevisionHash,
      approvedAt: 104,
      dispatchedAt: 105,
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
  if (!handler) throw new Error("product wizard gesture handler is not registered");
  return handler(
    { sender },
    { source: "trusted-mission-wizard-launch" },
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
  harness.preapprovalValid = false;
  harness.effects.paneCount = 0;
  harness.effects.dispatchCount = 0;
  harness.effects.taskCount = 0;
  harness.capture.nativeDialogCount = 0;
  harness.capture.missionApprovalDialogCount = 0;
  harness.capture.missionApprovalAcceptedCount = 0;
  harness.timing.openedAt = null;
  harness.timing.acceptedAt = null;
});

describe("main-owned product wizard causal receipt authority", () => {
  it("seals a receipt only after the three physical UI steps and native approval", () => {
    const { authority, onInvalid } = install();
    const launched = begin();
    expect(launched).toMatchObject({
      ok: true,
      runId: "run-product-wizard",
    });

    harness.mission = armedMission();
    harness.missionCount = 1;
    const armed = invoke(owner, "mission-armed", launched.capability);
    expect(armed).toMatchObject({ ok: true });
    expect(authority.receiptForMission(missionId)).toBeNull();

    harness.mission = submittedMission();
    harness.preapprovalValid = true;
    harness.observerArmed = true;
    vi.setSystemTime(101);
    const submitted = invoke(
      owner,
      "intent-submitted",
      armed.nextCapability!,
    );
    expect(submitted).toMatchObject({ ok: true });
    expect(authority.receiptForMission(missionId)).toBeNull();

    harness.capture.nativeDialogCount = 1;
    harness.capture.missionApprovalDialogCount = 1;
    harness.capture.missionApprovalAcceptedCount = 1;
    harness.timing.openedAt = 102;
    harness.timing.acceptedAt = 103;
    harness.mission = approvedMission();
    vi.setSystemTime(106);
    expect(
      invoke(owner, "approval-returned", submitted.nextCapability!),
    ).toEqual({ ok: true });

    const receipt = authority.receiptForMission(missionId);
    expect(productWizardReceiptSchema.parse(receipt)).toMatchObject({
      missionId,
      workspaceSha256: harness.workspaceSha256,
      sourceSquadRevisionHash: harness.binding.sourceSquadRevisionHash,
      squadRevisionHash: harness.binding.squadRevisionHash,
      armedAt: 100,
      intentSubmittedAt: 101,
      nativeDialogOpenedAt: 102,
      nativeDialogAcceptedAt: 103,
      approvalReturnedAt: 106,
    });
    expect(receipt?.submittedContractSha256).not.toBe(
      receipt?.approvedContractSha256,
    );
    expect(onInvalid).not.toHaveBeenCalled();

    authority.dispose();
    expect(
      harness.handlers.has(
        REAL_MISSION_E2E_CHANNELS.recordProductWizardStep,
      ),
    ).toBe(false);
    expect(
      harness.handlers.has(
        REAL_MISSION_E2E_CHANNELS.beginProductWizardGesture,
      ),
    ).toBe(false);
  });

  it("fails closed without a gesture and on replayed, foreign, or effected steps", () => {
    const { authority, onInvalid } = install();
    harness.mission = armedMission();
    harness.missionCount = 1;
    expect(() =>
      invoke(owner, "mission-armed", "0".repeat(64)),
    ).toThrow(/capability|authority/i);
    expect(onInvalid).toHaveBeenCalledOnce();
    expect(authority.receiptForMission(missionId)).toBeNull();
    authority.dispose();

    harness.mission = null;
    harness.missionCount = 0;
    const replayRun = install();
    const launched = begin();
    harness.mission = armedMission();
    harness.missionCount = 1;
    const armed = invoke(owner, "mission-armed", launched.capability);
    expect(() =>
      invoke(owner, "intent-submitted", launched.capability),
    ).toThrow(/capability/i);
    expect(replayRun.onInvalid).toHaveBeenCalledOnce();
    expect(armed.nextCapability).toMatch(/^[a-f0-9]{64}$/u);
    replayRun.authority.dispose();

    harness.mission = null;
    harness.missionCount = 0;
    const foreignRun = install();
    const foreignCapability = begin().capability;
    harness.mission = armedMission();
    harness.missionCount = 1;
    expect(() =>
      invoke(
        {
          isDestroyed: () => false,
          isCrashed: () => false,
        } as unknown as WebContents,
        "mission-armed",
        foreignCapability,
      ),
    ).toThrow(/authority/i);
    expect(foreignRun.onInvalid).toHaveBeenCalledOnce();
    foreignRun.authority.dispose();

    harness.mission = null;
    harness.missionCount = 0;
    const effectedRun = install();
    const effectedCapability = begin().capability;
    harness.mission = armedMission();
    harness.missionCount = 1;
    harness.effects.paneCount = 1;
    expect(() =>
      invoke(owner, "mission-armed", effectedCapability),
    ).toThrow(/runtime effects/i);
    expect(effectedRun.onInvalid).toHaveBeenCalledOnce();
    effectedRun.authority.dispose();
    harness.effects.paneCount = 0;
  });

  it("rejects approval without exactly one accepted and ordered native dialog", () => {
    const { authority, onInvalid } = install();
    const launched = begin();
    harness.mission = armedMission();
    harness.missionCount = 1;
    const armed = invoke(owner, "mission-armed", launched.capability);
    harness.mission = submittedMission();
    harness.preapprovalValid = true;
    harness.observerArmed = true;
    vi.setSystemTime(101);
    const submitted = invoke(
      owner,
      "intent-submitted",
      armed.nextCapability!,
    );

    harness.capture.nativeDialogCount = 2;
    harness.capture.missionApprovalDialogCount = 1;
    harness.capture.missionApprovalAcceptedCount = 1;
    harness.timing.openedAt = 102;
    harness.timing.acceptedAt = 103;
    harness.mission = approvedMission();
    vi.setSystemTime(106);

    expect(() =>
      invoke(owner, "approval-returned", submitted.nextCapability!),
    ).toThrow(/native approval causality/i);
    expect(onInvalid).toHaveBeenCalledOnce();
    expect(authority.receiptForMission(missionId)).toBeNull();
    authority.dispose();
  });

  it("rejects cross-run capabilities and trusted gesture replay", () => {
    const first = install("run-a");
    const firstCapability = begin().capability;
    first.authority.dispose();

    const second = install("run-b");
    const secondCapability = begin().capability;
    harness.mission = armedMission();
    harness.missionCount = 1;
    expect(() =>
      invoke(owner, "mission-armed", firstCapability),
    ).toThrow(/capability/i);
    expect(second.onInvalid).toHaveBeenCalledOnce();
    expect(secondCapability).not.toBe(firstCapability);
    second.authority.dispose();

    harness.mission = null;
    harness.missionCount = 0;
    const replay = install("run-c");
    expect(begin().capability).toMatch(/^[a-f0-9]{64}$/u);
    expect(() => begin()).toThrow(/gesture authority/i);
    expect(replay.onInvalid).toHaveBeenCalledOnce();
    replay.authority.dispose();
  });
});
