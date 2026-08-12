import { BrowserWindow, dialog, ipcMain } from "electron";
import type { WebContents } from "electron";
import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { ORCH_CHANNELS } from "../../shared/orch-channels";
import {
  missionEngineCommandSchema,
  missionPrepareRequestSchema,
  missionReviewSchema,
  missionSnapshotSchema,
  missionSummarySnapshotSchema,
  type MissionEngineCommand,
} from "../../shared/mission-engine-contract";
import { PET_STUDIO_SQUAD } from '../../shared/pet-studio';
import type { ProjectExecutionScope } from "../../shared/types";
import {
  missionPatchSchema,
  browserPaneOpenResultSchema,
  orchPaneSpawnResultSchema,
  missionPaneRecoveryResultSchema,
  panesSyncEnvelopeSchema,
  panesSyncSchema,
  squadSchema,
  isEngineGeneratedSquadId,
  isMissionRuntimeSquadId,
  type Mission,
  type Squad,
} from "../../shared/orch-types";
import { getDb } from "../persistence/db";
import { getFeatureFlagRegistry } from "../feature-flags/feature-flag-registry";
import { FEATURE_FLAG_IDS } from "../../shared/feature-flags";
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
  prepareMissionRuntimeSquadSave,
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
import {
  getOwnedAgentSessionInfo,
  listAgentSessions,
  orchWriteSession,
} from '../pty/pty-manager';
import { assertSafePtyPrompt } from "./pty-prompt-safety";
import {
  RendererMissionAuthority,
  type RendererMissionLifecycleCandidate,
} from "./renderer-mission-authority";
import { deleteMissionPromptQueue } from "./mission-prompt-queue-registry";
import { withMissionLifecycleLock } from "./mission-lifecycle-lock";
import {
  ProjectDomainStoreRegistry,
  configureProjectDomainStoreRegistry,
  disposeProjectDomainStoreRegistry,
  getProjectDomainStores,
  type ProjectDomainStoreSuite,
  type ProjectDomainStoreName,
} from "./project-domain-store-registry";
import { missionEngineForScope } from "./mission-engine-registry";
import { broadcastToProject } from "./project-scoped-broadcast";
import {
  initIdleDelivery,
  redeliverPendingHandoffs,
  shutdownIdleDelivery,
} from "./idle-delivery";
import {
  initWorkerHandoffTtl,
  shutdownWorkerHandoffTtl,
} from "./worker-handoff-ttl";
import {
  initWorkerHandoffEnforcement,
  shutdownWorkerHandoffEnforcement,
} from "./worker-handoff-enforcement";
import {
  requestMissionRuntimeAuthorityReconciliation,
  startOrchestrationCoordinator,
  stopOrchestrationCoordinator,
} from './orchestration-coordinator';
import {
  OrchestrationStartSupervisor,
  type OrchestrationStartHealth,
} from './orchestration-start-supervisor';
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
import { DEFAULT_DESIGN_TARGET_PATH } from "./design-system-authority";
import { importDesignContractWithKeylessFallback } from "./design-system-import-fallback";
import type { AgentGateContext } from "./gate";
import { reconcileCompletedPetStudioMissions } from "./pet-studio-completion";
import { z } from "zod";
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
import { resumeBlockedMissionBootstrapFromRenderer } from './mission-engine-production';
import {
  snapshotSquadAuthority,
  squadAuthorityReviewStrings,
  type SquadAuthoritySnapshot,
} from './squad-authority-snapshot';
import {
  closeOrphanedMissionRuntime,
  closeMissionRuntimePreservingHistory,
  missionHasLivePhysicalSession,
  prepareMissionRuntimeTermination,
  settleMissionRuntimeDemotion,
  terminateMissionRuntime,
} from './mission-runtime-termination';
import { BoundedAsyncOperationPool } from './bounded-async-operation-pool';
import { missionControlPlaneSnapshot } from "./mission-control-plane-ipc";

/**
 * Renderer-facing IPC for the orchestration domain, plus the domain
 * bootstrap. Every renderer payload is zod-validated at this boundary.
 */

const missionStartSchema = missionReviewSchema
  .pick({ missionId: true, reviewSha256: true })
  .strict();
const canonicalMissionIdSchema = missionReviewSchema.shape.missionId;
const canonicalMissionSummaryListSchema = z.array(
  missionSummarySnapshotSchema,
);
const canonicalMissionNoInputSchema = z.undefined();

const listeners = new Set<WebContents>();
let nextMissionSummaryBroadcastVersion = 0;
const missionSummaryBroadcastVersions = new Map<string, number>();
const missionAuthorityConfirmations = new WeakSet<WebContents>();
const squadDeleteConfirmations = new WeakSet<WebContents>();
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
let orchestrationStartSupervisor: OrchestrationStartSupervisor | null = null;
let orchestrationLifecycleEpoch = 0;
let orchestrationReady = false;
let orchestrationClosing = false;
let orchestrationShutdownBlocked = false;
let disposeSquadBroadcast: (() => void) | null = null;
const SQUAD_DESIGN_DRAFT_TTL_MS = 15 * 60_000;
const MAX_SQUAD_DESIGN_DRAFTS = 64;
const squadDesignDrafts = new Map<
  string,
  {
    readonly ownerId: number;
    readonly scopeKey: string;
    readonly squad: Squad;
    readonly expiresAt: number;
  }
>();

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

function pruneSquadDesignDrafts(now = Date.now()): void {
  for (const [token, draft] of squadDesignDrafts) {
    if (draft.expiresAt <= now) squadDesignDrafts.delete(token);
  }
  while (squadDesignDrafts.size >= MAX_SQUAD_DESIGN_DRAFTS) {
    const oldest = squadDesignDrafts.keys().next().value;
    if (typeof oldest !== 'string') break;
    squadDesignDrafts.delete(oldest);
  }
}

