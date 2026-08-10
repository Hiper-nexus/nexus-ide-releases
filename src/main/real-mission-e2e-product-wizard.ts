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
import { realMissionInteractionCapture } from "./real-mission-e2e-lifecycle";
import {
  isProductMissionSetupPreparedMission,
  productWizardSquadBinding,
  sha256,
} from "./real-mission-e2e-workspace";

interface ProductWizardReceiptDraft {
  readonly missionId: string;
  readonly workspaceSha256: string;
  readonly squadBinding: RealMissionE2ESquadBinding;
  readonly reviewSha256: string;
  readonly preparedContractSha256: string;
  readonly preparedAt: number;
}

interface ProductWizardGestureCapability {
  readonly sha256: string;
  readonly expectedStep: "mission-prepared" | "mission-started";
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
    right.fixtureSquadId === left.fixtureSquadId &&
    right.fixtureSquadRevisionHash === left.fixtureSquadRevisionHash &&
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
    throw new Error("prepared mission already has runtime effects");
  }
}

function assertNoApprovalInteraction(): void {
  if (
    realMissionInteractionCapture.nativeDialogCount !== 0 ||
    realMissionInteractionCapture.missionApprovalDialogCount !== 0 ||
    realMissionInteractionCapture.missionApprovalAcceptedCount !== 0
  ) {
    throw new Error("canonical mission setup opened an approval dialog");
  }
}

function assertExactPreparedMission(
  suite: ProjectDomainStoreSuite,
  mission: Mission | null,
): {
  readonly mission: Mission;
  readonly binding: RealMissionE2ESquadBinding;
} {
  const binding = mission ? productWizardSquadBinding(mission) : null;
  if (
    !isProductMissionSetupPreparedMission(mission) ||
    !binding ||
    typeof mission.intentContract?.approvalReviewSha256 !== "string"
  ) {
    throw new Error("mission setup did not prepare the exact reviewed mission");
  }
  assertNoMissionEffects(suite, mission.id);
  assertNoApprovalInteraction();
  return { mission, binding };
}

function assertExactStartedMission(
  mission: Mission | null,
  expectedBinding: RealMissionE2ESquadBinding,
  expectedReviewSha256: string,
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
    contract.approvalReviewSha256 !== expectedReviewSha256 ||
    contract.orchestratorRuntime?.adapterId !== "codex" ||
    contract.orchestratorRuntime.readOnly !== false ||
    contract.orchestratorRuntime.nativeReadOnly !== false ||
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
    throw new Error("mission setup start did not dispatch the reviewed mission");
  }
  assertNoApprovalInteraction();
  return mission;
}

