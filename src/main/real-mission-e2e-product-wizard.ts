import { createHash, randomBytes } from "node:crypto";
import { ipcMain, type WebContents } from "electron";

import {
  REAL_MISSION_E2E_CHANNELS,
  REAL_MISSION_E2E_GOAL,
  REAL_MISSION_E2E_PRODUCT_WIZARD_ACCEPTANCE_CRITERIA,
  productWizardReceiptChainSha256,
  productWizardReceiptSchema,
  realMissionE2EProductWizardStepPayloadSchema,
  type RealMissionE2EProductWizardReceipt,
} from "../shared/real-mission-e2e";
import type { Mission } from "../shared/orch-types";
import { canonicalJson } from "./context/canonical-json";
import type { ProjectDomainStoreSuite } from "./orch/project-domain-store-registry";
import { getProjectDomainStores } from "./orch/project-domain-store-registry";
import { requireRendererWorkspaceScope } from "./persistence/renderer-workspace-scope";
import type { RealMissionE2ESquadBinding } from "./real-mission-e2e-fixture";
import {
  readRealMissionApprovalDialogTiming,
  realMissionInteractionCapture,
} from "./real-mission-e2e-lifecycle";
import {
  isProductWizardPreApprovalMission,
  productWizardSquadBinding,
  sha256,
} from "./real-mission-e2e-workspace";

interface ProductWizardReceiptDraft {
  readonly missionId: string;
  readonly workspaceSha256: string;
  readonly squadBinding: RealMissionE2ESquadBinding;
  readonly armedAt: number;
  readonly submittedContractSha256: string | null;
  readonly intentSubmittedAt: number | null;
}

interface ProductWizardGestureCapability {
  readonly sha256: string;
  readonly expectedStep: "mission-armed" | "intent-submitted" | "approval-returned";
  readonly expiresAt: number;
}

const PRODUCT_WIZARD_GESTURE_CAPABILITY_TTL_MS = 2 * 60_000;
const PRODUCT_WIZARD_INACTIVE_ACK = Object.freeze({
  ok: true as const,
  inactive: true as const,
});

export interface RealMissionProductWizardReceiptAuthority {
  readonly receiptForMission: (
    missionId: string,
  ) => RealMissionE2EProductWizardReceipt | null;
  /**
   * Closes evidence authority while keeping terminal IPC acknowledgements
   * installed until Electron tears down the renderer. This drains a wizard
   * edge that was already queued when the observer reached a final verdict.
   */
  readonly quiesce: () => void;
  readonly dispose: () => void;
}