function rememberSquadDesignDraft(
  owner: WebContents,
  scope: ProjectExecutionScope,
  squad: Squad,
): string {
  pruneSquadDesignDrafts();
  const token = randomBytes(32).toString('base64url');
  squadDesignDrafts.set(token, {
    ownerId: owner.id,
    scopeKey: projectExecutionScopeKey(scope),
    squad: squadSchema.parse(structuredClone(squad)),
    expiresAt: Date.now() + SQUAD_DESIGN_DRAFT_TTL_MS,
  });
  return token;
}

function resolveSquadDesignDraft(
  owner: WebContents,
  scope: ProjectExecutionScope,
  token: string | undefined,
  squadId: string,
): Squad | null {
  if (!token) return null;
  pruneSquadDesignDrafts();
  const draft = squadDesignDrafts.get(token);
  if (
    !draft ||
    draft.ownerId !== owner.id ||
    draft.scopeKey !== projectExecutionScopeKey(scope) ||
    draft.squad.id !== squadId
  ) {
    return null;
  }
  return squadSchema.parse(structuredClone(draft.squad));
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


/**
 * Teclado do operador num pane de missão. O teto é digitação e edição de
 * linha — um prompt de kickoff não cabe aqui, e é essa a intenção: o operador
 * conversa com o agente, não injeta contrato por fora do gate.
 */
export const paneOperatorInputSchema = z
  .object({
    sessionId: z.string().min(1).max(128),
    data: z.string().min(1).max(4_096),
  })
  .strict();

const missionResumeBootstrapSchema = z
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

const missionRuntimeSquadSaveSchema = z
  .object({
    squad: squadSchema,
    purpose: z.literal('mission-runtime'),
    guided: z.boolean(),
    sourceSquadId: z.string().min(1).max(128),
    designDraftToken: z.string().min(32).max(128).optional(),
  })
  .strict();

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

async function confirmPetStudioMissionStart(
  owner: WebContents,
  scope: ProjectExecutionScope,
  mission: Mission,
  reviewSha256: string,
): Promise<boolean> {
  const window = BrowserWindow.fromWebContents(owner);
  if (!window || window.isDestroyed()) {
    throw new Error('renderer window is unavailable');
  }
  const attachments = mission.intentContract?.attachmentSnapshots ?? [];
  const attachment = attachments[0];
  if (
    attachments.length !== 1 ||
    !attachment?.sourcePath ||
    !attachment.sealId ||
    !attachment.device ||
    !attachment.inode
  ) {
    throw new Error(
      'pet start confirmation requires one sealed governed attachment',
    );
  }
  const agent = PET_STUDIO_SQUAD.agents[0]!;
  const permissions =
    '• Gerar imagens para este pet: somente pela skill nexus-pet-studio ' +
    'na sessão Codex revisada.';
  const result = await dialog.showMessageBox(window, {
    type: 'question',
    title: 'Nexus IDE — confirmar criação do pet',
    buttons: ['Cancelar', 'Iniciar criação do pet'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    message: 'Iniciar a sessão Codex revisada para criar este pet?',
    detail:
      `Workspace: ${safeDialogLabel(scope.rootRealPath, 4_096)}\n` +
      `Imagem escolhida: ${safeDialogLabel(attachment.sourcePath, 4_096)}\n` +
      `Artefato selado: ${safeDialogLabel(attachment.path, 4_096)}\n` +
      `Identidade: seal=${attachment.sealId} · dev=${attachment.device} · inode=${attachment.inode}\n` +
      `SHA-256: ${attachment.sha256}\n` +
      `Bytes: ${attachment.size}\n` +
      `Revisão: ${reviewSha256}\n\n` +
      `Equipe fixa: ${PET_STUDIO_SQUAD.name}\n` +
      `Sessão: ${agent.cli} / ${agent.model}\n` +
      `Skill permitida: ${(agent.allowedSkills ?? []).join(', ')}\n` +
      `Ferramentas permitidas: ${(agent.allowedTools ?? []).join(', ')}\n\n` +
      `Permissões:\n${permissions}\n\n` +
      'A missão e a geração só começarão após esta confirmação nativa.',
  });
  return result.response === 1;
}


async function confirmMissionLifecycleDemotion(
  owner: WebContents,
  scope: ProjectExecutionScope,
  candidate: RendererMissionLifecycleCandidate,
): Promise<boolean> {
  // ZERO FRICÇÃO (06/08): parar/encerrar é ação explícita do operador — vale
  // na hora, sem confirmação. O encerramento preserva panes, scrollback e
  // receipts (mission-runtime-termination), então a operação é reversível via
  // Retomar; o registro fica no card da missão e no log abaixo.
  void owner;
  console.log(
    `[orch] mission lifecycle demotion auto-confirmed ` +
      `project=${scope.projectId} mission=${candidate.missionId} ` +
      `to=${candidate.toStatus}`,
  );
  return true;
}
async function confirmMissionRuntimeClose(
  owner: WebContents,
  scope: ProjectExecutionScope,
  candidate: ReturnType<typeof prepareMissionRuntimeTermination>,
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
      title: "Nexus IDE — encerrar missão",
      buttons: ["Cancelar", "Encerrar missão"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      message: `Encerrar "${safeDialogLabel(candidate.missionTitle, 512)}"?`,
      detail:
        `Workspace: ${safeDialogLabel(scope.rootRealPath, 4_096)}\n` +
        `Missão: ${safeDialogLabel(candidate.missionId, 128)}\n` +
        `Sessões físicas: ${candidate.sessionIds.length}\n\n` +
        "Os processos e panes desta missão serão encerrados. Tasks, entregas, " +
        "receipts e histórico permanecem salvos, e a missão poderá ser retomada depois.",
    });
    return result.response === 1;
  } finally {
    missionAuthorityConfirmations.delete(owner);
  }
}


