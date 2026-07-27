import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import { app, ipcMain } from "electron";
import type { WebContents } from "electron";

import { WINDOW_CHANNELS } from "../shared/channels";
import {
  REAL_MISSION_E2E_CHANNELS,
  REAL_MISSION_E2E_ACCEPTANCE_CRITERIA,
  REAL_MISSION_E2E_CTA,
  REAL_MISSION_E2E_EVIDENCE_FILE,
  REAL_MISSION_E2E_EVIDENCE_SCHEMA_VERSION,
  REAL_MISSION_E2E_PRODUCT_WIZARD_ACCEPTANCE_CRITERIA,
  REAL_MISSION_E2E_RESULT_CONTENT,
  REAL_MISSION_E2E_TIMEOUT_MS,
  isCurrentProcessRealMissionE2E,
  isCurrentProcessRealMissionProductWizardE2E,
  isExclusiveRealMissionE2E,
  isRealMissionE2ERendererFailureSignal,
  isRealMissionE2EPreApprovalMission,
  realMissionE2EObservePayloadSchema,
  realMissionE2EPrepareFixturePayloadSchema,
  type RealMissionE2EEvidence,
  type RealMissionE2ELaunchSurface,
} from "../shared/real-mission-e2e";
import type { Mission } from "../shared/orch-types";
import { initOrchestration } from "./orch/orch-ipc";
import {
  getProjectDomainStores,
  type ProjectDomainStoreSuite,
} from "./orch/project-domain-store-registry";
import { requireRendererWorkspaceScope } from "./persistence/renderer-workspace-scope";
import { grantWorkspacePathFromTrustedMain } from "./persistence/workspace-store";
import {
  persistRealMissionE2ESquadFixture,
  resolvePrivateRealMissionE2ESquadBinding,
  type RealMissionE2ESquadBinding,
} from "./real-mission-e2e-fixture";
import {
  createRealMissionPrematureExitHandlers,
  installRealMissionDialogInstrumentation,
  realMissionInteractionCapture,
  resetRealMissionInteractionCapture,
  type FailureCode,
} from "./real-mission-e2e-lifecycle";
import { RealMissionE2EMissionInventoryFence } from "./real-mission-e2e-mission-inventory";
import { RealMissionObserver } from "./real-mission-e2e-observer";
import {
  atomicWriteEvidence,
  isProductWizardPreApprovalMission,
  productWizardSquadBinding,
  runGit,
  setupScratchRepository,
  sha256,
  validateHarnessCodexAdapter,
  validateHarnessSquad,
  type ScratchRepository,
} from "./real-mission-e2e-workspace";
import { stageRealMissionCodexTrust } from "./real-mission-codex-trust";

export {
  createRealMissionPrematureExitHandlers,
  installRealMissionDialogInstrumentation,
  isCodexMcpApprovalPrompt,
} from "./real-mission-e2e-lifecycle";
export {
  hasCorrelatedPhysicalWorkerData,
  isRealMissionPhysicalPtyAgent,
} from "./real-mission-e2e-physical";
export { readDurableAuthoritySnapshot } from "./real-mission-e2e-authority";

/**
 * Packaged, local, real-provider release gate. Renderer authority is limited
 * to one strict mission id; the workspace, observation scope, PTY evidence,
 * durable receipts, repository checks, and final verdict all stay in main.
 */
