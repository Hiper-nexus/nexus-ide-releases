import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import { app, ipcMain } from "electron";
import type { WebContents } from "electron";

import { WINDOW_CHANNELS } from "../shared/channels";
import {
  REAL_MISSION_E2E_CHANNELS,
  REAL_MISSION_E2E_CTA,
  REAL_MISSION_E2E_CLAUDE_ORCHESTRATOR_EVIDENCE_FILE,
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
  realMissionE2EAcceptanceCriteria,
  realMissionE2EAdvisorSkipClis,
  realMissionE2EObservePayloadSchema,
  realMissionE2EOrchestratorCli,
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
  installRealMissionProductWizardReceiptAuthority,
  type RealMissionProductWizardReceiptAuthority,
} from "./real-mission-e2e-product-wizard";
import {
  atomicWriteEvidence,
  isProductWizardPreApprovalMission,
  productWizardSquadBinding,
  runGit,
  setupScratchRepository,
  sha256,
  validateHarnessAdvisorAdapters,
  validateHarnessCodexAdapter,
  validateHarnessRoster,
  validateHarnessSquad,
  type ScratchRepository,
} from "./real-mission-e2e-workspace";
import {
  buildRealMissionParticipation,
  expectedRealMissionAdvisors,
} from "./real-mission-e2e-participation";
import { sealRealMissionE2EContextAttestations } from "./real-mission-e2e-prevc";
import { stageRealMissionCodexTrust } from "./real-mission-codex-trust";
import { createRealMissionEvidenceAttester } from "./real-mission-e2e-attestation";

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

