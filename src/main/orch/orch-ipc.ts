import { BrowserWindow, dialog, ipcMain } from "electron";
import type { WebContents } from "electron";
import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { ORCH_CHANNELS } from "../../shared/orch-channels";
import type { ProjectExecutionScope } from "../../shared/types";
import {
  missionPatchSchema,
  browserPaneOpenResultSchema,
  orchPaneSpawnResultSchema,
  missionPaneRecoveryResultSchema,
  panesSyncSchema,
  squadSchema,
  type Mission,
} from "../../shared/orch-types";
import { getDb } from "../persistence/db";
import type { ProjectRuntimeManager } from "../runtime/project-runtime-manager";
import {
  onRendererWorkspaceScopeChange,
  requireLiveRendererWorkspaceScope,
  requireRendererWorkspaceScope,
} from "../persistence/renderer-workspace-scope";
import {
  initSquadStore,
  listSquads,
  applyPreparedSquadSave,
  applyPreparedSquadsImport,
  deleteSquad,
  onSquadsChange,
  exportSquadsJson,
  prepareSquadSave,
  prepareSquadsImport,
  MAX_SQUADS_IMPORT_BYTES,
  type PreparedSquadsImport,
} from "./squad-store";
import {
  designSquadForWorkspace,
  designSquadFromIntent,
} from "./squad-architect";
import {
  loadEnrichedCatalog,
  runHarnessEnrichWithBrain,
} from "./harness-enrich";
import {
  registerBgTaskEventTarget,
  unregisterBgTaskEventTarget,
} from "./bg-task-events";
import {
  registerLoginStuckTarget,
  unregisterLoginStuckTarget,
} from "./login-stuck-watchdog";
import {
  initPaneRegistry,
  listPaneSnapshots,
  registerOrchRenderer,
  resolveBrowserOpen,
  resolvePaneSpawn,
  resolveMissionPaneRecovery,
  syncPanes,
  unregisterOrchRenderer,
} from "./pane-registry";
import { listOmpRpcSessions } from '../adapters/omp-rpc-ipc';
import { listAgentSessions } from '../pty/pty-manager';
import {
  RendererMissionAuthority,
  type RendererMissionAuthorityCandidate,
  type RendererMissionLifecycleCandidate,
} from "./renderer-mission-authority";
import { deleteMissionPromptQueue } from "./mission-prompt-queue-registry";
import {
  ProjectDomainStoreRegistry,
  configureProjectDomainStoreRegistry,
  disposeProjectDomainStoreRegistry,
  type ProjectDomainStoreSuite,
  type ProjectDomainStoreName,
} from "./project-domain-store-registry";
import { broadcastToProject } from "./project-scoped-broadcast";
import {
  initIdleDelivery,
  redeliverPendingHandoffs,
  shutdownIdleDelivery,
} from "./idle-delivery";
import {
  requestMissionRuntimeAuthorityReconciliation,
  startOrchestrationCoordinator,
  stopOrchestrationCoordinator,
} from './orchestration-coordinator';
import { stopAllPreviews } from "./preview-server";
import { stopRemoteBridge } from "../remote/remote-bridge";
import { buildRecipeOverlay } from "./recipe-overlay";
import {
  assertValidCatalogOverlayPatch,
  proposeRecipes,
  saveCatalogOverlay,
} from "./catalog-overlay";
import {
  prepareAgentSpecWrite,
  writeAgentSpec,
  type AgentSpecWriteCandidate,
} from "./agent-spec-writer";
import {
  confirmationReason,
  requiresConfirmation,
} from "../jarvis/guardrails";
import {
  getMcpRuntimeInfo,
  getToolCatalog,
  startMcpServer,
  stopMcpServer,
} from "./mcp-server";
import {
  getCatalogIndex,
  installCatalogItem,
  listHookHomes,
  listInstalledCatalogItems,
  listPluginFiles,
  reviewCatalogInstall,
  type CatalogInstallReview,
  type CatalogPreparedInstall,
} from "./catalog";
import { DesignMdApiClient } from "../design/designmd-api-client";
import { buildDesignSystemTools } from "./tools-design-system";
import type { AgentGateContext } from "./gate";
import { reconcileCompletedPetStudioMissions } from "./pet-studio-completion";
import { requestMissionDriverTick } from "./mission-driver-runtime";
import { z } from "zod";
import { submitMissionKickoffFromRenderer } from './mission-kickoff';
import { getOrchSettings } from '../persistence/settings-store';
import { PET_STUDIO_SQUAD_ID } from '../../shared/pet-studio';
import {
  persistOperatorReviewFeedback,
  prepareOperatorReviewAuthorityCandidate,
  type OperatorReviewAuthorityCandidate,
} from './operator-review-feedback';
import {
  persistClarifyAnswer,
  prepareClarifyAnswerAuthorityCandidate,
  type ClarifyAnswerAuthorityCandidate,
} from './clarify-flow';
import {
  bootstrapMissionOrchestratorForScope,
  bootstrapMissionOrchestratorFromRenderer,
} from './mission-orchestrator-bootstrap';
import {
  snapshotSquadAuthority,
  squadAuthorityReviewStrings,
  type SquadAuthoritySnapshot,
} from './squad-authority-snapshot';
import {
  settleMissionRuntimeDemotion,
} from './mission-runtime-termination';
import { issueImmediateSquadSpawnGrant } from './spawn-authority';
import { BoundedAsyncOperationPool } from './bounded-async-operation-pool';

/**
 * Renderer-facing IPC for the orchestration domain, plus the domain
 * bootstrap. Every renderer payload is zod-validated at this boundary.
 */

const listeners = new Set<WebContents>();
const missionRemovalConfirmations = new WeakSet<WebContents>();
const missionAuthorityConfirmations = new WeakSet<WebContents>();
const immediateSquadConfirmations = new WeakSet<WebContents>();
const squadMutationConfirmations = new WeakSet<WebContents>();
const operatorAttestationConfirmations = new WeakSet<WebContents>();
const catalogInstallConfirmations = new WeakSet<WebContents>();
const catalogInstallTargets = new Set<string>();
const squadDesignPool = new BoundedAsyncOperationPool<unknown>({
  maxConcurrent: 2,
  maxCacheEntries: 32,
  ttlMs: 60_000,
});
const harnessEnrichPool = new BoundedAsyncOperationPool<unknown>({
  maxConcurrent: 1,
  maxCacheEntries: 0,
  ttlMs: 0,
});
let squadFileOperationPending = false;
export const ASYNC_ENRICHMENT_TIMEOUT_MS = 120_000;
const designSystemsSearchPool = new BoundedAsyncOperationPool<unknown>({
  maxConcurrent: 1,
  maxCacheEntries: 32,
  ttlMs: 60_000,
});
let rendererMissionAuthority: RendererMissionAuthority | null = null;
let projectDomainStores: ProjectDomainStoreRegistry | null = null;
let orchestrationInitFlight: Promise<void> | null = null;
let orchestrationCloseFlight: Promise<void> | null = null;
let orchestrationLifecycleEpoch = 0;
let orchestrationReady = false;
let orchestrationClosing = false;
let orchestrationShutdownBlocked = false;
let disposeSquadBroadcast: (() => void) | null = null;

function projectExecutionScopeKey(scope: ProjectExecutionScope): string {
  return [
    scope.version,
    scope.installationId,
    scope.projectId,
    scope.checkoutId,
    scope.rootRealPath,
    scope.identitySource,
  ].join('\0');
}

interface RendererAsyncAuthorityFence {
  readonly signal: AbortSignal;
  assertCurrentAuthority(): void;
  waitFor<T>(effect: Promise<T>): Promise<T>;
  dispose(): void;
}

function rendererAsyncAuthorityFence(
  owner: WebContents,
  scope: ProjectExecutionScope,
): RendererAsyncAuthorityFence {
  const controller = new AbortController();
  let rejectRevocation!: (reason: Error) => void;
  const revocation = new Promise<never>((_resolve, reject) => {
    rejectRevocation = reject;
  });
  // A fence can be revoked just before a caller attaches its race. Keep the
  // rejection observed without changing the promise used by `waitFor`.
  void revocation.catch(() => undefined);
  const revoke = (reason: unknown): void => {
    if (controller.signal.aborted) return;
    const error =
      reason instanceof Error
        ? reason
        : new Error('renderer workspace authority changed');
    controller.abort(error);
    rejectRevocation(error);
  };
  const assertCurrentAuthority = (): void => {
    if (controller.signal.aborted) {
      if (controller.signal.reason instanceof Error) {
        throw controller.signal.reason;
      }
      throw new Error('renderer workspace authority changed');
    }
    try {
      requireLiveRendererWorkspaceScope(owner, scope);
    } catch (error) {
      revoke(error);
      throw error;
    }
  };
  const unsubscribeScope = onRendererWorkspaceScopeChange((changedOwner) => {
    if (changedOwner.id !== owner.id) return;
    try {
      assertCurrentAuthority();
    } catch {
      // The AbortSignal carries the exact revocation reason to in-flight I/O.
    }
  });
  const eventOwner = owner as WebContents & {
    on?: (event: string, listener: (...args: unknown[]) => void) => void;
    removeListener?: (
      event: string,
      listener: (...args: unknown[]) => void,
    ) => void;
  };
  const onUnavailable = (): void =>
    revoke(new Error('renderer is unavailable'));
  const deadline = setTimeout(
    () => revoke(new Error('async enrichment deadline exceeded')),
    ASYNC_ENRICHMENT_TIMEOUT_MS,
  );
  deadline.unref?.();
  eventOwner.on?.('destroyed', onUnavailable);
  eventOwner.on?.('render-process-gone', onUnavailable);

  return {
    signal: controller.signal,
    assertCurrentAuthority,
    waitFor: <T>(effect: Promise<T>) => Promise.race([effect, revocation]),
    dispose: () => {
      clearTimeout(deadline);
      unsubscribeScope();
      eventOwner.removeListener?.('destroyed', onUnavailable);
      eventOwner.removeListener?.('render-process-gone', onUnavailable);
    },
  };
}

export const missionSubmitIntentSchema = z.object({
  missionId: z.string().min(1).max(128),
  goal: z.string().min(1).max(16_384),
  source: z.enum(["typed", "voice", "imported-issue", "automation"]).optional(),
  contextPolicy: z.enum(["none", "minimal", "on-demand"]).optional(),
  acceptanceCriteria: z.array(z.string().min(1).max(2_048)).max(32).optional(),
  lane: z.enum(["standard", "consult", "plan", "ops"]).optional(),
  evidenceAttached: z.boolean().optional(),
});

export const missionApproveIntentSchema = z
  .object({
    missionId: z.string().min(1).max(128),
    evidenceAttached: z.boolean().optional(),
    attachmentPaths: z.array(z.string().min(1).max(4_096)).max(6).optional(),
  })
  .strict();

export const missionOrchestratorBootstrapSchema = z
  .object({
    missionId: z.string().min(1).max(128),
  })
  .strict();

export const missionRemoveSchema = z
  .object({
    missionId: z.string().min(1).max(128),
  })
  .strict();