function hashCanonical(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function sameSquadBinding(
  left: RealMissionE2ESquadBinding,
  right: RealMissionE2ESquadBinding | null,
): right is RealMissionE2ESquadBinding {
  return (
    right !== null &&
    right.squadId === left.squadId &&
    right.sourceSquadId === left.sourceSquadId &&
    right.sourceSquadRevisionHash === left.sourceSquadRevisionHash &&
    right.squadRevisionHash === left.squadRevisionHash
  );
}

function assertNoMissionEffects(
  suite: ProjectDomainStoreSuite,
  missionId: string,
): void {
  if (
    suite.missionPanes.list(missionId).length !== 0 ||
    suite.taskDispatches.list(missionId).length !== 0 ||
    suite.tasks.list(missionId).length !== 0
  ) {
    throw new Error("product wizard arm already has runtime effects");
  }
}

function assertDialogNotOpened(): void {
  const timing = readRealMissionApprovalDialogTiming();
  if (
    realMissionInteractionCapture.nativeDialogCount !== 0 ||
    realMissionInteractionCapture.missionApprovalDialogCount !== 0 ||
    realMissionInteractionCapture.missionApprovalAcceptedCount !== 0 ||
    timing.openedAt !== null ||
    timing.acceptedAt !== null
  ) {
    throw new Error("native approval dialog opened before intent submission");
  }
}

function assertExactArmedMission(
  suite: ProjectDomainStoreSuite,
  mission: Mission | null,
): RealMissionE2ESquadBinding {
  const binding = mission ? productWizardSquadBinding(mission) : null;
  if (
    !mission ||
    !binding ||
    mission.status !== "pending" ||
    mission.intentState !== "awaiting_goal" ||
    mission.intentVersion !== 0 ||
    mission.intentContract != null ||
    mission.orchestratorSessionId != null
  ) {
    throw new Error("product wizard did not arm the exact inert mission shell");
  }
  assertNoMissionEffects(suite, mission.id);
  assertDialogNotOpened();
  return binding;
}

function assertExactSubmittedMission(
  mission: Mission | null,
  expectedBinding: RealMissionE2ESquadBinding,
): Mission {
  if (
    !isProductWizardPreApprovalMission(mission) ||
    !sameSquadBinding(
      expectedBinding,
      mission ? productWizardSquadBinding(mission) : null,
    )
  ) {
    throw new Error("product wizard intent is not the exact preapproval mission");
  }
  assertDialogNotOpened();
  return mission;
}

function assertExactApprovedMission(
  mission: Mission | null,
  expectedBinding: RealMissionE2ESquadBinding,
): Mission {
  const contract = mission?.intentContract;
  if (
    !mission ||
    !contract ||
    !sameSquadBinding(
      expectedBinding,
      productWizardSquadBinding(mission),
    ) ||
    mission.status !== "running" ||
    (mission.intentState !== "dispatched" &&
      mission.intentState !== "executing") ||
    mission.intentVersion !== 1 ||
    contract.version !== 1 ||
    contract.source !== "typed" ||
    contract.goal !== REAL_MISSION_E2E_GOAL ||
    contract.executionMode !== "autopilot" ||
    (contract.lane ?? "standard") !== "standard" ||
    contract.contextPolicy !== "on-demand" ||
    contract.intentVersion !== 1 ||
    contract.squadRevisionHash !== expectedBinding.squadRevisionHash ||
    !Number.isInteger(contract.approvedAt) ||
    !Number.isInteger(contract.dispatchedAt) ||
    contract.approvedAt! > contract.dispatchedAt! ||
    contract.acceptanceCriteria.length !==
      REAL_MISSION_E2E_PRODUCT_WIZARD_ACCEPTANCE_CRITERIA.length ||
    !contract.acceptanceCriteria.every(
      (criterion, index) =>
        criterion ===
        REAL_MISSION_E2E_PRODUCT_WIZARD_ACCEPTANCE_CRITERIA[index],
    )
  ) {
    throw new Error("product wizard approval did not seal the exact mission");
  }
  return mission;
}

/**
 * Installs the sole causal authority for product-wizard release evidence.
 * Renderer hints carry only a mission id and step name. Preload attaches the
 * capability it retained after the trusted click; main derives every
 * timestamp, state snapshot and hash from the live isolated runtime.
 */
export function installRealMissionProductWizardReceiptAuthority(input: {
  readonly owner: () => WebContents | null;
  readonly scratchPath: () => string | null;
  readonly runId: string;
  readonly observerArmed: (missionId: string) => boolean;
  readonly onInvalid: () => void;
}): RealMissionProductWizardReceiptAuthority {
  let draft: ProductWizardReceiptDraft | null = null;
  let receipt: RealMissionE2EProductWizardReceipt | null = null;
  let gestureCapability: ProductWizardGestureCapability | null = null;
  let gestureStarted = false;
  let isQuiesced = false;

  const fail = (message: string): never => {
    throw new Error(message);
  };

  const issueGestureCapability = (
    expectedStep: ProductWizardGestureCapability["expectedStep"],
  ): string => {
    const raw = randomBytes(32).toString("hex");
    gestureCapability = Object.freeze({
      sha256: sha256(`${input.runId}:${raw}`),
      expectedStep,
      expiresAt: Date.now() + PRODUCT_WIZARD_GESTURE_CAPABILITY_TTL_MS,
    });
    return raw;
  };

  ipcMain.handle(
    REAL_MISSION_E2E_CHANNELS.beginProductWizardGesture,
    (event, raw) => {
      try {
        if (isQuiesced) {
          return PRODUCT_WIZARD_INACTIVE_ACK;
        }
        const owner = input.owner();
        const scratchPath = input.scratchPath();
        if (
          !owner ||
          event.sender !== owner ||
          owner.isDestroyed() ||
          owner.isCrashed() ||
          !scratchPath ||
          gestureStarted ||
          draft !== null ||
          receipt !== null ||
          !raw ||
          typeof raw !== "object" ||
          Array.isArray(raw) ||
          Object.keys(raw).length !== 1 ||
          (raw as { source?: unknown }).source !==
            "trusted-mission-wizard-launch"
        ) {
          return fail("product wizard trusted gesture authority is unavailable");
        }
        const scope = requireRendererWorkspaceScope(event.sender);
        if (scope.rootRealPath !== scratchPath) {
          return fail("product wizard trusted gesture workspace mismatch");
        }
        const suite = getProjectDomainStores(scope);
        if (suite.missions.list().length !== 0) {
          return fail("product wizard trusted gesture started after mission effects");
        }
        gestureStarted = true;
        return {
          ok: true,
          runId: input.runId,
          capability: issueGestureCapability("mission-armed"),
        };
      } catch (error) {
        input.onInvalid();
        throw error;
      }
    },
  );

  ipcMain.handle(
    REAL_MISSION_E2E_CHANNELS.recordProductWizardStep,
    (event, raw) => {
      try {
        if (isQuiesced) {
          return PRODUCT_WIZARD_INACTIVE_ACK;
        }
        const owner = input.owner();
        const scratchPath = input.scratchPath();
        const parsed =
          realMissionE2EProductWizardStepPayloadSchema.safeParse(raw);
        if (
          !owner ||
          event.sender !== owner ||
          owner.isDestroyed() ||
          owner.isCrashed() ||
          !scratchPath ||
          !parsed.success
        ) {
          return fail("product wizard causal authority is unavailable");
        }
        const scope = requireRendererWorkspaceScope(event.sender);
        if (scope.rootRealPath !== scratchPath) {
          return fail("product wizard causal workspace authority mismatch");
        }
        const suite = getProjectDomainStores(scope);
        const mission = suite.missions.get(parsed.data.missionId);
        const now = Date.now();
        const currentCapability = gestureCapability;
        // Consume before inspecting mission state. A rejected or replayed step
        // can never retain authority for a second attempt.
        gestureCapability = null;
        if (
          !gestureStarted ||
          !currentCapability ||
          currentCapability.expectedStep !== parsed.data.step ||
          currentCapability.expiresAt < now ||
          currentCapability.sha256 !==
            sha256(`${input.runId}:${parsed.data.capability}`)
        ) {
          return fail("product wizard trusted gesture capability is invalid");
        }

        if (parsed.data.step === "mission-armed") {
          if (draft !== null || receipt !== null) {
            return fail("product wizard arm step is duplicated or out of order");
          }
          const squadBinding = assertExactArmedMission(suite, mission);
          draft = Object.freeze({
            missionId: parsed.data.missionId,
            workspaceSha256: sha256(scope.rootRealPath),
            squadBinding,
            armedAt: now,
            submittedContractSha256: null,
            intentSubmittedAt: null,
          });
          return {
            ok: true,
            nextCapability: issueGestureCapability("intent-submitted"),
          };
        }

        if (
          !draft ||
          receipt !== null ||
          draft.missionId !== parsed.data.missionId ||
          draft.workspaceSha256 !== sha256(scope.rootRealPath)
        ) {
          return fail("product wizard causal step is duplicated or out of order");
        }

        if (parsed.data.step === "intent-submitted") {
          if (
            draft.intentSubmittedAt !== null ||
            draft.submittedContractSha256 !== null ||
            !input.observerArmed(parsed.data.missionId)
          ) {
            return fail("product wizard intent step lacks main observation");
          }
          const submitted = assertExactSubmittedMission(
            mission,
            draft.squadBinding,
          );
          draft = Object.freeze({
            ...draft,
            submittedContractSha256: hashCanonical({
              missionId: submitted.id,
              intentVersion: submitted.intentVersion,
              intentContract: submitted.intentContract,
            }),
            intentSubmittedAt: now,
          });
          return {
            ok: true,
            nextCapability: issueGestureCapability("approval-returned"),
          };
        }

        if (
          draft.intentSubmittedAt === null ||
          draft.submittedContractSha256 === null ||
          !input.observerArmed(parsed.data.missionId)
        ) {
          return fail("product wizard approval step lacks submitted intent");
        }
        const approved = assertExactApprovedMission(
          mission,
          draft.squadBinding,
        );
        const timing = readRealMissionApprovalDialogTiming();
        if (
          realMissionInteractionCapture.nativeDialogCount !== 1 ||
          realMissionInteractionCapture.missionApprovalDialogCount !== 1 ||
          realMissionInteractionCapture.missionApprovalAcceptedCount !== 1 ||
          timing.openedAt === null ||
          timing.acceptedAt === null ||
          draft.armedAt > draft.intentSubmittedAt ||
          draft.intentSubmittedAt > timing.openedAt ||
          timing.openedAt > timing.acceptedAt ||
          timing.acceptedAt > approved.intentContract!.approvedAt! ||
          approved.intentContract!.approvedAt! > now ||
          approved.intentContract!.dispatchedAt! > now
        ) {
          return fail("product wizard native approval causality is invalid");
        }
        const core = Object.freeze({
          origin: "main-owned-product-wizard-causal-chain" as const,
          missionId: approved.id,
          workspaceSha256: draft.workspaceSha256,
          sourceSquadRevisionHash:
            draft.squadBinding.sourceSquadRevisionHash,
          squadRevisionHash: draft.squadBinding.squadRevisionHash,
          submittedContractSha256: draft.submittedContractSha256,
          approvedContractSha256: hashCanonical({
            missionId: approved.id,
            intentVersion: approved.intentVersion,
            intentContract: approved.intentContract,
          }),
          armedAt: draft.armedAt,
          intentSubmittedAt: draft.intentSubmittedAt,
          nativeDialogOpenedAt: timing.openedAt,
          nativeDialogAcceptedAt: timing.acceptedAt,
          approvalReturnedAt: now,
        });
        receipt = Object.freeze(
          productWizardReceiptSchema.parse({
            ...core,
            chainSha256: productWizardReceiptChainSha256(core),
          }),
        );
        return { ok: true };
      } catch (error) {
        input.onInvalid();
        throw error;
      }
    },
  );

  return Object.freeze({
    receiptForMission: (missionId: string) =>
      receipt?.missionId === missionId ? receipt : null,
    quiesce: () => {
      isQuiesced = true;
      gestureCapability = null;
    },
    dispose: () => {
      isQuiesced = true;
      gestureCapability = null;
      ipcMain.removeHandler(
        REAL_MISSION_E2E_CHANNELS.beginProductWizardGesture,
      );
      ipcMain.removeHandler(
        REAL_MISSION_E2E_CHANNELS.recordProductWizardStep,
      );
    },
  });
}