function scheduleProductWizardTrustedLaunchClicks(
  sender: WebContents,
  isSettled: () => boolean,
  onGaveUp?: () => void,
): () => void {
  let attempts = 0;
  let clicked = false;
  let sawButton = false;
  let sawDisabled = false;
  const timer = setInterval(() => {
    if (isSettled() || clicked || sender.isDestroyed() || sender.isCrashed()) {
      clearInterval(timer);
      return;
    }
    attempts += 1;
    if (attempts > 120) {
      clearInterval(timer);
      console.error(
        "[real-mission] product-wizard-launch-gave-up " +
          `attempts=${attempts} sawButton=${sawButton} sawDisabled=${sawDisabled}`,
      );
      onGaveUp?.();
      return;
    }
    void (async () => {
      try {
        if (sender.isDestroyed() || sender.isCrashed()) return;
        const state = (await sender.executeJavaScript(`(() => {
          const el = document.querySelector(
            '[data-nexus-real-mission-wizard-launch="true"]',
          );
          if (!(el instanceof HTMLElement)) return { kind: "missing" };
          const disabled =
            (el instanceof HTMLButtonElement && el.disabled) ||
            el.getAttribute("aria-disabled") === "true";
          const rect = el.getBoundingClientRect();
          if (rect.width < 1 || rect.height < 1) return { kind: "hidden" };
          if (disabled) {
            const title = el.getAttribute("title") || "";
            return { kind: "disabled", title };
          }
          return {
            kind: "ready",
            x: Math.round(rect.left + rect.width / 2),
            y: Math.round(rect.top + rect.height / 2),
          };
        })()`)) as
          | { kind: "missing" | "hidden" | "disabled"; title?: string }
          | { kind: "ready"; x: number; y: number };
        if (state.kind === "disabled") {
          sawButton = true;
          sawDisabled = true;
          if (attempts === 1 || attempts % 20 === 0) {
            console.warn(
              "[real-mission] product-wizard-launch-disabled " +
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
        clicked = true;
        clearInterval(timer);
        console.log(
          "[real-mission] PHASE phase=product-wizard-launch-clicked",
        );
      } catch {
        // Button may not be mounted yet; keep polling.
      }
    })();
  }, 250);
  return () => clearInterval(timer);
}

export function initRealMissionE2E(): void {
  if (!isCurrentProcessRealMissionE2E()) return;
  const launchSurface: RealMissionE2ELaunchSurface =
    isCurrentProcessRealMissionProductWizardE2E()
      ? "product-wizard"
      : "private-runner";
  // Variante de orquestrador selada pelo launcher (default codex): define o
  // roster do fixture, a cerca física e o nome do arquivo de evidência.
  const orchestratorCli = realMissionE2EOrchestratorCli();
  const evidenceFileName =
    orchestratorCli === "claude"
      ? REAL_MISSION_E2E_CLAUDE_ORCHESTRATOR_EVIDENCE_FILE
      : REAL_MISSION_E2E_EVIDENCE_FILE;
  const attestEvidence = createRealMissionEvidenceAttester({
    environment: process.env,
    appVersion: app.getVersion(),
    launchSurface,
  });
  resetRealMissionInteractionCapture();
  installRealMissionDialogInstrumentation();

  const startedAt = Date.now();
  const runId = `run-${randomUUID()}`;
  const rendererFailureToken = randomBytes(32).toString("hex");
  const evidenceFile = path.join(
    app.getPath("userData"),
    evidenceFileName,
  );
  let scratch: ScratchRepository | null = null;
  let owner: WebContents | null = null;
  let observer: RealMissionObserver | null = null;
  let observedMissionId: string | null = null;
  let productWizardReceiptAuthority:
    | RealMissionProductWizardReceiptAuthority
    | null = null;
  let missionInventoryFence: RealMissionE2EMissionInventoryFence | null = null;
  let missionInventorySuite: ProjectDomainStoreSuite | null = null;
  let unsubscribeProductWizardMission: (() => void) | null = null;
  let fixturePrepared = false;
  let settled = false;

  const fallbackEvidence = (
    failureCode: FailureCode,
  ): RealMissionE2EEvidence => attestEvidence({
    schemaVersion: REAL_MISSION_E2E_EVIDENCE_SCHEMA_VERSION,
    runId,
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
    wizardReceipt: null,
    runtimeAttestation: null,
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
    // Mesmo no fechamento de falha o roster advisor é registrado: skipped por
    // env ficam marcados e as credenciadas constam sem recibos físicos.
    participation: buildRealMissionParticipation({
      expectations: expectedRealMissionAdvisors(
        realMissionE2EAdvisorSkipClis(),
        { orchestratorCli },
      ),
      ptyByCli: new Map(),
      dispatches: [],
      handoffIssuedAt: () => null,
      firstNexusToolAt: () => null,
    }),
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
    observedMissionId = null;
    unsubscribeProductWizardMission?.();
    unsubscribeProductWizardMission = null;
    // The observer can reach a final verdict while the renderer is still
    // unwinding a trusted launch click (for example, approval transitions the
    // mission to blocked before the queued `approval-returned` receipt edge).
    // Keep terminal acknowledgements installed until process teardown so that
    // finalization cannot orphan an already-authorized renderer invoke.
    productWizardReceiptAuthority?.quiesce();
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
          `evidence=${evidenceFileName}`,
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
        orchestratorCli,
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

  if (launchSurface === "product-wizard") {
    productWizardReceiptAuthority =
      installRealMissionProductWizardReceiptAuthority({
        owner: () => owner,
        scratchPath: () => scratch?.workspacePath ?? null,
        runId,
        observerArmed: (missionId) =>
          observer !== null && observedMissionId === missionId,
        onInvalid: () => finish("observer-invalid"),
      });
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
      runId,
      scratch,
      suite,
      missionId: mission.id,
      launchSurface,
      squadBinding,
      acceptanceCriteria,
      missionInventoryFence: exactInventory,
      wizardReceiptForMission: (missionId) =>
        productWizardReceiptAuthority?.receiptForMission(missionId) ?? null,
      attestEvidence,
      onFinish: finish,
      orchestratorCli,
    });
    observer.start();
    observedMissionId = mission.id;
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
      if (candidates.length > 1) {
        console.error(
          "[real-mission] observer-invalid reason=multiple-preapproval-missions " +
            `count=${candidates.length}`,
        );
        finish("observer-invalid");
        return;
      }
      const mission = candidates[0];
      if (!mission) return;
      const squadBinding = productWizardSquadBinding(mission);
      if (!squadBinding || !validateHarnessRoster()) {
        console.error(
          "[real-mission] observer-invalid reason=roster-or-binding " +
            `binding=${squadBinding ? "ok" : "null"} ` +
            `squad=${validateHarnessSquad()} ` +
            `codex=${validateHarnessCodexAdapter()} ` +
            `advisors=${validateHarnessAdvisorAdapters()} ` +
            `missionSquad=${mission.squadId}`,
        );
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
      } catch (error) {
        console.error(
          "[real-mission] observer-invalid reason=arm-observer-threw " +
            `${error instanceof Error ? error.message : String(error)}`,
        );
        if (!settled) finish("observer-invalid");
      }
    };
    unsubscribeProductWizardMission = suite.missions.onChange(evaluate);
    evaluate();
    console.log("[real-mission] PHASE phase=product-wizard-ready");
    // Physical gate requires Event.isTrusted on the launch control. Synthesize
    // a main-owned input event so unattended release:candidate can proceed.
    const stopLaunchClicks = scheduleProductWizardTrustedLaunchClicks(
      sender,
      () => settled,
      () => {
        if (!settled) finish("setup-failed");
      },
    );
    const previousUnsubscribe = unsubscribeProductWizardMission;
    unsubscribeProductWizardMission = () => {
      stopLaunchClicks();
      previousUnsubscribe?.();
    };
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
        // Seal context attestations once the live project scope is known so
        // guided PREVC bootstrap (before any orchestrator PTY) can pass the
        // doctor readiness gate. Freeze still re-seals if needed.
        sealRealMissionE2EContextAttestations(currentScope);
        fixturePrepared = true;
        console.log("[real-mission] PHASE phase=fixture-prepared");
        if (launchSurface === "product-wizard") {
          observeProductWizardMission(event.sender);
        }
        return { ok: true };
      } catch (error) {
        const detail =
          error instanceof Error ? error.message : String(error ?? "unknown");
        console.error(
          `[real-mission] fixture persist failed: ${detail.slice(0, 400)}`,
        );
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
      !validateHarnessRoster()
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
      realMissionE2EAcceptanceCriteria(orchestratorCli),
    );
    return { ok: true };
  });

  ipcMain.on(WINDOW_CHANNELS.mounted, onMounted);
}