/**
 * A mission snapshot may skip the separate "save globally" ceremony only
 * when every worker is fenced by an explicit, wildcard-free Nexus tool list.
 * The orchestrator remains the sole delegation authority.
 */
function squadSaveIsAuthorityFenced(squad: {
  readonly agents: ReadonlyArray<{
    readonly category: string;
    readonly allowedTools?: readonly string[] | null;
  }>;
}): boolean {
  return (
    squad.agents.filter((agent) => agent.category === 'orchestrator').length === 1 &&
    squad.agents.every(
      (agent) =>
        agent.category === 'orchestrator' ||
        (Array.isArray(agent.allowedTools) &&
          !agent.allowedTools.includes('*')),
    )
  );
}

function assertSquadReviewable(snapshot: SquadAuthoritySnapshot): void {
  // Dialogs no longer dump the full squad content \u2014 they show a bounded
  // summary pinned by the authority hash \u2014 so a total-length fence here only
  // blocked legitimate squads with long orchestrator instructions ("squad
  // review exceeds 6000 characters" wedged the launch flow). What must stay
  // impossible is smuggling invisible control characters into ANY string that
  // can reach an operator dialog.
  const values = squadAuthorityReviewStrings(snapshot);
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
  // Native alerts never scroll; the SHA-256 pair already pins the exact bytes
  // and the normalized content, so the integral JSON dump only overflowed the
  // screen (and vetoed legitimate large squads via the dialog size fence).
  const detail = assertExactOperatorDialog(
    `Workspace solicitante: ${safeDialogLabel(scope.rootRealPath, 512)}\n` +
      `Arquivo selecionado (JSON): ${safeDialogLabel(selectedPath, 512)}\n` +
      `SHA-256 bruto: ${candidate.rawSha256}\n` +
      `SHA-256 canônico (fixa o conteúdo normalizado integral): ${candidate.canonicalSha256}\n` +
      `Squads: ${candidate.squadCount}; agentes: ${candidate.agentCount}\n` +
      `IDs alvo: ${safeDialogLabel(candidate.targetIds.join(', '), 800)}`,
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

async function confirmSquadDelete(
  owner: WebContents,
  scope: ProjectExecutionScope,
  snapshot: SquadAuthoritySnapshot,
): Promise<boolean> {
  assertSquadReviewable(snapshot);
  const window = BrowserWindow.fromWebContents(owner);
  if (!window || window.isDestroyed()) {
    throw new Error('renderer window is unavailable');
  }
  if (squadDeleteConfirmations.has(owner)) {
    throw new Error('squad deletion confirmation is already pending');
  }
  squadDeleteConfirmations.add(owner);
  try {
    const result = await dialog.showMessageBox(window, {
      type: 'warning',
      title: 'Nexus IDE — excluir squad',
      buttons: ['Cancelar', 'Excluir squad'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      message: 'Excluir exatamente este squad global?',
      // Native message boxes grow to fit their `detail` and never scroll, so
      // dumping the full roster JSON here overflowed off-screen (worse on small
      // displays). Show a bounded, readable summary; the hash pins the exact
      // squad being deleted without an unusable wall of text.
      detail: summarizeSquadDeletionForDialog(scope, snapshot),
    });
    return result.response === 1;
  } finally {
    squadDeleteConfirmations.delete(owner);
  }
}

/** Bounded, human-readable confirmation body; exactness is pinned by the hash. */
function summarizeSquadDeletionForDialog(
  scope: ProjectExecutionScope,
  snapshot: SquadAuthoritySnapshot,
): string {
  const MAX_AGENT_LINES = 16;
  const shown = snapshot.agents.slice(0, MAX_AGENT_LINES);
  const agentLines = shown.map((agent) => {
    const model = agent.model ? ` · ${safeDialogLabel(agent.model, 48)}` : '';
    const effort = agent.effort ? ` (${safeDialogLabel(agent.effort, 24)})` : '';
    return (
      `• ${safeDialogLabel(agent.agentName, 64)} — ` +
      `${safeDialogLabel(agent.category, 32)} · ${safeDialogLabel(agent.cli, 32)}${model}${effort}`
    );
  });
  const overflow = snapshot.agents.length - shown.length;
  if (overflow > 0) {
    agentLines.push(`• +${overflow} agente(s) — conteúdo exato garantido pelo hash`);
  }
  return [
    `Workspace solicitante: ${safeDialogLabel(scope.rootRealPath, 4_096)}`,
    `Squad: ${safeDialogLabel(snapshot.name, 128)} (${safeDialogLabel(snapshot.id, 128)})`,
    `${snapshot.agents.length} agente(s):`,
    ...agentLines,
    '',
    `Hash exato (fixa o roster + contrato integral): ${snapshot.hash}`,
  ].join('\n');
}

export function configureRendererMissionAuthority(
  runtimeManager: ProjectRuntimeManager,
): void {
  missionSummaryBroadcastVersions.clear();
  projectDomainStores = configureProjectDomainStoreRegistry(runtimeManager);
  rendererMissionAuthority = new RendererMissionAuthority(projectDomainStores);
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
    for (const recovery of reconcileCompletedPetStudioMissions(suite, {
      workspaceRoot: scope.rootRealPath,
    })) {
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

function broadcastCanonicalMissionSummaries(
  scope: ProjectExecutionScope,
): void {
  const scopeKey = projectExecutionScopeKey(scope);
  const version = ++nextMissionSummaryBroadcastVersion;
  missionSummaryBroadcastVersions.set(scopeKey, version);
  void Promise.resolve()
    .then(() => missionEngineForScope(scope).list(scope))
    .then((items) => {
      if (missionSummaryBroadcastVersions.get(scopeKey) !== version) return;
      const summaries = canonicalMissionSummaryListSchema.parse(items);
      if (missionSummaryBroadcastVersions.get(scopeKey) !== version) return;
      broadcastToProject(
        listeners,
        scope,
        ORCH_CHANNELS.missionChanged,
        summaries,
      );
    })
    .catch((error) => {
      if (missionSummaryBroadcastVersions.get(scopeKey) !== version) return;
      console.warn("[orch] failed to project canonical mission summaries:", error);
    });
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
    broadcastCanonicalMissionSummaries(scope);
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

export function getOrchestrationStartHealth(): OrchestrationStartHealth {
  return (
    orchestrationStartSupervisor?.health ?? {
      status: orchestrationReady ? 'ready' : 'idle',
      attempts: 0,
      retryScheduled: false,
      nextRetryAt: null,
      lastError: null,
    }
  );
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
    initWorkerHandoffTtl();
    // Garantia de handoff (Stop-hook do modelo): worker que trabalha e fica
    // mudo não pode matar a missão em silêncio. DEFAULT-OFF: a Via Rápida
    // supervisiona os workers (boot nudge 90s, stall watchdog → blocked) e
    // completa por observação, criando zero handoffs — o enforcement global
    // brigava com essa conclusão. Religável via override de flag.
    if (
      getFeatureFlagRegistry().isEnabled(
        FEATURE_FLAG_IDS.workerHandoffEnforcement,
      )
    ) {
      initWorkerHandoffEnforcement();
    }
    const startSupervisor =
      orchestrationStartSupervisor ??
      new OrchestrationStartSupervisor({
        startMcpServer,
        resetFailedMcpStart: stopMcpServer,
        startCoordinator: () => {
          if (
            orchestrationClosing ||
            epoch !== orchestrationLifecycleEpoch
          ) {
            throw new Error(
              'orchestration startup epoch was invalidated before coordinator start',
            );
          }
          startOrchestrationCoordinator();
        },
        reportRetry: (error, health) => {
          if (health.attempts !== 1 && health.attempts % 12 !== 0) return;
          console.warn(
            '[nexus] orchestration MCP bootstrap failed; retry remains supervised:',
            {
              attempt: health.attempts,
              nextRetryAt: health.nextRetryAt,
              error: error instanceof Error ? error.message : String(error),
            },
          );
        },
      });
    orchestrationStartSupervisor = startSupervisor;
    try {
      await startSupervisor.start();
    } catch (error) {
      if (
        orchestrationClosing ||
        epoch !== orchestrationLifecycleEpoch
      ) {
        return;
      }
      throw error;
    }
    // closeOrchestration may have been requested while the localhost MCP bind
    // was pending. Never resurrect a coordinator into an invalidated epoch;
    // close owns the subsequent server/store teardown.
    if (
      orchestrationClosing ||
      epoch !== orchestrationLifecycleEpoch
    ) {
      return;
    }
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
  const pendingStartSupervisor = orchestrationStartSupervisor;
  const pendingInitSettlement = pendingInit?.then(
    () => undefined,
    () => undefined,
  );
  const close = (async () => {
    // Cancel a scheduled retry first. If a bind is already in flight, stop()
    // drains that exact attempt before any MCP/store teardown can run.
    await pendingStartSupervisor?.stop();
    // A pending startMcpServer owns mutable server state. Let it settle, but
    // the invalidated epoch check above guarantees it cannot start a new
    // coordinator after shutdown was requested.
    await pendingInitSettlement;
    // Wait for the current main-owned reconcile participant before tearing
    // down stores it may still be using. A rejected stop is deliberately
    // fail-closed: none of the teardown below is allowed to run.
    await stopOrchestrationCoordinator();
    disposeSquadBroadcast?.();
    disposeSquadBroadcast = null;
    shutdownIdleDelivery();
    shutdownWorkerHandoffTtl();
    shutdownWorkerHandoffEnforcement();
    stopAllPreviews();
    stopRemoteBridge();
    stopMcpServer();
    disposeProjectDomainStoreRegistry();
    projectDomainStores = null;
    rendererMissionAuthority = null;
    lastMissionsByScope.clear();
    missionSummaryBroadcastVersions.clear();
    squadDesignDrafts.clear();
    orchestrationReady = false;
    orchestrationShutdownBlocked = false;
    if (orchestrationStartSupervisor === pendingStartSupervisor) {
      orchestrationStartSupervisor = null;
    }
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

type AnswerQuestionCommand = Extract<
  MissionEngineCommand,
  { readonly kind: "answer-question" }
>;
type ClarifyAnswerInput = Parameters<
  typeof prepareClarifyAnswerAuthorityCandidate
>[2];

function clarifyAnswerInputFromCommand(
  command: AnswerQuestionCommand,
): ClarifyAnswerInput {
  const answer = command.optionId ?? command.text;
  if (!answer) {
    throw new Error("canonical clarify answer is absent");
  }
  return {
    missionId: command.missionId,
    questionId: command.questionId,
    answer,
  };
}

async function runOperatorClarifyAnswer(
  owner: WebContents,
  scope: ProjectExecutionScope,
  stores: ProjectDomainStoreSuite,
  rawInput: ClarifyAnswerInput,
) {
  const candidate = prepareClarifyAnswerAuthorityCandidate(
    stores,
    scope,
    rawInput,
  );
  if (!(await confirmClarifyAnswer(owner, scope, candidate))) {
    throw new Error("user_denied");
  }
  requireLiveRendererWorkspaceScope(owner, scope);
  return persistClarifyAnswer(
    stores,
    scope,
    rawInput,
    candidate.fence,
  );
}

async function runOperatorMissionStop(
  owner: WebContents,
  scope: ProjectExecutionScope,
  suite: ProjectDomainStoreSuite,
  missionId: string,
) {
  if (!suite.missions.get(missionId)) {
    return withMissionLifecycleLock(scope, missionId, () => {
      requireLiveRendererWorkspaceScope(owner, scope);
      // A stale renderer leaf remains physically reconcilable after its
      // durable row disappears, but not if that row reappears under the lock.
      if (suite.missions.get(missionId)) {
        return {
          ok: false,
          terminatedSessionIds: [],
          error:
            "A missão reapareceu durante a reconciliação. Tente encerrar novamente.",
        };
      }
      return closeOrphanedMissionRuntime({ scope, missionId });
    });
  }
  const candidate = prepareMissionRuntimeTermination({
    scope,
    suite,
    missionId,
    reason: "operator-close",
  });
  if (!(await confirmMissionRuntimeClose(owner, scope, candidate))) {
    return {
      ok: false,
      cancelled: true,
      terminatedSessionIds: [],
    };
  }
  return withMissionLifecycleLock(scope, missionId, () => {
    requireLiveRendererWorkspaceScope(owner, scope);
    if (!suite.missions.get(missionId)) {
      return closeOrphanedMissionRuntime({ scope, missionId });
    }
    // Re-derive the physical inventory under the recovery/bootstrap mutex.
    // closeMissionRuntimePreservingHistory durably blocks before its first
    // await and resolves ok only with physical-exit proof.
    return closeMissionRuntimePreservingHistory({
      scope,
      suite,
      missionId,
    });
  });
}

export function registerOrchIpc(): void {
  ipcMain.handle(ORCH_CHANNELS.paneOperatorInput, (event, raw): boolean => {
    const parsed = paneOperatorInputSchema.safeParse(raw);
    if (!parsed.success) return false;
    const { sessionId, data } = parsed.data;
    // Bracketed paste é o transporte da injeção orquestrada (kickoff, handoff,
    // resposta de ferramenta). Ele continua entrando só pelo lane com recibo:
    // o operador digita, não injeta contrato.
    if (data.includes("\x1b[200~") || data.includes("\x1b[201~")) return false;
    // Posse de apresentação é do main, não do payload: só quem realmente
    // mostra a sessão pode falar por ela.
    const info = getOwnedAgentSessionInfo(event.sender, sessionId);
    if (!info?.missionId) return false;
    const scope = requireLiveRendererWorkspaceScope(event.sender);
    const missions = getProjectDomainStores(scope).missions;
    const mission = missions.get(info.missionId);
    if (!mission || mission.status === "done" || mission.status === "failed") {
      return false;
    }
    return orchWriteSession(sessionId, data, { markInputBusy: true });
  });

  ipcMain.on(ORCH_CHANNELS.panesSync, (event, raw) => {
    const envelope = panesSyncEnvelopeSchema.safeParse(raw);
    const legacy = envelope.success ? null : panesSyncSchema.safeParse(raw);
    const entries = envelope.success
      ? envelope.data.entries
      : legacy?.success
        ? legacy.data
        : null;
    if (entries) {
      syncPanes(
        entries,
        event.sender,
        envelope.success ? envelope.data.generationId : undefined,
      );
      for (const pane of entries) {
        rendererMissionAuthority?.restorePersistedPaneAuthority(
          event.sender,
          pane.paneId,
        );
      }
    }
  });

  ipcMain.on(ORCH_CHANNELS.paneSpawnResult, (event, raw) => {
    const parsed = orchPaneSpawnResultSchema.safeParse(raw);
    if (parsed.success) {
      resolvePaneSpawn(parsed.data, event.sender);
    }
  });

  ipcMain.on(ORCH_CHANNELS.paneRecoveryResult, (event, raw) => {
    const parsed = missionPaneRecoveryResultSchema.safeParse(raw);
    if (parsed.success) {
      resolveMissionPaneRecovery(parsed.data, event.sender);
    }
  });

  ipcMain.on(ORCH_CHANNELS.browserOpenResult, (event, raw) => {
    const parsed = browserPaneOpenResultSchema.safeParse(raw);
    if (parsed.success) resolveBrowserOpen(parsed.data, event.sender);
  });

  ipcMain.handle(ORCH_CHANNELS.missionsList, (event) =>
    requireProjectStores(event.sender).missions.list(),
  );
  ipcMain.handle(ORCH_CHANNELS.missionPrepare, async (event, raw) => {
    const request = missionPrepareRequestSchema.parse(raw);
    const scope = requireLiveRendererWorkspaceScope(event.sender);
    const review = await missionEngineForScope(scope).prepare(scope, request);
    return missionReviewSchema.parse(review);
  });
  ipcMain.handle(ORCH_CHANNELS.missionStart, async (event, raw) => {
    const input = missionStartSchema.parse(raw);
    const scope = requireLiveRendererWorkspaceScope(event.sender);
    const stores = getProjectDomainStores(scope);
    const mission = stores.missions.get(input.missionId);
    if (mission?.squadId === PET_STUDIO_SQUAD.id) {
      if (
        mission.intentContract?.approvalReviewSha256 !== input.reviewSha256
      ) {
        throw new Error('pet review fence mismatch before confirmation');
      }
      const confirmed = await confirmPetStudioMissionStart(
        event.sender,
        scope,
        mission,
        input.reviewSha256,
      );
      if (!confirmed) throw new Error('user_denied');
      requireLiveRendererWorkspaceScope(event.sender, scope);
      const current = stores.missions.get(input.missionId);
      if (
        !current ||
        current.squadId !== mission.squadId ||
        current.updatedAt !== mission.updatedAt ||
        current.intentVersion !== mission.intentVersion ||
        current.intentContract?.approvalReviewSha256 !==
          input.reviewSha256 ||
        JSON.stringify(current.intentContract?.attachmentSnapshots) !==
          JSON.stringify(mission.intentContract?.attachmentSnapshots)
      ) {
        throw new Error(
          'pet start became stale while native confirmation was open',
        );
      }
    }
    const snapshot = await withMissionLifecycleLock(
      scope,
      input.missionId,
      () => missionEngineForScope(scope).start(scope, input),
    );
    return missionSnapshotSchema.parse(snapshot);
  });
  ipcMain.handle(ORCH_CHANNELS.missionCommand, async (event, raw) => {
    const rawDirect = raw as {
      readonly kind?: unknown;
      readonly text?: unknown;
    };
    if (rawDirect?.kind === "direct" && typeof rawDirect.text === "string") {
      assertSafePtyPrompt(rawDirect.text);
    }
    const command = missionEngineCommandSchema.parse(raw);
    const scope = requireLiveRendererWorkspaceScope(event.sender);
    if (command.kind === "answer-question") {
      const stores = requireProjectStores(event.sender);
      await runOperatorClarifyAnswer(
        event.sender,
        scope,
        stores,
        clarifyAnswerInputFromCommand(command),
      );
      const snapshot = await missionEngineForScope(scope).snapshot(
        scope,
        command.missionId,
      );
      return missionSnapshotSchema.parse(snapshot);
    }
    if (command.kind === "stop") {
      const result = await runOperatorMissionStop(
        event.sender,
        scope,
        requireProjectStores(event.sender),
        command.missionId,
      );
      if (!result.ok) {
        if ("cancelled" in result && result.cancelled === true) {
          throw new Error("user_denied");
        }
        const error =
          "error" in result && typeof result.error === "string"
            ? result.error
            : "mission runtime did not provide physical exit proof";
        throw new Error(error);
      }
      const snapshot = await missionEngineForScope(scope).snapshot(
        scope,
        command.missionId,
      );
      return missionSnapshotSchema.parse(snapshot);
    }
    const snapshot = await missionEngineForScope(scope).command(scope, command);
    return missionSnapshotSchema.parse(snapshot);
  });
  ipcMain.handle(ORCH_CHANNELS.missionSnapshot, async (event, raw) => {
    const missionId = canonicalMissionIdSchema.parse(raw);
    const scope = requireLiveRendererWorkspaceScope(event.sender);
    const snapshot = await missionEngineForScope(scope).snapshot(
      scope,
      missionId,
    );
    return missionSnapshotSchema.parse(snapshot);
  });
  ipcMain.handle(ORCH_CHANNELS.missionList, async (event, raw) => {
    canonicalMissionNoInputSchema.parse(raw);
    const scope = requireLiveRendererWorkspaceScope(event.sender);
    const items = await missionEngineForScope(scope).list(scope);
    return canonicalMissionSummaryListSchema.parse(items);
  });
  ipcMain.handle(ORCH_CHANNELS.missionPanesList, (event, raw) => {
    if (typeof raw !== "string" || raw.length === 0 || raw.length > 128) {
      return [];
    }
    return requireMissionAuthority().listMissionPanesForRenderer(
      event.sender,
      raw,
    );
  });
  ipcMain.handle(ORCH_CHANNELS.missionControlPlane, (event, raw) => {
    const parsed = z
      .object({ missionId: z.string().min(1).max(128) })
      .strict()
      .safeParse(raw);
    if (!parsed.success) return null;
    // requireProjectStores confines this projection to the renderer's live
    // workspace; pane filtering below remains mission-scoped.
    const stores = requireProjectStores(event.sender);
    const mission = stores.missions.get(parsed.data.missionId);
    if (!mission) return null;
    try {
      return missionControlPlaneSnapshot(
        stores,
        mission,
        listPaneSnapshots(),
        Date.now(),
      );
    } catch {
      return null;
    }
  });
  ipcMain.handle(
    ORCH_CHANNELS.missionPaneRestoreAuthority,
    (event, raw) => {
      const parsed = z
        .object({
          missionId: z.string().min(1).max(128),
          paneId: z.string().min(1).max(128),
        })
        .safeParse(raw);
      if (!parsed.success) return false;
      return requireMissionAuthority().canRestoreMissionPaneForRenderer(
        event.sender,
        parsed.data.missionId,
        parsed.data.paneId,
      );
    },
  );



  ipcMain.handle(ORCH_CHANNELS.missionResumeBootstrap, (event, raw) => {
    const parsed = missionResumeBootstrapSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error("invalid mission bootstrap resume payload");
    }
    return resumeBlockedMissionBootstrapFromRenderer(event.sender, parsed.data);
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

  const missionPromoteOrchestratorSchema = z
    .object({
      missionId: z.string().min(1).max(128),
      paneId: z.string().min(1).max(128).optional(),
      sessionId: z.string().min(1).max(128).optional(),
    })
    .refine((value) => Boolean(value.paneId ?? value.sessionId));
  ipcMain.handle(ORCH_CHANNELS.missionPromoteOrchestrator, (event, raw) => {
    const parsed = missionPromoteOrchestratorSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: "invalid_payload" };
    const result = requireMissionAuthority().promoteOrchestratorFromRenderer(
      event.sender,
      parsed.data.missionId,
      {
        paneId: parsed.data.paneId,
        sessionId: parsed.data.sessionId,
      },
    );
    if (result.ok && result.mission) {
      const scope = requireRendererWorkspaceScope(event.sender);
      redeliverPendingHandoffs(scope, result.mission.id);
      broadcastProjectStore(scope, "missions");
    }
    return result;
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
    if (
      parsed.data.patch.status === "blocked" ||
      parsed.data.patch.status === "failed"
    ) {
      const scope = requireLiveRendererWorkspaceScope(event.sender);
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
      return withMissionLifecycleLock(
        scope,
        parsed.data.missionId,
        async () => {
          requireLiveRendererWorkspaceScope(event.sender, scope);
          const mission = authority.updateMissionFromRenderer(
            event.sender,
            parsed.data.missionId,
            parsed.data.patch,
            candidate.fence,
          );
          if (!mission) throw new Error("mission not found");
          const suite = requireProjectStores(event.sender);
          const settled = await settleMissionRuntimeDemotion({
            scope,
            suite,
            demotedMission: mission,
          });
          return settled.mission;
        },
      );
    }
    const mission = authority.updateMissionFromRenderer(
      event.sender,
      parsed.data.missionId,
      parsed.data.patch,
    );
    if (!mission) throw new Error("mission not found");
    return mission;
  });

  const missionCloseRuntimeSchema = z
    .object({ missionId: z.string().min(1).max(128) })
    .strict();
  ipcMain.handle(ORCH_CHANNELS.missionCloseRuntime, async (event, raw) => {
    const parsed = missionCloseRuntimeSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error("invalid mission close runtime payload");
    }
    const scope = requireLiveRendererWorkspaceScope(event.sender);
    return runOperatorMissionStop(
      event.sender,
      scope,
      requireProjectStores(event.sender),
      parsed.data.missionId,
    );
  });

  ipcMain.handle(ORCH_CHANNELS.missionRemove, async (event, raw) => {
    const parsed = missionRemoveSchema.safeParse(raw);
    if (!parsed.success) throw new Error("invalid mission remove payload");
    const scope = requireLiveRendererWorkspaceScope(event.sender);
    return withMissionLifecycleLock(
      scope,
      parsed.data.missionId,
      async () => {
        requireLiveRendererWorkspaceScope(event.sender, scope);
        const authority = requireMissionAuthority();
        const suite = requireProjectStores(event.sender);
        const candidate = authority.missionRemovalCandidateFromRenderer(
          event.sender,
          parsed.data.missionId,
        );
        if (!candidate) return { removed: false };
        const prepared = authority.prepareMissionRemovalFromMain(
          event.sender,
          candidate.missionId,
          candidate.fence,
        );
        if (!prepared) return { removed: false };
        let terminationError: string | null = null;
        try {
          const termination = await terminateMissionRuntime({
            scope,
            suite,
            missionId: prepared.missionId,
            reason: "operator-close",
            collapsePanes: true,
          });
          if (!termination.ok) {
            terminationError =
              termination.error ??
              "o runtime não forneceu prova física de saída";
          }
        } catch (error) {
          terminationError =
            error instanceof Error ? error.message : String(error);
        }
        if (terminationError) {
          const current = suite.missions.get(parsed.data.missionId);
          const terminalHistory =
            current?.status === 'done' || current?.status === 'failed';
          if (
            !terminalHistory ||
            missionHasLivePhysicalSession(scope, parsed.data.missionId)
          ) {
            throw new Error(
              "Remoção recusada. O histórico foi preservado junto com a missão, " +
                "tasks e receipts porque o teardown não comprovou a saída física: " +
                terminationError,
            );
          }
        }
        requireLiveRendererWorkspaceScope(event.sender, scope);
        const removed = authority.removeMissionFromRenderer(
          event.sender,
          parsed.data.missionId,
          prepared.fence,
        );
        if (removed) deleteMissionPromptQueue(scope, parsed.data.missionId);
        return { removed };
      },
    );
  });

  ipcMain.handle(ORCH_CHANNELS.handoffsList, (event) =>
    requireProjectStores(event.sender).handoffs.list({
      includeDelivered: true,
    }),
  );
  ipcMain.handle(ORCH_CHANNELS.clarifyAnswerSubmit, async (event, raw) => {
    const scope = requireLiveRendererWorkspaceScope(event.sender);
    return runOperatorClarifyAnswer(
      event.sender,
      scope,
      requireProjectStores(event.sender),
      raw,
    );
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
                // O time salvo do operador é lei: um squad pronto (todos os
                // CLIs roteáveis e verificados) carrega os modelos/efforts
                // que ele escolheu. O template determinístico roteava o
                // modelo default do adapter — vide as 3 mortes de worker em
                // gpt-5.5 com o time salvo apontando gpt-5.6-luna. O aviso
                // "Reusando o squad salvo…" + o editor de roster na tela
                // seguinte preservam a visibilidade e a troca em um clique.
                preferSavedSquad: true,
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
      if (
        value &&
        typeof value === 'object' &&
        (value as { ok?: unknown }).ok === true &&
        (value as { squad?: unknown }).squad
      ) {
        const squad = squadSchema.parse(
          (value as { squad: unknown }).squad,
        );
        return {
          ...(value as Record<string, unknown>),
          squad,
          designDraftToken: rememberSquadDesignDraft(
            event.sender,
            scope,
            squad,
          ),
        };
      }
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
    const runtimeRequest = missionRuntimeSquadSaveSchema.safeParse(raw);
    const globalRequest = runtimeRequest.success
      ? null
      : squadSchema.safeParse(raw);
    if (!runtimeRequest.success && !globalRequest?.success) {
      return { ok: false, error: "invalid squad payload" };
    }
    try {
      const scope = requireLiveRendererWorkspaceScope(event.sender);

      if (runtimeRequest.success) {
        const draftSourceSquad = runtimeRequest.data.designDraftToken
          ? resolveSquadDesignDraft(
              event.sender,
              scope,
              runtimeRequest.data.designDraftToken,
              runtimeRequest.data.sourceSquadId,
            )
          : null;
        const catalogSourceSquad = runtimeRequest.data.designDraftToken
          ? null
          : listSquads().find(
              (squad) => squad.id === runtimeRequest.data.sourceSquadId,
            );
        const sourceSquad = catalogSourceSquad ?? draftSourceSquad;
        if (!sourceSquad) {
          throw new Error('mission runtime source squad is unavailable');
        }
        const guided =
          draftSourceSquad !== null ||
          isEngineGeneratedSquadId(sourceSquad.id);
        if (runtimeRequest.data.guided !== guided) {
          throw new Error(
            'mission runtime guided identity does not match its main-owned source',
          );
        }
        const sourceSnapshot = snapshotSquadAuthority(sourceSquad);
        // The renderer supplies reviewed content, never a durable identity.
        // Main resolves the reviewed source, seals its lineage, creates a
        // collision-resistant hidden identity and refuses every later
        // overwrite of that namespace.
        const runtimeSquad: Squad = {
          ...runtimeRequest.data.squad,
          id:
            `${guided ? 'agentic' : 'mission'}-runtime-` +
            randomUUID(),
          createdAt: String(Date.now()),
          builtin: false,
          runtimeSourceSquadId: sourceSquad.id,
          runtimeSourceSquadRevisionHash: sourceSnapshot.hash,
          agents: runtimeRequest.data.squad.agents.map((agent) => ({
            ...agent,
          })),
        };
        if (!isMissionRuntimeSquadId(runtimeSquad.id)) {
          throw new Error('main generated an invalid mission runtime squad id');
        }
        const candidate = prepareMissionRuntimeSquadSave(
          runtimeSquad,
          sourceSquad,
          guided,
          catalogSourceSquad ? 'catalog' : 'ephemeral',
        );
        if (
          listSquads().some((squad) => squad.id === candidate.squad.id) ||
          !squadSaveIsAuthorityFenced(candidate.squad)
        ) {
          throw new Error(
            'mission runtime squad must be new and authority-fenced',
          );
        }
        const saved = applyPreparedSquadSave(candidate);
        if (
          draftSourceSquad &&
          runtimeRequest.data.designDraftToken
        ) {
          squadDesignDrafts.delete(runtimeRequest.data.designDraftToken);
        }
        return { ok: true, squad: saved };
      }

      if (!globalRequest || !globalRequest.success) {
        throw new Error('invalid global squad payload');
      }
      const parsed = globalRequest.data;
      const existingInput = listSquads().find(
        (squad) => squad.id === parsed.id,
      );
      if (
        parsed.id !== PET_STUDIO_SQUAD_ID &&
        (parsed.builtin || existingInput?.builtin)
      ) {
        throw new Error(
          'managed built-in squads cannot be edited; duplicate with a new id',
        );
      }
      const candidate = prepareSquadSave(parsed);

      // Pet Studio is immutable app-owned data. Repairing it writes no
      // renderer authority and must not add a second modal before its mission.
      if (candidate.squad.id === PET_STUDIO_SQUAD_ID) {
        const current = listSquads().find(
          (squad) => squad.id === PET_STUDIO_SQUAD_ID,
        );
        if (
          current &&
          snapshotSquadAuthority(current).hash === candidate.snapshot.hash
        ) {
          return { ok: true, squad: current };
        }
        assertSquadNotExecuting(event.sender, candidate.squad.id);
        const saved = applyPreparedSquadSave(candidate);
        return { ok: true, squad: saved };
      }

      const existing = listSquads().find(
        (squad) => squad.id === candidate.squad.id,
      );
      if (
        isMissionRuntimeSquadId(candidate.squad.id) ||
        (existing && isMissionRuntimeSquadId(existing.id))
      ) {
        throw new Error('mission runtime squads are immutable');
      }
      // Saving reusable configuration is an inert draft operation: it spawns
      // no process, grants no token and spends no budget. Execution still
      // creates an immutable runtime copy and requires the single native
      // mission approval with the exact roster and hashes. Delete/import keep
      // their destructive confirmations.
      assertSquadNotExecuting(event.sender, candidate.squad.id);
      requireLiveRendererWorkspaceScope(event.sender, scope);
      assertSquadNotExecuting(event.sender, candidate.squad.id);
      const saved = applyPreparedSquadSave(candidate);
      return { ok: true, squad: saved };
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
      if (isMissionRuntimeSquadId(existing.id)) {
        throw new Error('mission runtime squads are immutable');
      }
      const snapshot = snapshotSquadAuthority(existing);
      const approved = await confirmSquadDelete(
        event.sender,
        scope,
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
      const assertCurrentAuthority = (): void => {
        requireLiveRendererWorkspaceScope(event.sender, scope);
      };
      const importTool = buildDesignSystemTools({
        assertCurrentAuthority,
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
      // designmd.ai answers 401 without `external:designmd-api-key`, so the
      // button walks down to the keyless sources instead of failing outright —
      // and always reports which one served. Real failures still surface.
      const outcome = await importDesignContractWithKeylessFallback({
        ctx,
        identifier: parsed.data.identifier,
        targetPath: parsed.data.targetPath ?? DEFAULT_DESIGN_TARGET_PATH,
        assertCurrentAuthority,
        runRemoteImport: async () =>
          (await importTool.handler(parsed.data, ctx)) as Record<string, unknown>,
      });
      return {
        ok: true,
        servedBy: outcome.servedBy,
        attempts: outcome.attempts,
        ...outcome.draft,
      };
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