export function scheduleProductWizardTrustedLaunchClicks(
  sender: WebContents,
  isSettled: () => boolean,
  onGaveUp?: () => void,
): () => void {
  let stage: "prepare" | "start" | "done" = "prepare";
  let attempts = 0;
  let sawButton = false;
  let sawDisabled = false;
  // Single-flight prevents a stale coordinate probe from clicking the next
  // control after Mission Setup reflows from Prepare into Review.
  let probing = false;
  const timer = setInterval(() => {
    if (
      isSettled() ||
      stage === "done" ||
      sender.isDestroyed() ||
      sender.isCrashed()
    ) {
      clearInterval(timer);
      return;
    }
    if (probing) return;
    attempts += 1;
    if (attempts > 120) {
      clearInterval(timer);
      console.error(
        "[real-mission] mission-setup-trusted-click-gave-up " +
          `stage=${stage} attempts=${attempts} ` +
          `sawButton=${sawButton} sawDisabled=${sawDisabled}`,
      );
      onGaveUp?.();
      return;
    }
    probing = true;
    const expectedStage = stage;
    void (async () => {
      try {
        if (sender.isDestroyed() || sender.isCrashed()) return;
        const state = (await sender.executeJavaScript(`(() => {
          const el = document.querySelector(
            '[data-nexus-real-mission-wizard-launch="${expectedStage}"]',
          );
          if (!(el instanceof HTMLElement)) return { kind: "missing" };
          const disabled =
            (el instanceof HTMLButtonElement && el.disabled) ||
            el.getAttribute("aria-disabled") === "true";
          const rect = el.getBoundingClientRect();
          if (rect.width < 1 || rect.height < 1) return { kind: "hidden" };
          if (disabled) {
            return {
              kind: "disabled",
              title: el.getAttribute("title") || "",
            };
          }
          const x = Math.round(rect.left + rect.width / 2);
          const y = Math.round(rect.top + rect.height / 2);
          const hit = document.elementFromPoint(x, y);
          if (!hit || !(el === hit || el.contains(hit))) {
            return { kind: "obscured" };
          }
          return { kind: "ready", x, y };
        })()`)) as
          | {
              kind: "missing" | "hidden" | "disabled" | "obscured";
              title?: string;
            }
          | { kind: "ready"; x: number; y: number };
        if (stage !== expectedStage || isSettled()) return;
        if (state.kind === "disabled") {
          sawButton = true;
          sawDisabled = true;
          if (attempts === 1 || attempts % 20 === 0) {
            console.warn(
              "[real-mission] mission-setup-control-disabled " +
                `stage=${expectedStage} ` +
                `title=${JSON.stringify(state.title ?? "")}`,
            );
          }
          return;
        }
        if (state.kind !== "ready") return;
        sawButton = true;
        sender.focus();
        const common = {
          x: state.x,
          y: state.y,
          button: "left" as const,
          clickCount: 1,
        };
        sender.sendInputEvent({ type: "mouseDown", ...common });
        sender.sendInputEvent({ type: "mouseUp", ...common });
        console.log(
          `[real-mission] PHASE phase=mission-setup-${expectedStage}-clicked`,
        );
        if (expectedStage === "prepare") {
          stage = "start";
          attempts = 0;
          sawButton = false;
          sawDisabled = false;
        } else {
          stage = "done";
          clearInterval(timer);
        }
      } catch {
        // The canonical control may not be mounted yet; keep polling.
      } finally {
        probing = false;
      }
    })();
  }, 250);
  return () => clearInterval(timer);
}
/**
 * Installs the sole causal authority for physical Mission Setup release
 * evidence. Renderer hints carry only a mission id and canonical step name.
 * Preload attaches the capability retained from trusted Prepare through Start;
 * main derives every timestamp, state snapshot, review fence, and hash.
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
          !("source" in raw) ||
          raw.source !== "trusted-mission-setup-prepare"
        ) {
          return fail("mission setup trusted prepare authority is unavailable");
        }
        const scope = requireRendererWorkspaceScope(event.sender);
        if (scope.rootRealPath !== scratchPath) {
          return fail("mission setup trusted prepare workspace mismatch");
        }
        const suite = getProjectDomainStores(scope);
        if (suite.missions.list().length !== 0) {
          return fail("mission setup trusted prepare began after mission effects");
        }
        gestureStarted = true;
        return {
          ok: true,
          runId: input.runId,
          capability: issueGestureCapability("mission-prepared"),
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
          return fail("mission setup causal authority is unavailable");
        }
        const scope = requireRendererWorkspaceScope(event.sender);
        if (scope.rootRealPath !== scratchPath) {
          return fail("mission setup causal workspace authority mismatch");
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

        if (parsed.data.step === "mission-prepared") {
          if (
            draft !== null ||
            receipt !== null ||
            !input.observerArmed(parsed.data.missionId)
          ) {
            return fail(
              "mission setup prepared step is duplicated or lacks observation",
            );
          }
          const prepared = assertExactPreparedMission(suite, mission);
          const contract = prepared.mission.intentContract!;
          if (contract.approvedAt! > now) {
            return fail("mission setup prepared timestamp is not causal");
          }
          draft = Object.freeze({
            missionId: prepared.mission.id,
            workspaceSha256: sha256(scope.rootRealPath),
            squadBinding: prepared.binding,
            reviewSha256: contract.approvalReviewSha256!,
            preparedContractSha256: hashCanonical({
              missionId: prepared.mission.id,
              intentVersion: prepared.mission.intentVersion,
              intentContract: contract,
            }),
            preparedAt: now,
          });
          return {
            ok: true,
            nextCapability: issueGestureCapability("mission-started"),
          };
        }

        if (
          !draft ||
          receipt !== null ||
          draft.missionId !== parsed.data.missionId ||
          draft.workspaceSha256 !== sha256(scope.rootRealPath) ||
          !input.observerArmed(parsed.data.missionId)
        ) {
          return fail("mission setup start is duplicated or out of order");
        }
        const started = assertExactStartedMission(
          mission,
          draft.squadBinding,
          draft.reviewSha256,
        );
        const startedContract = started.intentContract!;
        if (
          draft.preparedAt > startedContract.dispatchedAt! ||
          startedContract.dispatchedAt! > now
        ) {
          return fail("mission setup prepare/start causality is invalid");
        }
        const core = Object.freeze({
          origin: "main-owned-mission-setup-causal-chain" as const,
          missionId: started.id,
          workspaceSha256: draft.workspaceSha256,
          sourceSquadRevisionHash:
            draft.squadBinding.sourceSquadRevisionHash,
          squadRevisionHash: draft.squadBinding.squadRevisionHash,
          reviewSha256: draft.reviewSha256,
          preparedContractSha256: draft.preparedContractSha256,
          startedContractSha256: hashCanonical({
            missionId: started.id,
            intentVersion: started.intentVersion,
            intentContract: startedContract,
          }),
          preparedAt: draft.preparedAt,
          startedAt: now,
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