export function initRealMissionE2E(): void {
  if (!isCurrentProcessRealMissionE2E()) return;
  const launchSurface: RealMissionE2ELaunchSurface =
    isCurrentProcessRealMissionProductWizardE2E()
      ? "product-wizard"
      : "private-runner";
  resetRealMissionInteractionCapture();
  installRealMissionDialogInstrumentation();

  const startedAt = Date.now();
  const rendererFailureToken = randomBytes(32).toString("hex");
  const evidenceFile = path.join(
    app.getPath("userData"),
    REAL_MISSION_E2E_EVIDENCE_FILE,
  );
  let scratch: ScratchRepository | null = null;
  let owner: WebContents | null = null;
  let observer: RealMissionObserver | null = null;
  let missionInventoryFence: RealMissionE2EMissionInventoryFence | null = null;
  let missionInventorySuite: ProjectDomainStoreSuite | null = null;
  let unsubscribeProductWizardMission: (() => void) | null = null;
  let fixturePrepared = false;
  let settled = false;

  const fallbackEvidence = (
    failureCode: FailureCode,
  ): RealMissionE2EEvidence => ({
    schemaVersion: REAL_MISSION_E2E_EVIDENCE_SCHEMA_VERSION,
    runId: `run-${randomUUID()}`,
    appVersion: app.getVersion(),
    startedAt,
    finishedAt: Date.now(),
    status: "fail",
    workspaceSha256: sha256(
      scratch?.workspacePath ??
        path.join(app.getPath("userData"), "unavailable"),
    ),
    expectedContentSha256: sha256(REAL_MISSION_E2E_RESULT_CONTENT),
    coverageTier: "guided-delivery-core",
    planOrigin: "production-guided-planner",
    prevcOrigin: "e2e-fixture",
    reviewOrigin: "production-physical-worker",
    qaOrigin: "production-physical-worker",
    launchSurface,
    wizardCoverage: "not-covered",
    interaction: {
      evidenceOrigin: "main-owned-instrumentation",
      ...realMissionInteractionCapture,
      codexMcpPromptCount: 0,
    },
    mission: null,
    missionInventory:
      missionInventoryFence && missionInventorySuite
        ? missionInventoryFence.proof(missionInventorySuite.missions.list())
        : {
            evidenceOrigin: "main-owned-mission-store-inventory",
            selectedMissionId: null,
            observedMissionCount: 0,
            observedMissionIds: [],
            finalMissionCount: 0,
            finalMissionIds: [],
            exactSingleProductMission: false,
          },
    kickoff: {
      sessionId: null,
      idleAt: null,
      busyAt: null,
      ptyDataAt: null,
      ptyChunkSha256: null,
    },
    plan: null,
    panes: [],
    physicalPty: {
      count: 0,
      ids: [],
    },
    dispatches: [],
    handoffs: [],
    durableHandoffs: {
      count: 0,
      ids: [],
    },
    dependencyConsumptions: [],
    completion: null,
    repository: {
      initialHeadSha: scratch?.initialHeadSha ?? null,
      finalHeadSha: null,
      resultSha256: null,
      commitCount: scratch ? 1 : 0,
      clean: scratch !== null,
      changedBeforeWorker: false,
      exactSingleCommit: false,
    },
    failure: {
      code: failureCode,
      reason: null,
      cta: REAL_MISSION_E2E_CTA,
      snapshot: {
        missionStatus: null,
        paneCount: 0,
        dispatchCount: 0,
        handoffCount: 0,
      },
    },
  });

  const finish = (failureCode: FailureCode | null) => {
    if (settled) return;
    settled = true;
    observer?.stop();
    unsubscribeProductWizardMission?.();
    unsubscribeProductWizardMission = null;
    clearTimeout(timeout);
    ipcMain.removeListener(WINDOW_CHANNELS.mounted, onMounted);
    ipcMain.removeHandler(REAL_MISSION_E2E_CHANNELS.prepareFixture);
    ipcMain.removeHandler(REAL_MISSION_E2E_CHANNELS.observe);
    app.removeListener("before-quit", onBeforeQuit);
    owner?.removeListener("destroyed", onOwnerDestroyed);
    owner?.removeListener("render-process-gone", onOwnerRenderProcessGone);
    let evidence: RealMissionE2EEvidence;
    try {
      evidence = observer
        ? observer.evidence(
            startedAt,
            failureCode === null ? "pass" : "fail",
            failureCode,
          )
        : fallbackEvidence(failureCode ?? "app-error");
      atomicWriteEvidence(evidenceFile, evidence);
    } catch {
      evidence = fallbackEvidence("app-error");
      try {
        atomicWriteEvidence(evidenceFile, evidence);
      } catch {
        // The outer script also requires a valid evidence file; no receipt
        // means a closed non-zero result even if Electron later exits cleanly.
      }
      failureCode = "app-error";
    }
    const snapshot = evidence.failure?.snapshot;
    if (failureCode === null) {
      console.log(
        `[real-mission] PASS mission=${evidence.mission?.id ?? "unknown"} ` +
          `evidence=${REAL_MISSION_E2E_EVIDENCE_FILE}`,
      );
      process.exitCode = 0;
    } else {
      console.error(
        `[real-mission] FAIL code=${failureCode} ` +
          `status=${snapshot?.missionStatus ?? "none"} ` +
          `panes=${snapshot?.paneCount ?? 0} ` +
          `dispatches=${snapshot?.dispatchCount ?? 0} ` +
          `handoffs=${snapshot?.handoffCount ?? 0} CTA: ${REAL_MISSION_E2E_CTA}`,
      );
      process.exitCode = 1;
    }
    app.quit();
  };

  const prematureExitHandlers = createRealMissionPrematureExitHandlers({
    isSettled: () => settled,
    finish,
  });
  const onBeforeQuit = () => prematureExitHandlers.beforeQuit();
  const onOwnerDestroyed = () => prematureExitHandlers.ownerDestroyed();
  const onOwnerRenderProcessGone = () => prematureExitHandlers.rendererGone();
  app.on("before-quit", onBeforeQuit);
  console.log("[real-mission] PHASE phase=booting");

  const onMounted = (event: Electron.IpcMainEvent) => {
    if (owner && owner !== event.sender) return;
    if (!scratch) {
      finish("setup-failed");
      return;
    }
    if (!owner) {
      owner = event.sender;
      owner.once("destroyed", onOwnerDestroyed);
      owner.once("render-process-gone", onOwnerRenderProcessGone);
    }
    console.log("[real-mission] PHASE phase=renderer-mounted");
    const granted = grantWorkspacePathFromTrustedMain(
      event.sender,
      scratch.workspacePath,
    );
    if (granted !== scratch.workspacePath) {
      finish("setup-failed");
      return;
    }
    event.sender.send(
      launchSurface === "product-wizard"
        ? REAL_MISSION_E2E_CHANNELS.prepareProductWizard
        : REAL_MISSION_E2E_CHANNELS.run,
      {
        workspacePath: scratch.workspacePath,
        rendererFailureToken,
      },
    );
  };

  const timeout = setTimeout(
    () => finish("timeout"),
    REAL_MISSION_E2E_TIMEOUT_MS,
  );

  if (!isExclusiveRealMissionE2E(process.argv)) {
    app.whenReady().then(() => finish("setup-failed"));
    return;
  }

  try {
    const userData = app.getPath("userData");
    scratch = setupScratchRepository(userData);
    stageRealMissionCodexTrust(userData, scratch.workspacePath);
  } catch {
    app.whenReady().then(() => finish("setup-failed"));
    return;
  }

  const armObserver = (
    sender: WebContents,
    suite: ProjectDomainStoreSuite,
    mission: Mission,
    squadBinding: RealMissionE2ESquadBinding,
    acceptanceCriteria: readonly string[],
    inventoryFence?: RealMissionE2EMissionInventoryFence,
  ): void => {
    if (!scratch || settled || observer !== null) {
      throw new Error("real mission observer is unavailable");
    }
    const scope = requireRendererWorkspaceScope(sender);
    if (
      scope.rootRealPath !== scratch.workspacePath ||
      suite.scope.projectId !== scope.projectId ||
      suite.scope.checkoutId !== scope.checkoutId
    ) {
      finish("observer-invalid");
      throw new Error("real mission workspace authority mismatch");
    }
    const initialHead = runGit(scratch.workspacePath, ["rev-parse", "HEAD"]);
    const initialStatus = runGit(scratch.workspacePath, [
      "status",
      "--porcelain",
      "--untracked-files=all",
    ]);
    if (initialHead !== scratch.initialHeadSha || initialStatus !== "") {
      finish("invariant-failed");
      throw new Error("scratch repository changed before observation");
    }
    const exactInventory =
      inventoryFence ?? new RealMissionE2EMissionInventoryFence();
    if (!exactInventory.select(mission.id, suite.missions.list())) {
      finish("invariant-failed");
      throw new Error("real mission inventory is not exact");
    }
    missionInventoryFence = exactInventory;
    missionInventorySuite = suite;
    observer = new RealMissionObserver({
      owner: sender,
      scratch,
      suite,
      missionId: mission.id,
      launchSurface,
      squadBinding,
      acceptanceCriteria,
      missionInventoryFence: exactInventory,
      onFinish: finish,
    });
    observer.start();
    console.log("[real-mission] PHASE phase=observer-armed");
  };

  const observeProductWizardMission = (sender: WebContents): void => {
    if (!scratch || launchSurface !== "product-wizard") {
      throw new Error("product wizard observation is unavailable");
    }
    const scope = requireRendererWorkspaceScope(sender);
    const suite = getProjectDomainStores(scope);
    const inventoryFence = new RealMissionE2EMissionInventoryFence();
    missionInventoryFence = inventoryFence;
    missionInventorySuite = suite;
    const evaluate = () => {
      if (settled) return;
      const missions = suite.missions.list();
      if (!inventoryFence.observe(missions)) {
        finish("invariant-failed");
        return;
      }
      if (observer !== null) return;
      const candidates = missions
        .filter((mission) => isProductWizardPreApprovalMission(mission));
      if (
        candidates.length > 1 ||
        (missions.length > 0 && candidates.length !== 1)
      ) {
        finish("observer-invalid");
        return;
      }
      const mission = candidates[0];
      if (!mission) return;
      const squadBinding = productWizardSquadBinding(mission);
      if (!squadBinding || !validateHarnessCodexAdapter()) {
        finish("observer-invalid");
        return;
      }
      if (!inventoryFence.select(mission.id, missions)) {
        finish("invariant-failed");
        return;
      }
      try {
        armObserver(
          sender,
          suite,
          mission,
          squadBinding,
          REAL_MISSION_E2E_PRODUCT_WIZARD_ACCEPTANCE_CRITERIA,
          inventoryFence,
        );
      } catch {
        if (!settled) finish("observer-invalid");
      }
    };
    unsubscribeProductWizardMission = suite.missions.onChange(evaluate);
    evaluate();
    console.log("[real-mission] PHASE phase=product-wizard-ready");
  };

  ipcMain.handle(
    REAL_MISSION_E2E_CHANNELS.prepareFixture,
    async (event, raw) => {
      if (settled || !owner || event.sender !== owner || !scratch) {
        throw new Error("real mission fixture authority is unavailable");
      }
      const parsed = realMissionE2EPrepareFixturePayloadSchema.safeParse(raw);
      if (
        !parsed.success ||
        parsed.data.rendererFailureToken !== rendererFailureToken
      ) {
        finish("setup-failed");
        throw new Error("invalid real mission fixture capability");
      }
      const scope = requireRendererWorkspaceScope(event.sender);
      if (scope.rootRealPath !== scratch.workspacePath) {
        finish("setup-failed");
        throw new Error("real mission fixture workspace authority mismatch");
      }
      if (fixturePrepared) return { ok: validateHarnessSquad() };
      try {
        // Join the production initialization singleflight. `listSquads()` is a
        // cache read and can succeed before the SQLite writer, MCP endpoint and
        // coordinator are ready, so it is not a valid release-gate barrier.
        await initOrchestration();
        console.log("[real-mission] PHASE phase=orchestration-ready");
        if (
          settled ||
          owner !== event.sender ||
          event.sender.isDestroyed() ||
          event.sender.isCrashed()
        ) {
          throw new Error(
            "real mission fixture authority changed during startup",
          );
        }
        const currentScope = requireRendererWorkspaceScope(event.sender);
        if (
          currentScope.installationId !== scope.installationId ||
          currentScope.projectId !== scope.projectId ||
          currentScope.checkoutId !== scope.checkoutId ||
          currentScope.rootRealPath !== scope.rootRealPath
        ) {
          throw new Error("real mission fixture workspace authority changed");
        }
        persistRealMissionE2ESquadFixture();
        console.log("[real-mission] PHASE phase=fixture-persisted");
        if (!validateHarnessSquad()) {
          throw new Error("release fixture did not persist exactly");
        }
        fixturePrepared = true;
        console.log("[real-mission] PHASE phase=fixture-prepared");
        if (launchSurface === "product-wizard") {
          observeProductWizardMission(event.sender);
        }
        return { ok: true };
      } catch {
        finish("setup-failed");
        throw new Error("main-owned release fixture could not be persisted");
      }
    },
  );

  ipcMain.handle(REAL_MISSION_E2E_CHANNELS.observe, (event, raw) => {
    if (settled || !owner || event.sender !== owner || !scratch) {
      throw new Error("real mission observer is unavailable");
    }
    const parsed = realMissionE2EObservePayloadSchema.safeParse(raw);
    if (!parsed.success) {
      if (observer === null) finish("observer-invalid");
      throw new Error("invalid real mission observation payload");
    }
    if (
      isRealMissionE2ERendererFailureSignal(
        parsed.data.missionId,
        rendererFailureToken,
      )
    ) {
      finish("renderer-failed");
      return { ok: true };
    }
    if (launchSurface !== "private-runner") {
      throw new Error("private real mission observation is unavailable");
    }
    if (observer !== null) {
      throw new Error("real mission observer is unavailable");
    }
    const scope = requireRendererWorkspaceScope(event.sender);
    if (scope.rootRealPath !== scratch.workspacePath) {
      finish("observer-invalid");
      throw new Error("real mission workspace authority mismatch");
    }
    const suite = getProjectDomainStores(scope);
    const mission = suite.missions.get(parsed.data.missionId);
    const squadBinding = resolvePrivateRealMissionE2ESquadBinding();
    if (
      !isRealMissionE2EPreApprovalMission(mission) ||
      !squadBinding ||
      !validateHarnessCodexAdapter()
    ) {
      finish("observer-invalid");
      throw new Error(
        "real mission contract is not the sealed release fixture",
      );
    }
    armObserver(
      event.sender,
      suite,
      mission,
      squadBinding,
      REAL_MISSION_E2E_ACCEPTANCE_CRITERIA,
    );
    return { ok: true };
  });

  ipcMain.on(WINDOW_CHANNELS.mounted, onMounted);
}