const agentSpecWriteSchema = z.object({
  name: z.string().min(1).max(96),
  tools: z.array(z.string().min(1).max(128)).max(128).optional(),
  skills: z.array(z.string().min(1).max(128)).max(128).optional(),
  model: z.string().max(128).optional(),
  effort: z.string().max(32).optional(),
  category: z.string().max(64).optional(),
  systemPrompt: z.string().max(65_536).optional(),
});
const AGENT_SPEC_WRITE_TOOL = "nexus_agent_spec_write";

function safeDialogLabel(value: string, maxChars = 256): string {
  return value
    .replace(/[\0-\x1f\x7f\u202a-\u202e\u2066-\u2069]+/g, " ")
    .trim()
    .slice(0, maxChars);
}

const OPERATOR_DIALOG_FORBIDDEN =
  /[\0-\x08\x0b\x0c\x0e-\x1f\x7f\u202a-\u202e\u2066-\u2069]/u;
const MAX_OPERATOR_DIALOG_CHARS = 16_000;

function assertExactOperatorDialog(detail: string): string {
  if (OPERATOR_DIALOG_FORBIDDEN.test(detail)) {
    throw new Error('operator_review_unsafe: conteúdo contém controles invisíveis');
  }
  if (detail.length > MAX_OPERATOR_DIALOG_CHARS) {
    throw new Error(
      `operator_review_too_large: reduza a revisão para ${MAX_OPERATOR_DIALOG_CHARS} caracteres`,
    );
  }
  return detail;
}

async function confirmClarifyAnswer(
  owner: WebContents,
  scope: ProjectExecutionScope,
  candidate: ClarifyAnswerAuthorityCandidate,
): Promise<boolean> {
  const window = BrowserWindow.fromWebContents(owner);
  if (!window || window.isDestroyed()) throw new Error('renderer window is unavailable');
  if (operatorAttestationConfirmations.has(owner)) {
    throw new Error('operator confirmation is already pending');
  }
  const options = candidate.chips.length
    ? candidate.chips.map((chip, index) => `  ${index + 1}. ${chip.label} [${chip.id}]`).join('\n')
    : '  (resposta livre)';
  const answer = candidate.answer.kind === 'chip'
    ? `${candidate.answer.value} [${candidate.answer.chipId}]`
    : candidate.answer.value;
  const detail = assertExactOperatorDialog(
    `Workspace: ${scope.rootRealPath}\n` +
    `Missão: ${candidate.missionTitle}\n` +
    `ID: ${candidate.missionId}\n` +
    `Versão da intenção: ${candidate.intentVersion}\n` +
    `Sessão do orquestrador: ${candidate.orchestratorSessionId}\n` +
    `Pergunta (${candidate.questionId}):\n${candidate.question}\n\n` +
    `Opções:\n${options}\n` +
    `Resposta exata a entregar:\n${answer}\n\n` +
    'Somente esta resposta, para esta revisão e sessão, será autorizada.',
  );
  operatorAttestationConfirmations.add(owner);
  try {
    const result = await dialog.showMessageBox(window, {
      type: 'question',
      title: 'Nexus IDE — responder ao orquestrador',
      buttons: ['Negar', 'Confirmar resposta'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      message: 'Entregar esta resposta humana à missão em execução?',
      detail,
    });
    return result.response === 1;
  } finally {
    operatorAttestationConfirmations.delete(owner);
  }
}

async function confirmOperatorReview(
  owner: WebContents,
  scope: ProjectExecutionScope,
  candidate: OperatorReviewAuthorityCandidate,
): Promise<boolean> {
  const window = BrowserWindow.fromWebContents(owner);
  if (!window || window.isDestroyed()) throw new Error('renderer window is unavailable');
  if (operatorAttestationConfirmations.has(owner)) {
    throw new Error('operator confirmation is already pending');
  }
  const annotations = candidate.annotations
    .map((annotation, index) =>
      `${index + 1}. ${annotation.path}:${annotation.line}\n${annotation.body}`,
    )
    .join('\n\n');
  const detail = assertExactOperatorDialog(
    `Workspace: ${scope.rootRealPath}\n` +
    `Missão: ${candidate.missionTitle}\n` +
    `ID: ${candidate.missionId}\n` +
    `Versão da intenção: ${candidate.intentVersion}\n` +
    `Sessão do orquestrador: ${candidate.orchestratorSessionId}\n\n` +
    `Anotações integrais:\n${annotations}\n\n` +
    'Somente estas anotações, para esta revisão e sessão, serão autorizadas.',
  );
  operatorAttestationConfirmations.add(owner);
  try {
    const result = await dialog.showMessageBox(window, {
      type: 'warning',
      title: 'Nexus IDE — entregar revisão humana',
      buttons: ['Negar', 'Entregar revisão'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      message: 'Enviar estas instruções de correção ao orquestrador?',
      detail,
    });
    return result.response === 1;
  } finally {
    operatorAttestationConfirmations.delete(owner);
  }
}

async function confirmAgentSpecWrite(
  owner: WebContents,
  scope: ProjectExecutionScope,
  candidate: AgentSpecWriteCandidate,
): Promise<boolean> {
  const patch = candidate.patch;
  const args: Record<string, unknown> = { ...patch };
  if (!requiresConfirmation(AGENT_SPEC_WRITE_TOOL, args)) {
    throw new Error("agent spec confirmation policy is unavailable");
  }
  const window = BrowserWindow.fromWebContents(owner);
  if (!window || window.isDestroyed()) {
    throw new Error("renderer window is unavailable");
  }
  const result = await dialog.showMessageBox(window, {
    type: "warning",
    title: "Nexus IDE — autorização de agente",
    buttons: ["Negar", "Permitir"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    message: "Gravar especificação global de agente?",
    detail:
      `Workspace solicitante: ${safeDialogLabel(scope.rootRealPath, 512)}\n` +
      `Agente: ${safeDialogLabel(patch.name, 96)}\n` +
      `Arquivo: ${safeDialogLabel(candidate.path, 4_096)}\n` +
      `Motivo: ${confirmationReason(AGENT_SPEC_WRITE_TOOL, args)}\n\n` +
      "Conteúdo final integral (inclui tools, skills e system prompt):\n\n" +
      candidate.nextContents,
  });
  return result.response === 1;
}

async function confirmCatalogInstallSource(
  owner: WebContents,
  scope: ProjectExecutionScope,
  candidate: CatalogInstallReview,
): Promise<boolean> {
  const window = BrowserWindow.fromWebContents(owner);
  if (!window || window.isDestroyed()) {
    throw new Error("renderer window is unavailable");
  }
  const result = await dialog.showMessageBox(window, {
    type: "warning",
    title: "Nexus IDE — revisar fonte do catálogo",
    buttons: ["Negar", "Baixar para inspeção"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    message: "Baixar este componente externo para uma área privada de inspeção?",
    detail:
      `Workspace solicitante: ${safeDialogLabel(scope.rootRealPath, 4_096)}\n` +
      `Repositório: ${safeDialogLabel(candidate.repository, 256)}\n` +
      `Commit imutável: ${candidate.commitSha}\n` +
      `Tipo: ${candidate.kind}\n` +
      `Slug integral: ${safeDialogLabel(candidate.slug, 512)}\n` +
      `Destino canônico: ${safeDialogLabel(candidate.targetPath, 4_096)}\n\n` +
      "Este primeiro consentimento apenas autoriza download, scan e staging privado. " +
      "Uma segunda confirmação exibirá o digest exato antes da publicação.",
  });
  return result.response === 1;
}

async function confirmCatalogInstallPayload(
  owner: WebContents,
  scope: ProjectExecutionScope,
  candidate: CatalogPreparedInstall,
): Promise<boolean> {
  const window = BrowserWindow.fromWebContents(owner);
  if (!window || window.isDestroyed()) {
    throw new Error("renderer window is unavailable");
  }
  const visibleWarnings = candidate.warnings.slice(0, 8);
  const hiddenWarnings = candidate.warnings.length - visibleWarnings.length;
  const binaryWarnings = candidate.warnings.filter((warning) =>
    /binário|não textual/i.test(warning),
  ).length;
  const warnings = visibleWarnings.length > 0
    ? visibleWarnings.map((warning, index) =>
        `  ${index + 1}. ${safeDialogLabel(warning, 400)}`,
      ).join("\n") +
      (hiddenWarnings > 0
        ? `\n  … ${hiddenWarnings} alerta(s) adicional(is) oculto(s) neste resumo.`
        : "")
    : "  (nenhum alerta heurístico)";
  const result = await dialog.showMessageBox(window, {
    type: candidate.warnings.length > 0 ? "warning" : "question",
    title: "Nexus IDE — autorizar instalação do catálogo",
    buttons: ["Negar", "Instalar bytes revisados"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    message: "Publicar este payload externo nas instruções globais do CLI?",
    detail:
      `Workspace solicitante: ${safeDialogLabel(scope.rootRealPath, 4_096)}\n` +
      `Repositório: ${safeDialogLabel(candidate.repository, 256)}\n` +
      `Commit imutável: ${candidate.commitSha}\n` +
      `Tipo/slug: ${candidate.kind} / ${safeDialogLabel(candidate.slug, 512)}\n` +
      `Destino canônico: ${safeDialogLabel(candidate.targetPath, 4_096)}\n` +
      `SHA-256 agregado: ${candidate.sha256}\n` +
      `Arquivos: ${candidate.fileCount}\n` +
      `Bytes: ${candidate.totalBytes}\n` +
      `Alertas do scan: ${candidate.warnings.length} total; ` +
      `${binaryWarnings} arquivo(s) binário(s)/não textual(is) não inspecionado(s).\n` +
      `${warnings}\n\n` +
      "O scan é heurístico e não prova autenticidade ou ausência de comportamento malicioso.\n" +
      "A instalação é global para CLIs futuras e publicará somente este digest.",
  });
  return result.response === 1;
}

async function confirmMissionRemoval(
  owner: WebContents,
  scope: ProjectExecutionScope,
  candidate: { missionId: string; title: string },
): Promise<boolean> {
  const window = BrowserWindow.fromWebContents(owner);
  if (!window || window.isDestroyed()) {
    throw new Error("renderer window is unavailable");
  }
  if (missionRemovalConfirmations.has(owner)) {
    throw new Error("mission removal confirmation is already pending");
  }
  missionRemovalConfirmations.add(owner);
  try {
    const result = await dialog.showMessageBox(window, {
      type: "warning",
      title: "Nexus IDE — remover rascunho",
      buttons: ["Cancelar", "Remover rascunho"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      message: "Remover este rascunho de missão vazio?",
      detail:
        `Workspace: ${safeDialogLabel(scope.rootRealPath, 512)}\n` +
        `Missão: ${safeDialogLabel(candidate.title, 256)}\n` +
        `ID: ${safeDialogLabel(candidate.missionId, 128)}\n\n` +
        "Missões ativas, concluídas ou com panes, tasks, handoffs e receipts " +
        "são preservadas e não podem ser removidas por esta ação.",
    });
    return result.response === 1;
  } finally {
    missionRemovalConfirmations.delete(owner);
  }
}

async function confirmMissionAuthorityChange(
  owner: WebContents,
  scope: ProjectExecutionScope,
  candidate: RendererMissionAuthorityCandidate,
  action: "approve" | "promote",
): Promise<boolean> {
  const window = BrowserWindow.fromWebContents(owner);
  if (!window || window.isDestroyed()) {
    throw new Error("renderer window is unavailable");
  }
  if (missionAuthorityConfirmations.has(owner)) {
    throw new Error("mission authority confirmation is already pending");
  }
  missionAuthorityConfirmations.add(owner);
  try {
    const isPromotion = action === "promote";
    const budgets = candidate.budgets;
    const criteria = candidate.acceptanceCriteria.length
      ? candidate.acceptanceCriteria
          .map(
            (criterion, index) =>
              `  ${index + 1}. ${safeDialogLabel(criterion, 6_000)}`,
          )
          .join("\n")
      : "  (nenhum)";
    const deniedTools = candidate.deniedTools.length
      ? candidate.deniedTools
          .map((tool) => safeDialogLabel(tool, 128))
          .join(", ")
      : "(nenhuma)";
    const attachments = candidate.attachmentPaths.length
      ? candidate.attachmentPaths
          .map(
            (attachment, index) =>
              `  ${index + 1}. ${safeDialogLabel(attachment, 4_096)}`,
          )
          .join("\n")
      : "  (nenhum)";
    const attachmentDigests = candidate.attachmentSnapshots.length
      ? candidate.attachmentSnapshots
          .map(
            (attachment, index) =>
              `  ${index + 1}. ${safeDialogLabel(attachment.path, 4_096)}\n` +
              `     SHA-256: ${attachment.sha256}\n` +
              `     Bytes: ${attachment.size}`,
          )
          .join("\n")
      : "  (nenhum)";
    const squadRoster = candidate.squad.agents.length
      ? candidate.squad.agents
          .map(
            (agent, index) =>
              `  ${index + 1}. ${safeDialogLabel(agent.agentName, 256)} ` +
              `(${safeDialogLabel(agent.category, 64)}, cli=${safeDialogLabel(agent.cli, 128)}, ` +
              `model=${safeDialogLabel(agent.model ?? "default", 256)}, ` +
              `effort=${safeDialogLabel(agent.effort ?? "default", 64)})\n` +
              `     tools=${(agent.allowedTools ?? []).map((tool) => safeDialogLabel(tool, 128)).join(", ") || "(default)"}\n` +
              `     skills=${(agent.allowedSkills ?? []).map((skill) => safeDialogLabel(skill, 128)).join(", ") || "(nenhuma)"}`,
          )
          .join("\n")
      : "  (vazio)";
    const runtime = candidate.orchestratorRuntime;
    const result = await dialog.showMessageBox(window, {
      type: candidate.risk === "destructive" ? "warning" : "question",
      title: isPromotion
        ? "Nexus IDE — promover plano"
        : "Nexus IDE — iniciar missão",
      buttons: ["Negar", isPromotion ? "Promover e executar" : "Aprovar e iniciar"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      message: isPromotion
        ? "Permitir que este plano passe a executar mudanças?"
        : "Aprovar esta missão e liberar sua execução?",
      detail:
        `Workspace: ${safeDialogLabel(scope.rootRealPath, 4_096)}\n` +
        `Missão: ${safeDialogLabel(candidate.title, 512)}\n` +
        `ID: ${safeDialogLabel(candidate.missionId, 128)}\n` +
        `Objetivo integral: ${safeDialogLabel(candidate.goal, 6_000)}\n` +
        `Lane atual: ${safeDialogLabel(candidate.lane, 32)}\n` +
        `Modo: ${safeDialogLabel(candidate.executionMode, 32)}\n` +
        `Contexto: ${safeDialogLabel(candidate.contextPolicy, 32)}\n` +
        `Risco: ${safeDialogLabel(candidate.risk, 32)}\n` +
        `Versão da intenção: ${candidate.intentVersion}\n` +
        `Limites: ${budgets.maxWorkers} worker(s), ` +
        `${budgets.planningTokens} tokens de planejamento, ` +
        `${budgets.executionTokens} tokens de execução` +
        (budgets.maxSteps === undefined ? "" : `, ${budgets.maxSteps} etapas`) +
        `\nEvidência anexada: ${candidate.evidenceAttached ? "sim" : "não"}\n` +
        `Critérios de aceite:\n${criteria}\n` +
        `Anexos canônicos:\n${attachments}\n` +
        `Conteúdo aprovado dos anexos:\n${attachmentDigests}\n` +
        `Ferramentas negadas: ${deniedTools}\n\n` +
        `Squad salvo: ${safeDialogLabel(candidate.squad.name, 512)} ` +
        `(${safeDialogLabel(candidate.squad.id, 128)})\n` +
        `Hash do squad: ${candidate.squad.hash}\n` +
        `Instruções integrais do orquestrador:\n${safeDialogLabel(candidate.squad.orchestratorInstructions, 6_000)}\n` +
        `Roster/capacidades integrais:\n${squadRoster}\n\n` +
        `Runtime inicial exato:\n` +
        `  adapter=${safeDialogLabel(runtime.adapterId, 64)}\n` +
        `  model=${safeDialogLabel(runtime.model ?? "(default explícito do provider)", 256)}\n` +
        `  account=${safeDialogLabel(runtime.accountId ?? "(sem conta gerenciada)", 128)}\n` +
        `  effort=${safeDialogLabel(runtime.effort ?? "(default explícito do provider)", 64)}\n` +
        `  Nexus MCP readOnly=${String(runtime.readOnly)}\n` +
        `  provider nativeReadOnly=${String(runtime.nativeReadOnly)}\n\n` +
        "A autorização vale somente para todo o conteúdo exibido acima. " +
        "Qualquer mudança exige nova confirmação.",
    });
    return result.response === 1;
  } finally {
    missionAuthorityConfirmations.delete(owner);
  }
}

async function confirmMissionLifecycleDemotion(
  owner: WebContents,
  scope: ProjectExecutionScope,
  candidate: RendererMissionLifecycleCandidate,
): Promise<boolean> {
  const window = BrowserWindow.fromWebContents(owner);
  if (!window || window.isDestroyed()) {
    throw new Error("renderer window is unavailable");
  }
  if (missionAuthorityConfirmations.has(owner)) {
    throw new Error("mission authority confirmation is already pending");
  }
  missionAuthorityConfirmations.add(owner);
  try {
    const result = await dialog.showMessageBox(window, {
      type: "warning",
      title: "Nexus IDE — encerrar execução",
      buttons: ["Cancelar", candidate.toStatus === "blocked" ? "Bloquear missão" : "Marcar falha"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      message:
        candidate.toStatus === "blocked"
          ? "Bloquear esta missão e revogar todos os workers ativos?"
          : "Marcar esta missão como falha e revogar todos os workers ativos?",
      detail:
        `Workspace: ${safeDialogLabel(scope.rootRealPath, 4_096)}\n` +
        `Missão: ${safeDialogLabel(candidate.title, 512)}\n` +
        `ID: ${safeDialogLabel(candidate.missionId, 128)}\n` +
        `Transição: ${candidate.fromStatus} → ${candidate.toStatus}\n` +
        `Registro integral: ${safeDialogLabel(candidate.description, 6_000)}\n\n` +
        "Esta ação revoga imediatamente dispatch, merge e efeitos dos workers atuais.",
    });
    return result.response === 1;
  } finally {
    missionAuthorityConfirmations.delete(owner);
  }
}

interface ImmediateSquadLaunchCandidate {
  readonly squad: SquadAuthoritySnapshot;
  readonly paneId: string;
  readonly adapterId: string;
  readonly model?: string;
  readonly accountId?: string;
  readonly effort?: string;
  readonly missionTitle: string;
  readonly missionGoal: string;
}

async function confirmImmediateSquadLaunch(
  owner: WebContents,
  scope: ProjectExecutionScope,
  candidate: ImmediateSquadLaunchCandidate,
): Promise<boolean> {
  const window = BrowserWindow.fromWebContents(owner);
  if (!window || window.isDestroyed()) {
    throw new Error("renderer window is unavailable");
  }
  if (immediateSquadConfirmations.has(owner)) {
    throw new Error("immediate squad confirmation is already pending");
  }
  immediateSquadConfirmations.add(owner);
  try {
    const roster = candidate.squad.agents
      .map(
        (agent, index) =>
          `${index + 1}. ${safeDialogLabel(agent.agentName, 128)} ` +
          `(${safeDialogLabel(agent.category, 64)}, ` +
          `cli=${safeDialogLabel(agent.cli, 64)}, ` +
          `model=${safeDialogLabel(agent.model ?? "default", 128)}, ` +
          `effort=${safeDialogLabel(agent.effort ?? "default", 32)})\n` +
          `   tools=${(agent.allowedTools ?? []).join(", ") || "(default)"}\n` +
          `   skills=${(agent.allowedSkills ?? []).join(", ") || "(nenhuma)"}`,
      )
      .join("\n");
    const result = await dialog.showMessageBox(window, {
      type: "warning",
      title: "Nexus IDE — iniciar squad imediato",
      buttons: ["Cancelar", "Autorizar e iniciar"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      message:
        "Autorizar este runtime e objetivo exatos sem passar pelo wizard PREVC?",
      detail:
        `Workspace: ${safeDialogLabel(scope.rootRealPath, 4_096)}\n` +
        `Título: ${safeDialogLabel(candidate.missionTitle, 512)}\n` +
        `Objetivo/briefing integral:\n${safeDialogLabel(candidate.missionGoal, 16_384)}\n` +
        `Squad: ${safeDialogLabel(candidate.squad.name, 256)} ` +
        `(${safeDialogLabel(candidate.squad.id, 128)})\n` +
        `Hash: ${candidate.squad.hash}\n` +
        `Pane: ${safeDialogLabel(candidate.paneId, 128)}\n` +
        `Runtime: adapter=${safeDialogLabel(candidate.adapterId, 64)}, ` +
        `model=${safeDialogLabel(candidate.model ?? "default", 128)}, ` +
        `account=${safeDialogLabel(candidate.accountId ?? "none", 128)}, ` +
        `effort=${safeDialogLabel(candidate.effort ?? "default", 32)}\n\n` +
        `Instruções do orquestrador:\n` +
        `${safeDialogLabel(candidate.squad.orchestratorInstructions, 6_000)}\n` +
        `Instruções nativas:\n` +
        `${safeDialogLabel(candidate.squad.nativeInstructions ?? "", 6_000)}\n` +
        `Roster/capacidades:\n${roster}\n\n` +
        "O grant é opaco, de uso único e preso a todo o conteúdo acima.",
    });
    return result.response === 1;
  } finally {
    immediateSquadConfirmations.delete(owner);
  }
}

function assertSquadReviewable(snapshot: SquadAuthoritySnapshot): void {
  const values = squadAuthorityReviewStrings(snapshot);
  const total = values.reduce((sum, value) => sum + value.length, 0);
  if (total > 6_000) {
    throw new Error('squad review exceeds 6000 characters; shorten it first');
  }
  if (
    values.some((value) =>
      /[\0-\x08\x0b\x0c\x0e-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(value),
    )
  ) {
    throw new Error('squad review contains invisible control characters');
  }
}

interface SquadFileFingerprint {
  readonly dev: string;
  readonly ino: string;
  readonly size: string;
  readonly mtimeNs: string;
}

interface SecureSquadImportRead extends SquadFileFingerprint {
  readonly filePath: string;
  readonly bytes: Buffer;
  readonly sha256: string;
}

function fingerprintOf(stat: fs.BigIntStats): SquadFileFingerprint {
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    size: String(stat.size),
    mtimeNs: String(stat.mtimeNs),
  };
}

function sameFileFingerprint(
  left: SquadFileFingerprint,
  right: SquadFileFingerprint,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs
  );
}

function assertRegularNonSymlink(
  stat: fs.BigIntStats,
  label: string,
): void {
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`${label} must be a regular file and not a symlink`);
  }
}

function secureReadSquadImportFile(filePath: string): SecureSquadImportRead {
  const beforePath = fs.lstatSync(filePath, { bigint: true });
  assertRegularNonSymlink(beforePath, 'squads import');
  if (beforePath.size > BigInt(MAX_SQUADS_IMPORT_BYTES)) {
    throw new Error('squads import exceeds the 1 MiB limit');
  }

  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    assertRegularNonSymlink(opened, 'squads import');
    if (
      String(beforePath.dev) !== String(opened.dev) ||
      String(beforePath.ino) !== String(opened.ino)
    ) {
      throw new Error('squads import file changed while it was opened');
    }
    if (opened.size > BigInt(MAX_SQUADS_IMPORT_BYTES)) {
      throw new Error('squads import exceeds the 1 MiB limit');
    }

    const bounded = Buffer.alloc(MAX_SQUADS_IMPORT_BYTES + 1);
    let offset = 0;
    while (offset < bounded.length) {
      const count = fs.readSync(
        fd,
        bounded,
        offset,
        bounded.length - offset,
        null,
      );
      if (count === 0) break;
      offset += count;
    }
    if (offset > MAX_SQUADS_IMPORT_BYTES) {
      throw new Error('squads import exceeds the 1 MiB limit');
    }

    const afterFd = fs.fstatSync(fd, { bigint: true });
    const afterPath = fs.lstatSync(filePath, { bigint: true });
    assertRegularNonSymlink(afterFd, 'squads import');
    assertRegularNonSymlink(afterPath, 'squads import');
    const openedFingerprint = fingerprintOf(opened);
    if (
      !sameFileFingerprint(openedFingerprint, fingerprintOf(afterFd)) ||
      !sameFileFingerprint(openedFingerprint, fingerprintOf(afterPath)) ||
      offset !== Number(opened.size)
    ) {
      throw new Error('squads import file changed during bounded read');
    }
    const bytes = Buffer.from(bounded.subarray(0, offset));
    return {
      filePath,
      ...openedFingerprint,
      bytes,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  } finally {
    fs.closeSync(fd);
  }
}

function assertSameSecureImportRead(
  before: SecureSquadImportRead,
  after: SecureSquadImportRead,
): void {
  if (
    before.filePath !== after.filePath ||
    before.sha256 !== after.sha256 ||
    !sameFileFingerprint(before, after)
  ) {
    throw new Error(
      'squads import file changed after native confirmation; choose it again',
    );
  }
}

function acquireSquadFileOperation(): () => void {
  if (squadFileOperationPending) {
    throw new Error('a squad import/export operation is already pending');
  }
  squadFileOperationPending = true;
  return () => {
    squadFileOperationPending = false;
  };
}

function existingExportTargetFingerprint(
  filePath: string,
): SquadFileFingerprint | null {
  try {
    const stat = fs.lstatSync(filePath, { bigint: true });
    assertRegularNonSymlink(stat, 'squads export target');
    return fingerprintOf(stat);
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code === 'ENOENT'
    ) {
      return null;
    }
    throw error;
  }
}

function assertExportTargetUnchanged(
  filePath: string,
  expected: SquadFileFingerprint | null,
): void {
  const current = existingExportTargetFingerprint(filePath);
  if (
    (expected === null) !== (current === null) ||
    (expected !== null &&
      current !== null &&
      !sameFileFingerprint(expected, current))
  ) {
    throw new Error('squads export target changed while publishing');
  }
}

function atomicWriteSelectedSquadsFile(
  filePath: string,
  bytes: Buffer,
): void {
  const expectedTarget = existingExportTargetFingerprint(filePath);
  const directory = path.dirname(filePath);
  const tempPath = path.join(
    directory,
    `.${path.basename(filePath)}.nexus-export-${process.pid}-${randomBytes(12).toString('hex')}`,
  );
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  let fd: number | null = null;
  let tempExists = false;
  try {
    fd = fs.openSync(
      tempPath,
      fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_WRONLY |
        noFollow,
      0o600,
    );
    tempExists = true;
    let offset = 0;
    while (offset < bytes.length) {
      offset += fs.writeSync(fd, bytes, offset, bytes.length - offset);
    }
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;

    assertExportTargetUnchanged(filePath, expectedTarget);
    if (expectedTarget) {
      fs.renameSync(tempPath, filePath);
      tempExists = false;
    } else {
      // Hard-link publication is exclusive: an attacker racing a new target
      // cannot make this write overwrite or follow anything.
      fs.linkSync(tempPath, filePath);
      fs.unlinkSync(tempPath);
      tempExists = false;
    }
    try {
      const directoryFd = fs.openSync(directory, fs.constants.O_RDONLY);
      try {
        fs.fsyncSync(directoryFd);
      } finally {
        fs.closeSync(directoryFd);
      }
    } catch {
      // The file is already atomically published. Some platforms do not
      // permit fsync on a directory descriptor.
    }
  } finally {
    if (fd !== null) fs.closeSync(fd);
    if (tempExists) {
      try {
        fs.unlinkSync(tempPath);
      } catch {
        // Preserve the original publication error.
      }
    }
  }
}

function assertSquadsNotExecuting(
  owner: WebContents,
  squadIds: readonly string[],
): void {
  const targetIds = new Set(squadIds);
  const currentSuite = requireProjectStores(owner);
  const suites = projectDomainStores?.listSuites() ?? [];
  const allSuites = suites.includes(currentSuite)
    ? suites
    : [currentSuite, ...suites];
  const missionIds = new Set<string>();
  const scopedMissionIds = new Set<string>();
  const targetScopeKeys = new Set<string>();
  for (const suite of allSuites) {
    for (const mission of suite.missions.list()) {
      if (!mission.squadId || !targetIds.has(mission.squadId)) continue;
      missionIds.add(mission.id);
      const scopeKey = projectExecutionScopeKey(suite.scope);
      scopedMissionIds.add(`${scopeKey}\0${mission.id}`);
      targetScopeKeys.add(scopeKey);
      if (mission.status === 'running') {
        throw new Error(
          `squad_in_use: missão ${mission.id} está running; bloqueie/finalize antes de alterar o squad`,
        );
      }
    }
  }
  const targetAgentIdentities = new Set(
    listSquads()
      .filter((squad) => targetIds.has(squad.id))
      .flatMap((squad) =>
        squad.agents.flatMap((agent) => [agent.id, agent.agentName]),
      ),
  );
  const pty = listAgentSessions().find((session) => {
    if (session.squadId && targetIds.has(session.squadId)) return true;
    const scopeKey = projectExecutionScopeKey(session.scope);
    if (
      session.missionId &&
      scopedMissionIds.has(`${scopeKey}\0${session.missionId}`)
    ) {
      return true;
    }
    // Older detached PTYs may lack missionId/squadId. Bind the fallback to
    // both the exact project scope and a saved roster identity.
    return (
      !session.squadId &&
      !session.missionId &&
      targetScopeKeys.has(scopeKey) &&
      Boolean(
        session.agentName &&
          targetAgentIdentities.has(session.agentName),
      )
    );
  });
  if (pty) {
    throw new Error(
      `squad_in_use: inventário físico PTY ${pty.sessionId} ainda está ativo`,
    );
  }
  const pane = listPaneSnapshots().find(
    (snapshot) => {
      if (!snapshot.missionId) return false;
      const paneScope = snapshot.scope ?? snapshot.executionScope;
      const belongsToTarget = paneScope
        ? scopedMissionIds.has(
            `${projectExecutionScopeKey(paneScope)}\0${snapshot.missionId}`,
          )
        : missionIds.has(snapshot.missionId);
      return (
        belongsToTarget &&
        snapshot.state !== 'exited' &&
        snapshot.state !== 'hibernated'
      );
    },
  );
  if (pane) {
    throw new Error(
      `squad_in_use: inventário físico do pane ${pane.paneId} ainda está ${pane.state}`,
    );
  }
  const omp = listOmpRpcSessions().find(
    (session) =>
      Boolean(session.missionId && missionIds.has(session.missionId)) &&
      session.state !== 'exited',
  );
  if (omp) {
    throw new Error(
      `squad_in_use: inventário físico OMP ${omp.sessionId} ainda está ${omp.state}`,
    );
  }
}

function assertSquadNotExecuting(owner: WebContents, squadId: string): void {
  assertSquadsNotExecuting(owner, [squadId]);
}

async function confirmSquadsImport(
  owner: WebContents,
  scope: ProjectExecutionScope,
  selectedPath: string,
  candidate: PreparedSquadsImport,
): Promise<boolean> {
  for (const snapshot of candidate.snapshots) {
    assertSquadReviewable(snapshot);
  }
  const window = BrowserWindow.fromWebContents(owner);
  if (!window || window.isDestroyed()) {
    throw new Error('renderer window is unavailable');
  }
  const detail = assertExactOperatorDialog(
    `Workspace solicitante: ${scope.rootRealPath}\n` +
      `Arquivo selecionado (JSON): ${JSON.stringify(selectedPath)}\n` +
      `SHA-256 bruto: ${candidate.rawSha256}\n` +
      `SHA-256 canônico: ${candidate.canonicalSha256}\n` +
      `Squads: ${candidate.squadCount}; agentes: ${candidate.agentCount}\n` +
      `IDs alvo: ${candidate.targetIds.join(', ')}\n\n` +
      `Conteúdo normalizado integral:\n${candidate.canonicalJson}`,
  );
  const result = await dialog.showMessageBox(window, {
    type: 'warning',
    title: 'Nexus IDE — importar squads globais',
    buttons: ['Cancelar', 'Importar squads'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    message: 'Importar exatamente estes squads globais normalizados?',
    detail,
  });
  return result.response === 1;
}

async function confirmSquadMutation(
  owner: WebContents,
  scope: ProjectExecutionScope,
  action: 'save' | 'delete',
  snapshot: SquadAuthoritySnapshot,
): Promise<boolean> {
  assertSquadReviewable(snapshot);
  const window = BrowserWindow.fromWebContents(owner);
  if (!window || window.isDestroyed()) {
    throw new Error('renderer window is unavailable');
  }
  if (squadMutationConfirmations.has(owner)) {
    throw new Error('squad mutation confirmation is already pending');
  }
  squadMutationConfirmations.add(owner);
  try {
    const exact = JSON.stringify(
      {
        id: snapshot.id,
        name: snapshot.name,
        builtin: snapshot.builtin,
        orchestratorInstructions: snapshot.orchestratorInstructions,
        nativeInstructions: snapshot.nativeInstructions,
        agents: snapshot.agents,
      },
      null,
      2,
    );
    const result = await dialog.showMessageBox(window, {
      type: 'warning',
      title: action === 'save' ? 'Nexus IDE — salvar squad' : 'Nexus IDE — excluir squad',
      buttons: ['Cancelar', action === 'save' ? 'Salvar squad' : 'Excluir squad'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      message:
        action === 'save'
          ? 'Salvar exatamente este roster e contrato global?'
          : 'Excluir exatamente este squad global?',
      detail:
        `Workspace solicitante: ${safeDialogLabel(scope.rootRealPath, 4_096)}\n` +
        `Hash exato: ${snapshot.hash}\n\nConteúdo integral:\n${exact}`,
    });
    return result.response === 1;
  } finally {
    squadMutationConfirmations.delete(owner);
  }
}

export function configureRendererMissionAuthority(
  runtimeManager: ProjectRuntimeManager,
): void {
  projectDomainStores = configureProjectDomainStoreRegistry(runtimeManager);
  rendererMissionAuthority = new RendererMissionAuthority(
    projectDomainStores,
    undefined,
    undefined,
    undefined,
    undefined,
    bootstrapMissionOrchestratorForScope,
  );
  projectDomainStores.onChange((scope, store) => {
    broadcastProjectStore(scope, store);
    if (store === 'missions' || store === 'mission-panes') {
      requestMissionRuntimeAuthorityReconciliation();
    }
  });
  // Semente para serviços derivados (desktop pet): a lista corrente de cada
  // escopo no momento em que ele abre — sem isso, o PRIMEIRO broadcast de um
  // escopo pode ser justamente a transição →done, que o diff engoliria como
  // seed. onScope replaya suites existentes na inscrição.
  projectDomainStores.onScope((scope, suite) => {
    const scopeKey = JSON.stringify(scope);
    const missions = suite.missions.list();
    lastMissionsByScope.set(scopeKey, missions);
    for (const tap of missionsSeedTaps) tap(scopeKey, missions);
    // A geração pode terminar segundos antes de um crash/restart. Não abra
    // outro Codex nem repita imagens: se houver uma única missão Pet Studio e
    // um único pacote v2 novo e válido, fecha a missão existente. A semente
    // acontece antes para que running -> done ainda dispare o balão do pet.
    for (const recovery of reconcileCompletedPetStudioMissions(suite)) {
      if (recovery.completed) {
        console.log(
          `[pet-studio] recovered ${recovery.missionId} from ${recovery.packageDir}`,
        );
      }
    }
  });
}

function requireMissionAuthority(): RendererMissionAuthority {
  if (!rendererMissionAuthority) {
    throw new Error("project-scoped mission authority is not initialized");
  }
  return rendererMissionAuthority;
}

function requireProjectStores(owner: WebContents): ProjectDomainStoreSuite {
  if (!projectDomainStores) {
    throw new Error("project-scoped domain stores are not initialized");
  }
  return projectDomainStores.forScope(requireRendererWorkspaceScope(owner));
}

/**
 * Tap main-side de missões (mesma pegada dos taps do pty-manager): módulos
 * confiáveis do main — hoje o desktop pet — observam a lista publicada por
 * escopo sem entrar na cadeia de broadcast dos renderers.
 */
type MissionsBroadcastTap = (scopeKey: string, missions: Mission[]) => void;
const missionsBroadcastTaps = new Set<MissionsBroadcastTap>();
const missionsSeedTaps = new Set<MissionsBroadcastTap>();
/** Última lista publicada por escopo — replay para taps que chegam depois. */
const lastMissionsByScope = new Map<string, Mission[]>();

export function tapMissionsBroadcast(cb: MissionsBroadcastTap): () => void {
  missionsBroadcastTaps.add(cb);
  return () => missionsBroadcastTaps.delete(cb);
}

/**
 * Semeadura de estado por escopo (sem semântica de transição): dispara na
 * ABERTURA de cada escopo com a lista corrente, e replaya escopos já
 * conhecidos na inscrição — independe da ordem de boot entre orquestração e
 * o serviço derivado.
 */
export function tapMissionsSeed(cb: MissionsBroadcastTap): () => void {
  missionsSeedTaps.add(cb);
  for (const [scopeKey, missions] of lastMissionsByScope) cb(scopeKey, missions);
  return () => missionsSeedTaps.delete(cb);
}

function broadcastProjectStore(
  scope: ReturnType<typeof requireRendererWorkspaceScope>,
  store: ProjectDomainStoreName,
): void {
  if (!projectDomainStores) return;
  const suite = projectDomainStores.forScope(scope);
  if (store === "missions") {
    const missions = suite.missions.list();
    broadcastToProject(
      listeners,
      scope,
      ORCH_CHANNELS.missionsChanged,
      missions,
    );
    const scopeKey = JSON.stringify(scope);
    lastMissionsByScope.set(scopeKey, missions);
    for (const tap of missionsBroadcastTaps) tap(scopeKey, missions);
  } else if (store === "handoffs") {
    broadcastToProject(
      listeners,
      scope,
      ORCH_CHANNELS.handoffsChanged,
      suite.handoffs.list({ includeDelivered: true }),
    );
  } else if (store === "todos") {
    broadcastToProject(
      listeners,
      scope,
      ORCH_CHANNELS.todosChanged,
      suite.todos.list(),
    );
  }
}

function broadcast(channel: string, payload: unknown): void {
  for (const wc of listeners) {
    // isDestroyed() sozinho não basta: renderer recém-crashado ainda reporta
    // false e o send() loga "Render frame was disposed" (mesmo padrão do
    // canSend em pty-manager).
    if (!wc.isDestroyed() && !wc.isCrashed()) wc.send(channel, payload);
  }
}

export function registerOrchListener(wc: WebContents): void {
  listeners.add(wc);
  registerOrchRenderer(wc);
  registerBgTaskEventTarget(wc);
  registerLoginStuckTarget(wc);
}

export function unregisterOrchListener(wc: WebContents): void {
  listeners.delete(wc);
  unregisterOrchRenderer(wc);
  unregisterBgTaskEventTarget(wc);
  unregisterLoginStuckTarget(wc);
}

/** Boot the whole orchestration domain (stores → registry → MCP server). */
export async function initOrchestration(): Promise<void> {
  if (orchestrationReady) return;
  if (orchestrationInitFlight) return orchestrationInitFlight;
  if (
    orchestrationClosing ||
    orchestrationCloseFlight ||
    orchestrationShutdownBlocked
  ) {
    throw new Error(
      'orchestration lifecycle is closing or awaiting a failed-closed shutdown',
    );
  }
  const epoch = ++orchestrationLifecycleEpoch;
  const initialize = (async () => {
    const db = getDb();
    initSquadStore(db);
    initPaneRegistry();
    initIdleDelivery();
    await startMcpServer();
    // closeOrchestration may have been requested while the localhost MCP bind
    // was pending. Never resurrect a coordinator into an invalidated epoch;
    // close owns the subsequent server/store teardown.
    if (
      orchestrationClosing ||
      epoch !== orchestrationLifecycleEpoch
    ) {
      return;
    }
    // Workers need the embedded MCP endpoint/token before any boot
    // reconciliation is allowed to dispatch a pane.
    startOrchestrationCoordinator();
    // SEGURANÇA: a remote bridge NÃO sobe no boot — só sob demanda, via IPC
    // explícito do usuário (remote:bridge.start) ou pela tool MCP dedicada.
    disposeSquadBroadcast?.();
    disposeSquadBroadcast = onSquadsChange(() =>
      broadcast(ORCH_CHANNELS.squadsChanged, listSquads()),
    );
    orchestrationReady = true;
  })();
  orchestrationInitFlight = initialize;
  try {
    await initialize;
  } finally {
    if (orchestrationInitFlight === initialize) {
      orchestrationInitFlight = null;
    }
  }
}

export async function closeOrchestration(): Promise<void> {
  if (orchestrationCloseFlight) return orchestrationCloseFlight;
  orchestrationClosing = true;
  orchestrationLifecycleEpoch += 1;
  const pendingInit = orchestrationInitFlight;
  const close = (async () => {
    // A pending startMcpServer owns mutable server state. Let it settle, but
    // the invalidated epoch check above guarantees it cannot start a new
    // coordinator after shutdown was requested.
    if (pendingInit) {
      try {
        await pendingInit;
      } catch {
        // Teardown below still owns every partially initialized subsystem.
      }
    }
    // Wait for the current main-owned reconcile participant before tearing
    // down stores it may still be using. A rejected stop is deliberately
    // fail-closed: none of the teardown below is allowed to run.
    await stopOrchestrationCoordinator();
    disposeSquadBroadcast?.();
    disposeSquadBroadcast = null;
    shutdownIdleDelivery();
    stopAllPreviews();
    stopRemoteBridge();
    stopMcpServer();
    disposeProjectDomainStoreRegistry();
    projectDomainStores = null;
    rendererMissionAuthority = null;
    lastMissionsByScope.clear();
    orchestrationReady = false;
    orchestrationShutdownBlocked = false;
  })();
  orchestrationCloseFlight = close;
  try {
    await close;
  } catch (error) {
    orchestrationShutdownBlocked = true;
    throw error;
  } finally {
    orchestrationClosing = false;
    if (orchestrationCloseFlight === close) {
      orchestrationCloseFlight = null;
    }
  }
}

export function registerOrchIpc(): void {
  ipcMain.on(ORCH_CHANNELS.panesSync, (event, raw) => {
    const parsed = panesSyncSchema.safeParse(raw);
    if (parsed.success) {
      syncPanes(parsed.data, event.sender);
      for (const pane of parsed.data) {
        rendererMissionAuthority?.restorePersistedPaneAuthority(
          event.sender,
          pane.paneId,
        );
      }
      requestMissionDriverTick();
    }
  });

  ipcMain.on(ORCH_CHANNELS.paneSpawnResult, (event, raw) => {
    const parsed = orchPaneSpawnResultSchema.safeParse(raw);
    if (parsed.success) {
      resolvePaneSpawn(parsed.data, event.sender);
      requestMissionDriverTick();
    }
  });

  ipcMain.on(ORCH_CHANNELS.paneRecoveryResult, (event, raw) => {
    const parsed = missionPaneRecoveryResultSchema.safeParse(raw);
    if (parsed.success) {
      resolveMissionPaneRecovery(parsed.data, event.sender);
      requestMissionDriverTick();
    }
  });

  ipcMain.on(ORCH_CHANNELS.browserOpenResult, (event, raw) => {
    const parsed = browserPaneOpenResultSchema.safeParse(raw);
    if (parsed.success) resolveBrowserOpen(parsed.data, event.sender);
  });

  ipcMain.handle(ORCH_CHANNELS.missionsList, (event) =>
    requireProjectStores(event.sender).missions.list(),
  );
  ipcMain.handle(ORCH_CHANNELS.missionPanesList, (event, raw) => {
    if (typeof raw !== "string" || raw.length === 0 || raw.length > 128) {
      return [];
    }
    return requireMissionAuthority().listMissionPanesForRenderer(
      event.sender,
      raw,
    );
  });

  // A missão nasce NO LANÇAMENTO (renderer), não à mercê de o LLM chamar
  // nexus_mission_create — sem isto, a missão nova não aparecia em lugar
  // nenhum enquanto a antiga já tinha sido deslocada.
  const missionCreateSchema = z.object({
    title: z.string().min(1).max(512),
    goal: z.string().min(1).max(16_384).optional(),
    squadId: z.string().min(1).max(128),
    /** Pane do orquestrador — entra na composição para o reopen restaurá-lo. */
    orchestratorPane: z.object({
      paneId: z.string().min(1).max(128),
      adapterId: z.string().min(1).max(128).optional(),
      model: z.string().max(128).optional(),
      accountId: z.string().max(128).optional(),
      cwd: z.string().max(4096).optional(),
      title: z.string().max(512).optional(),
      agentName: z.string().max(256).optional(),
    }),
  });
  ipcMain.handle(ORCH_CHANNELS.missionCreate, (event, raw) => {
    const parsed = missionCreateSchema.safeParse(raw);
    if (!parsed.success) throw new Error("invalid mission create payload");
    return requireMissionAuthority().createMissionFromRenderer(
      event.sender,
      parsed.data,
    );
  });

  const immediateSquadLaunchSchema = z
    .object({
      squadId: z.string().min(1).max(128),
      paneId: z.string().min(1).max(128),
      adapterId: z.string().min(1).max(64),
      model: z.string().min(1).max(128).optional(),
      accountId: z.string().min(1).max(128).optional(),
      effort: z.string().min(1).max(32).optional(),
      missionTitle: z
        .string()
        .min(1)
        .max(512)
        .refine(
          (value) =>
            !/[\0-\x08\x0b\x0c\x0e-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(
              value,
            ),
          "mission title contains invisible control characters",
        ),
      missionGoal: z
        .string()
        .min(1)
        .max(16_384)
        .refine(
          (value) =>
            !/[\0-\x08\x0b\x0c\x0e-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(
              value,
            ),
          "mission goal contains invisible control characters",
        ),
    })
    .strict();
  ipcMain.handle(
    ORCH_CHANNELS.missionAuthorizeImmediateSquad,
    async (event, raw) => {
      const parsed = immediateSquadLaunchSchema.safeParse(raw);
      if (!parsed.success) {
        throw new Error("invalid immediate squad launch payload");
      }
      const isAllowed =
        parsed.data.squadId === PET_STUDIO_SQUAD_ID ||
        getOrchSettings().intentFirstMissionRuntimeV1 === false;
      if (!isAllowed) {
        throw new Error(
          "intent-first: immediate squad launch is not authorized",
        );
      }
      const scope = requireLiveRendererWorkspaceScope(event.sender);
      const matches = listSquads().filter(
        (candidate) => candidate.id === parsed.data.squadId,
      );
      if (matches.length !== 1) {
        throw new Error("exact saved squad is unavailable");
      }
      const snapshot = snapshotSquadAuthority(matches[0]);
      assertSquadReviewable(snapshot);
      const candidate: ImmediateSquadLaunchCandidate = {
        squad: snapshot,
        ...parsed.data,
        missionTitle: parsed.data.missionTitle.trim(),
      };
      if (!(await confirmImmediateSquadLaunch(event.sender, scope, candidate))) {
        throw new Error("user_denied");
      }
      requireLiveRendererWorkspaceScope(event.sender, scope);
      const currentMatches = listSquads().filter(
        (current) => current.id === parsed.data.squadId,
      );
      if (
        currentMatches.length !== 1 ||
        snapshotSquadAuthority(currentMatches[0]).hash !== snapshot.hash
      ) {
        throw new Error(
          "saved squad changed while native confirmation was open",
        );
      }
      const orchestrator =
        currentMatches[0].agents.find(
          (agent) => agent.category === "orchestrator",
        ) ?? currentMatches[0].agents[0];
      if (!orchestrator) {
        throw new Error("saved squad has no orchestrator");
      }
      return {
        grant: issueImmediateSquadSpawnGrant({
          owner: event.sender,
          scope,
          squad: currentMatches[0],
          runtime: {
            adapterId: parsed.data.adapterId,
            model: parsed.data.model,
            accountId: parsed.data.accountId,
            effort: parsed.data.effort,
            paneId: parsed.data.paneId,
            title: orchestrator.agentName,
            missionTitle: parsed.data.missionTitle.trim(),
            missionGoal: parsed.data.missionGoal.trim(),
          },
          ttlMs: 120_000,
        }),
      };
    },
  );

  const missionArmSchema = z.object({
    title: z.string().min(1).max(512),
    squadId: z.string().min(1).max(128),
  });
  ipcMain.handle(ORCH_CHANNELS.missionArm, (event, raw) => {
    const parsed = missionArmSchema.safeParse(raw);
    if (!parsed.success) throw new Error("invalid mission arm payload");
    return requireMissionAuthority().armMissionFromRenderer(
      event.sender,
      parsed.data,
    );
  });

  ipcMain.handle(ORCH_CHANNELS.missionSubmitIntent, (event, raw) => {
    const parsed = missionSubmitIntentSchema.safeParse(raw);
    if (!parsed.success) throw new Error("invalid mission submit intent payload");
    return requireMissionAuthority().submitIntentFromRenderer(
      event.sender,
      parsed.data,
    );
  });

  ipcMain.handle(ORCH_CHANNELS.missionApproveIntent, async (event, raw) => {
    const parsed = missionApproveIntentSchema.safeParse(raw);
    if (!parsed.success) throw new Error("invalid mission approve intent payload");
    const scope = requireLiveRendererWorkspaceScope(event.sender);
    const authority = requireMissionAuthority();
    const candidate = authority.missionApprovalCandidateFromRenderer(
      event.sender,
      parsed.data,
    );
    const approved = await confirmMissionAuthorityChange(
      event.sender,
      scope,
      candidate,
      "approve",
    );
    if (!approved) throw new Error("user_denied");
    requireLiveRendererWorkspaceScope(event.sender, scope);
    return authority.approveIntentFromRenderer(
      event.sender,
      parsed.data,
      candidate.fence,
    );
  });

  ipcMain.handle(ORCH_CHANNELS.missionBootstrapOrchestrator, (event, raw) => {
    const parsed = missionOrchestratorBootstrapSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error("invalid mission orchestrator bootstrap payload");
    }
    return bootstrapMissionOrchestratorFromRenderer(event.sender, parsed.data);
  });

  const missionPromotePlanSchema = z.object({
    missionId: z.string().min(1).max(128),
  });
  ipcMain.handle(ORCH_CHANNELS.missionPromotePlanLane, async (event, raw) => {
    const parsed = missionPromotePlanSchema.safeParse(raw);
    if (!parsed.success) throw new Error("invalid promote plan lane payload");
    const scope = requireLiveRendererWorkspaceScope(event.sender);
    const authority = requireMissionAuthority();
    const candidate = authority.planPromotionCandidateFromRenderer(
      event.sender,
      parsed.data,
    );
    const approved = await confirmMissionAuthorityChange(
      event.sender,
      scope,
      candidate,
      "promote",
    );
    if (!approved) throw new Error("user_denied");
    requireLiveRendererWorkspaceScope(event.sender, scope);
    return authority.promotePlanLaneFromRenderer(
      event.sender,
      parsed.data,
      candidate.fence,
    );
  });

  ipcMain.handle(ORCH_CHANNELS.missionKickoffSubmit, (event, raw) =>
    submitMissionKickoffFromRenderer(event.sender, raw),
  );

  const missionPrepareProjectSchema = z.object({
    missionId: z.string().min(1).max(128),
  });
  ipcMain.handle(ORCH_CHANNELS.missionPrepareProject, (event, raw) => {
    const parsed = missionPrepareProjectSchema.safeParse(raw);
    if (!parsed.success) throw new Error("invalid mission prepare project payload");
    return requireMissionAuthority().prepareProjectFromRenderer(
      event.sender,
      parsed.data,
    );
  });

  ipcMain.handle(ORCH_CHANNELS.missionCancelPreparation, (event, raw) => {
    const parsed = missionPrepareProjectSchema.safeParse(raw);
    if (!parsed.success) throw new Error("invalid mission cancellation payload");
    return requireMissionAuthority().cancelPreparationFromRenderer(
      event.sender,
      parsed.data,
    );
  });

  const missionPromptQueueSchema = z.object({
    missionId: z.string().min(1).max(128),
  });
  ipcMain.handle(ORCH_CHANNELS.missionPromptQueue, (event, raw) => {
    const parsed = missionPromptQueueSchema.safeParse(raw);
    if (!parsed.success) throw new Error("invalid mission prompt queue payload");
    const snap = requireMissionAuthority().getPromptQueueFromRenderer(
      event.sender,
      parsed.data,
    );
    return {
      executing: snap.executing
        ? {
            id: snap.executing.id,
            kind: snap.executing.kind,
            status: snap.executing.status,
            intentVersion: snap.executing.intentVersion,
            body: snap.executing.body.slice(0, 256),
          }
        : null,
      queued: snap.queued.map((item) => ({
        id: item.id,
        kind: item.kind,
        status: item.status,
        intentVersion: item.intentVersion,
        body: item.body.slice(0, 256),
      })),
      cancelled: snap.cancelled.slice(-8).map((item) => ({
        id: item.id,
        kind: item.kind,
        status: item.status,
        intentVersion: item.intentVersion,
        body: item.body.slice(0, 256),
      })),
    };
  });

  const missionBindOrchestratorSchema = missionCreateSchema.extend({
    missionId: z.string().min(1).max(128),
  });
  ipcMain.handle(ORCH_CHANNELS.missionBindOrchestrator, (event, raw) => {
    const parsed = missionBindOrchestratorSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error("invalid mission bind orchestrator payload");
    }
    return requireMissionAuthority().bindOrchestratorToMissionFromRenderer(
      event.sender,
      parsed.data,
    );
  });

  const missionRebindSchema = z.object({
    missionId: z.string().min(1).max(128),
    sessionId: z.string().min(1).max(128),
  });
  ipcMain.handle(ORCH_CHANNELS.missionRebind, (event, raw) => {
    const parsed = missionRebindSchema.safeParse(raw);
    if (!parsed.success) return { ok: false };
    const mission = requireMissionAuthority().rebindMissionFromRenderer(
      event.sender,
      parsed.data.missionId,
      parsed.data.sessionId,
    );
    if (mission) {
      const scope = requireRendererWorkspaceScope(event.sender);
      redeliverPendingHandoffs(scope, mission.id);
    }
    return { ok: mission !== null };
  });

  const missionUpdateSchema = z.object({
    missionId: z.string().min(1).max(128),
    patch: missionPatchSchema,
  });
  ipcMain.handle(ORCH_CHANNELS.missionUpdate, async (event, raw) => {
    const parsed = missionUpdateSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error("invalid mission update payload");
    }
    const authority = requireMissionAuthority();
    let fence: string | undefined;
    let demotionScope: ProjectExecutionScope | undefined;
    if (
      parsed.data.patch.status === "blocked" ||
      parsed.data.patch.status === "failed"
    ) {
      const scope = requireLiveRendererWorkspaceScope(event.sender);
      demotionScope = scope;
      const candidate = authority.missionLifecycleCandidateFromRenderer(
        event.sender,
        parsed.data.missionId,
        parsed.data.patch,
      );
      const approved = await confirmMissionLifecycleDemotion(
        event.sender,
        scope,
        candidate,
      );
      if (!approved) throw new Error("user_denied");
      requireLiveRendererWorkspaceScope(event.sender, scope);
      fence = candidate.fence;
    }
    const mission = authority.updateMissionFromRenderer(
      event.sender,
      parsed.data.missionId,
      parsed.data.patch,
      fence,
    );
    if (!mission) {
      throw new Error("mission not found");
    }
    if (demotionScope) {
      const suite = requireProjectStores(event.sender);
      const settled = await settleMissionRuntimeDemotion({
        scope: demotionScope,
        suite,
        demotedMission: mission,
      });
      return settled.mission;
    }
    return mission;
  });

  ipcMain.handle(ORCH_CHANNELS.missionRemove, async (event, raw) => {
    const parsed = missionRemoveSchema.safeParse(raw);
    if (!parsed.success) throw new Error("invalid mission remove payload");
    const scope = requireLiveRendererWorkspaceScope(event.sender);
    const authority = requireMissionAuthority();
    const candidate = authority.missionRemovalCandidateFromRenderer(
      event.sender,
      parsed.data.missionId,
    );
    if (!candidate) return { removed: false };
    const approved = await confirmMissionRemoval(
      event.sender,
      scope,
      candidate,
    );
    if (!approved) return { removed: false };
    // A native click can outlive the renderer or its project binding. Recheck
    // both the exact scope and every durable-activity predicate immediately
    // before the cascade-capable store call.
    requireLiveRendererWorkspaceScope(event.sender, scope);
    const removed = authority.removeMissionFromRenderer(
      event.sender,
      parsed.data.missionId,
    );
    if (removed) deleteMissionPromptQueue(scope, parsed.data.missionId);
    return { removed };
  });

  ipcMain.handle(ORCH_CHANNELS.handoffsList, (event) =>
    requireProjectStores(event.sender).handoffs.list({
      includeDelivered: true,
    }),
  );
  ipcMain.handle(ORCH_CHANNELS.clarifyAnswerSubmit, async (event, raw) => {
    const scope = requireLiveRendererWorkspaceScope(event.sender);
    const stores = requireProjectStores(event.sender);
    const candidate = prepareClarifyAnswerAuthorityCandidate(stores, scope, raw);
    if (!(await confirmClarifyAnswer(event.sender, scope, candidate))) {
      throw new Error('user_denied');
    }
    requireLiveRendererWorkspaceScope(event.sender, scope);
    return persistClarifyAnswer(stores, scope, raw, candidate.fence);
  });
  ipcMain.handle(ORCH_CHANNELS.operatorReviewSubmit, async (event, raw) => {
    const scope = requireLiveRendererWorkspaceScope(event.sender);
    const stores = requireProjectStores(event.sender);
    const candidate = prepareOperatorReviewAuthorityCandidate(stores, scope, raw);
    if (!(await confirmOperatorReview(event.sender, scope, candidate))) {
      throw new Error('user_denied');
    }
    requireLiveRendererWorkspaceScope(event.sender, scope);
    return persistOperatorReviewFeedback(stores, scope, raw, candidate.fence);
  });
  ipcMain.handle(ORCH_CHANNELS.todosGet, (event) =>
    requireProjectStores(event.sender).todos.list(),
  );

  const todoSetStatusSchema = z.object({
    listId: z.string().min(1).max(128),
    itemId: z.string().min(1).max(128),
    status: z.enum(["todo", "in_progress", "done"]),
  });
  ipcMain.handle(ORCH_CHANNELS.todoSetStatus, (event, raw) => {
    const stores = requireProjectStores(event.sender);
    const parsed = todoSetStatusSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error("invalid todo status payload");
    }
    const list = stores.todos.setItemStatus(
      parsed.data.listId,
      parsed.data.itemId,
      parsed.data.status,
    );
    if (!list) {
      throw new Error("todo list or item not found");
    }
    return list;
  });
  ipcMain.handle(ORCH_CHANNELS.squadsList, (event) => {
    requireLiveRendererWorkspaceScope(event.sender);
    return listSquads();
  });
  ipcMain.handle(ORCH_CHANNELS.squadDesign, async (event, raw: unknown) => {
    // O workspace é autoridade do processo principal. O payload legado ainda
    // é aceito por compatibilidade, mas nunca escolhe o projeto analisado.
    const scope = requireLiveRendererWorkspaceScope(event.sender);
    const wsPath = scope.rootRealPath;
    let intent: string | undefined;
    if (raw && typeof raw === "object") {
      const obj = raw as { intent?: unknown };
      if (typeof obj.intent === "string" && obj.intent.trim().length > 0) {
        intent = obj.intent.slice(0, 4_000);
      }
    }
    const designKey =
      `${projectExecutionScopeKey(scope)}\0` +
      `${intent?.trim().toLowerCase() ?? ''}`;
    const fence = rendererAsyncAuthorityFence(event.sender, scope);
    let ownsOperation = false;
    try {
      const operation = squadDesignPool.run(designKey, async () => {
        ownsOperation = true;
        try {
          fence.assertCurrentAuthority();
          const result = intent
            ? await designSquadFromIntent(intent, wsPath, {
                signal: fence.signal,
                assertCurrentAuthority: fence.assertCurrentAuthority,
              })
            : await designSquadForWorkspace(wsPath, {
                signal: fence.signal,
                assertCurrentAuthority: fence.assertCurrentAuthority,
              });
          fence.assertCurrentAuthority();
          return result;
        } finally {
          fence.dispose();
        }
      });
      const value = await fence.waitFor(operation);
      // A same-key caller may have joined another renderer's flight or hit the
      // bounded cache; its own live authority still gates the returned value.
      requireLiveRendererWorkspaceScope(event.sender, scope);
      return value;
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      // The owner fence stays attached while an abort-ignoring provider still
      // occupies the pool slot. Joined/cache/capacity callers own no task.
      if (!ownsOperation) fence.dispose();
    }
  });
  ipcMain.handle(ORCH_CHANNELS.mcpInfo, (event) => {
    requireLiveRendererWorkspaceScope(event.sender);
    return getMcpRuntimeInfo();
  });

  ipcMain.handle(ORCH_CHANNELS.squadSave, async (event, raw) => {
    const parsed = squadSchema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, error: "invalid squad payload" };
    }
    try {
      const scope = requireLiveRendererWorkspaceScope(event.sender);
      const existing = listSquads().find((squad) => squad.id === parsed.data.id);
      if (parsed.data.builtin || existing?.builtin) {
        throw new Error(
          'managed built-in squads cannot be edited; duplicate with a new id',
        );
      }
      const candidate = prepareSquadSave(parsed.data);
      assertSquadNotExecuting(event.sender, candidate.squad.id);
      const approved = await confirmSquadMutation(
        event.sender,
        scope,
        'save',
        candidate.snapshot,
      );
      if (!approved) return { ok: false, error: 'user_denied' };
      requireLiveRendererWorkspaceScope(event.sender, scope);
      assertSquadNotExecuting(event.sender, candidate.squad.id);
      applyPreparedSquadSave(candidate);
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : "failed to save squad",
      };
    }
  });

  ipcMain.handle(ORCH_CHANNELS.squadDelete, async (event, raw) => {
    if (typeof raw !== "string" || raw.length === 0 || raw.length > 128) {
      return { ok: false };
    }
    try {
      const scope = requireLiveRendererWorkspaceScope(event.sender);
      assertSquadNotExecuting(event.sender, raw);
      const existing = listSquads().find((squad) => squad.id === raw);
      if (!existing) return { ok: false };
      if (existing.builtin) {
        throw new Error(
          'managed built-in squads cannot be deleted; duplicate to customize',
        );
      }
      const snapshot = snapshotSquadAuthority(existing);
      const approved = await confirmSquadMutation(
        event.sender,
        scope,
        'delete',
        snapshot,
      );
      if (!approved) return { ok: false, error: 'user_denied' };
      requireLiveRendererWorkspaceScope(event.sender, scope);
      assertSquadNotExecuting(event.sender, raw);
      const current = listSquads().find((squad) => squad.id === raw);
      if (!current || snapshotSquadAuthority(current).hash !== snapshot.hash) {
        throw new Error('saved squad changed while native confirmation was open');
      }
      return { ok: deleteSquad(raw) };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'failed to delete squad',
      };
    }
  });

  ipcMain.handle(ORCH_CHANNELS.squadExport, async (event) => {
    let releaseLane: (() => void) | null = null;
    try {
      const scope = requireLiveRendererWorkspaceScope(event.sender);
      releaseLane = acquireSquadFileOperation();
      const window = BrowserWindow.fromWebContents(event.sender);
      if (!window || window.isDestroyed()) {
        throw new Error('renderer window is unavailable');
      }
      // Snapshot bytes before opening the native save dialog. Later global
      // catalog changes cannot silently alter what this invocation publishes.
      const bytes = Buffer.from(exportSquadsJson(), 'utf8');
      if (bytes.length > MAX_SQUADS_IMPORT_BYTES) {
        throw new Error(
          'squads export exceeds the 1 MiB import-compatible limit',
        );
      }
      const result = await dialog.showSaveDialog(window, {
        title: "Export squads",
        defaultPath: "nexus-squads.json",
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      requireLiveRendererWorkspaceScope(event.sender, scope);
      if (result.canceled || !result.filePath) return { ok: false };
      atomicWriteSelectedSquadsFile(result.filePath, bytes);
      return { ok: true, path: result.filePath };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : "failed to write file",
      };
    } finally {
      releaseLane?.();
    }
  });

  const catalogIndexSchema = z.object({ refresh: z.boolean().optional() });
  const catalogInstallSchema = z.object({
    kind: z.enum(["agent", "skill"]),
    slug: z.string().min(1).max(256),
  });

  ipcMain.handle(ORCH_CHANNELS.catalogIndex, async (event, raw) => {
    requireLiveRendererWorkspaceScope(event.sender);
    const parsed = catalogIndexSchema.safeParse(raw ?? {});
    return getCatalogIndex(parsed.success ? parsed.data.refresh : false);
  });

  ipcMain.handle(ORCH_CHANNELS.catalogInstall, async (event, raw) => {
    const scope = requireLiveRendererWorkspaceScope(event.sender);
    const parsed = catalogInstallSchema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, error: "invalid catalog install request" };
    }
    const reviewed = reviewCatalogInstall(parsed.data);
    if (!reviewed.ok) return reviewed;
    if (reviewed.candidate.alreadyInstalled) {
      return { ok: true, skipped: true };
    }
    if (
      catalogInstallConfirmations.has(event.sender) ||
      catalogInstallTargets.has(reviewed.candidate.targetPath)
    ) {
      return { ok: false, error: "catalog_install_busy" };
    }
    catalogInstallConfirmations.add(event.sender);
    catalogInstallTargets.add(reviewed.candidate.targetPath);
    try {
      const sourceApproved = await confirmCatalogInstallSource(
        event.sender,
        scope,
        reviewed.candidate,
      );
      if (!sourceApproved) return { ok: false, error: "user_denied" };
      requireLiveRendererWorkspaceScope(event.sender, scope);
      // The cached source identity shown in the first dialog must still be the
      // exact source selected by main immediately before download.
      const current = reviewCatalogInstall(parsed.data);
      if (
        !current.ok ||
        current.candidate.commitSha !== reviewed.candidate.commitSha ||
        current.candidate.targetPath !== reviewed.candidate.targetPath
      ) {
        throw new Error("catalog source changed while confirmation was open");
      }
      return await installCatalogItem(parsed.data, {
        expectedCommitSha: reviewed.candidate.commitSha,
        assertCurrentAuthority: () => {
          requireLiveRendererWorkspaceScope(event.sender, scope);
        },
        beforePublish: async (candidate) => {
          if (
            candidate.repository !== reviewed.candidate.repository ||
            candidate.commitSha !== reviewed.candidate.commitSha ||
            candidate.kind !== reviewed.candidate.kind ||
            candidate.slug !== reviewed.candidate.slug ||
            candidate.targetPath !== reviewed.candidate.targetPath
          ) {
            throw new Error("prepared catalog candidate changed identity");
          }
          requireLiveRendererWorkspaceScope(event.sender, scope);
          const approved = await confirmCatalogInstallPayload(
            event.sender,
            scope,
            candidate,
          );
          if (!approved) return false;
          requireLiveRendererWorkspaceScope(event.sender, scope);
          return true;
        },
      });
    } finally {
      catalogInstallConfirmations.delete(event.sender);
      catalogInstallTargets.delete(reviewed.candidate.targetPath);
    }
  });

  const recipeOverlaySchema = z.object({}).strict();
  ipcMain.handle(ORCH_CHANNELS.recipeOverlay, (event, raw) => {
    const scope = requireLiveRendererWorkspaceScope(event.sender);
    const parsed = recipeOverlaySchema.safeParse(raw ?? {});
    if (!parsed.success) throw new Error("invalid recipe overlay request");
    return buildRecipeOverlay(scope.rootRealPath);
  });

  const catalogOverlaySaveSchema = z.object({
    stacks: z.array(z.string().min(1).max(64)).max(32).optional(),
    disabled: z.array(z.string().min(1).max(128)).max(512).optional(),
    tombstones: z.array(z.string().min(1).max(128)).max(512).optional(),
    categories: z
      .record(z.string().min(1).max(128), z.string().min(1).max(128))
      .refine((value) => Object.keys(value).length <= 512)
      .optional(),
  }).strict().refine(
    (value) => Buffer.byteLength(JSON.stringify(value), "utf8") <= 256 * 1024,
    { message: "catalog overlay exceeds byte budget" },
  );
  ipcMain.handle(ORCH_CHANNELS.catalogOverlaySave, (event, raw) => {
    const scope = requireLiveRendererWorkspaceScope(event.sender);
    const parsed = catalogOverlaySaveSchema.safeParse(raw ?? {});
    if (!parsed.success) throw new Error("invalid catalog overlay");
    const patch = {
      ...parsed.data,
      workspacePath: scope.rootRealPath,
    };
    assertValidCatalogOverlayPatch(patch);
    return saveCatalogOverlay(patch);
  });

  ipcMain.handle(ORCH_CHANNELS.recipePropose, (event, raw) => {
    const scope = requireLiveRendererWorkspaceScope(event.sender);
    const parsed = recipeOverlaySchema.safeParse(raw ?? {});
    if (!parsed.success) throw new Error("invalid recipe proposal request");
    return proposeRecipes(scope.rootRealPath);
  });

  ipcMain.handle(ORCH_CHANNELS.agentSpecWrite, async (event, raw) => {
    const scope = requireLiveRendererWorkspaceScope(event.sender);
    const parsed = agentSpecWriteSchema.safeParse(raw ?? {});
    if (!parsed.success) return { ok: false, error: "invalid agent spec" };
    let candidate: AgentSpecWriteCandidate;
    try {
      candidate = prepareAgentSpecWrite(parsed.data);
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : "invalid agent spec",
      };
    }
    const approved = await confirmAgentSpecWrite(
      event.sender,
      scope,
      candidate,
    );
    if (!approved) return { ok: false, error: "user_denied" };
    requireLiveRendererWorkspaceScope(event.sender, scope);
    return writeAgentSpec(parsed.data, candidate.currentFingerprint);
  });

  ipcMain.handle(ORCH_CHANNELS.catalogInstalled, (event) => {
    requireLiveRendererWorkspaceScope(event.sender);
    return listInstalledCatalogItems();
  });
  ipcMain.handle(ORCH_CHANNELS.harnessEnriched, (event) => {
    requireLiveRendererWorkspaceScope(event.sender);
    return loadEnrichedCatalog();
  });
  ipcMain.handle(ORCH_CHANNELS.harnessEnrich, async (event) => {
    const scope = requireLiveRendererWorkspaceScope(event.sender);
    const enrichKey = projectExecutionScopeKey(scope);
    const fence = rendererAsyncAuthorityFence(event.sender, scope);
    let ownsOperation = false;
    try {
      const operation = harnessEnrichPool.run(enrichKey, async () => {
        ownsOperation = true;
        try {
          fence.assertCurrentAuthority();
          const result = await runHarnessEnrichWithBrain({
            signal: fence.signal,
            assertCurrentAuthority: fence.assertCurrentAuthority,
          });
          fence.assertCurrentAuthority();
          return result;
        } finally {
          fence.dispose();
        }
      });
      const catalog = await fence.waitFor(operation);
      requireLiveRendererWorkspaceScope(event.sender, scope);
      return { ok: true, catalog };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      if (!ownsOperation) fence.dispose();
    }
  });
  ipcMain.handle(ORCH_CHANNELS.toolsList, (event) => {
    requireLiveRendererWorkspaceScope(event.sender);
    return getToolCatalog();
  });
  ipcMain.handle(ORCH_CHANNELS.pluginsList, (event) => {
    requireLiveRendererWorkspaceScope(event.sender);
    return listPluginFiles();
  });
  ipcMain.handle(ORCH_CHANNELS.hooksList, (event) => {
    requireLiveRendererWorkspaceScope(event.sender);
    return listHookHomes();
  });

  const designSystemsSearchSchema = z.object({
    query: z.string().max(256).optional(),
    tags: z.array(z.string().min(1).max(128)).max(32).optional(),
    sort: z.enum(["popular", "recent", "likes", "downloads"]).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  });
  ipcMain.handle(ORCH_CHANNELS.designSystemsSearch, async (event, raw) => {
    const parsed = designSystemsSearchSchema.safeParse(raw ?? {});
    if (!parsed.success) {
      return { ok: false, error: "invalid design systems search request" };
    }
    try {
      const scope = requireLiveRendererWorkspaceScope(event.sender);
      const key = `${projectExecutionScopeKey(scope)}\0${JSON.stringify(parsed.data)}`;
      const fence = rendererAsyncAuthorityFence(event.sender, scope);
      let ownsOperation = false;
      try {
        const operation = designSystemsSearchPool.run(key, async () => {
          ownsOperation = true;
          try {
            fence.assertCurrentAuthority();
            const result = await new DesignMdApiClient().searchKits(parsed.data);
            fence.assertCurrentAuthority();
            return result;
          } finally {
            fence.dispose();
          }
        });
        const kits = await fence.waitFor(operation);
        // A same-key call may join another renderer's flight or hit the cache.
        requireLiveRendererWorkspaceScope(event.sender, scope);
        return { ok: true, kits };
      } finally {
        // An abort-ignoring provider keeps the global pool slot occupied until
        // its real promise settles; joined/cache/capacity callers own no task.
        if (!ownsOperation) fence.dispose();
      }
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });

  const designSystemsImportSchema = z.object({
    identifier: z.string().min(1).max(512),
    targetPath: z.string().min(1).max(512).optional(),
  });
  ipcMain.handle(ORCH_CHANNELS.designSystemsImport, async (event, raw) => {
    const parsed = designSystemsImportSchema.safeParse(raw ?? {});
    if (!parsed.success) {
      return { ok: false, error: "invalid design systems import request" };
    }
    try {
      const scope = requireLiveRendererWorkspaceScope(event.sender);
      const importTool = buildDesignSystemTools({
        assertCurrentAuthority: () => {
          requireLiveRendererWorkspaceScope(event.sender, scope);
        },
      }).find(
        (tool) => tool.name === "nexus_design_system_import",
      );
      if (!importTool) {
        throw new Error("nexus_design_system_import tool is not registered");
      }
      const rendererId = String(event.sender.id);
      const ctx: AgentGateContext = {
        token: `renderer-import-${rendererId}`,
        label: "user",
        role: "user",
        sessionId: `renderer-${rendererId}`,
        agentName: "user",
        providerId: "user",
        scope,
        allowedTools: null,
        allowedSkills: null,
        stopAttempts: 0,
        handoffSubmitted: false,
      };
      const result = await importTool.handler(parsed.data, ctx);
      return { ok: true, ...(result as Record<string, unknown>) };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });

  ipcMain.handle(ORCH_CHANNELS.squadImport, async (event) => {
    let releaseLane: (() => void) | null = null;
    try {
      const scope = requireLiveRendererWorkspaceScope(event.sender);
      releaseLane = acquireSquadFileOperation();
      const window = BrowserWindow.fromWebContents(event.sender);
      if (!window || window.isDestroyed()) {
        throw new Error('renderer window is unavailable');
      }
      const result = await dialog.showOpenDialog(window, {
        title: "Import squads",
        properties: ["openFile"],
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      requireLiveRendererWorkspaceScope(event.sender, scope);
      if (result.canceled || result.filePaths.length === 0) {
        return { ok: false };
      }
      const selectedPath = result.filePaths[0];
      const selected = secureReadSquadImportFile(selectedPath);
      const candidate = prepareSquadsImport(selected.bytes);
      if (candidate.rawSha256 !== selected.sha256) {
        throw new Error('prepared squads import raw hash does not match file');
      }
      assertSquadsNotExecuting(event.sender, candidate.targetIds);
      const approved = await confirmSquadsImport(
        event.sender,
        scope,
        selectedPath,
        candidate,
      );
      if (!approved) return { ok: false, error: 'user_denied' };
      requireLiveRendererWorkspaceScope(event.sender, scope);
      const confirmed = secureReadSquadImportFile(selectedPath);
      assertSameSecureImportRead(selected, confirmed);
      assertSquadsNotExecuting(event.sender, candidate.targetIds);
      const count = applyPreparedSquadsImport(candidate);
      return { ok: true, count };
    } catch (err) {
      return {
        ok: false,
        error:
          err instanceof Error ? err.message : "failed to import squads file",
      };
    } finally {
      releaseLane?.();
    }
  });
}
