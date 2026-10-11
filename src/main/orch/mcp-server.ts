import { heavyZshProfile } from './native-heavy-zdotdir';
import { handleNativeHeavyCommandHttp, nativeHeavyCommands } from './native-heavy-command';
import { appendHeavyCommandPreload, heavyCommandPreloadPath, heavyCommandShellEnvironment, selectGrokHeavyShell } from './native-heavy-preload';
import { analysisClient, flushPtyAnalysis, subscribePtyAnalysis } from '../pty/pty-analysis-runtime';
import type { AnalysisFence } from '../pty/pty-analysis-protocol';
import http from "node:http";
import { isSharedPaneSpaceWorktree } from '../pty/pane-space-worktree';
import { FEATURE_FLAG_IDS } from "../../shared/feature-flags";
import { getFeatureFlagRegistry } from "../feature-flags/feature-flag-registry";
import { createDestructiveReversibilityPreparer } from "./destructive-reversibility-production";
import { createSystemReversibilityIo } from "./destructive-reversibility-system-io";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { app } from "electron";
import { showMessageBoxWithoutBlocking } from "../native-confirm";
import type { McpRuntimeInfo, Mission } from "../../shared/orch-types";
import { hasCurrentApprovedDispatchContract } from "../../shared/mission-intent";
import { PET_STUDIO_SQUAD_ID } from "../../shared/pet-studio";
import {
  getAgentSessionInfo,
  getSessionState,
  orchWriteSession,
  setAgentSpawnHook,
  setDeferredInitialPromptHook,
  tapSessionExit,
  tapSessionState,
  tapSessionTermination,
  type AgentSpawnDecoration,
  type AgentSpawnHook,
} from "../pty/pty-manager";

import { deliverAgentPrompt } from "./tool-util";
import {
  revalidateSealedAttachmentSnapshots,
  workspaceRootAuthorityFromScope,
} from "../persistence/dropped-files";
import {
  bindTokenToSession,
  evaluateStop,
  getContext,
  getContextBySession,
  isCurrentGateContext,
  mintToken,
  registerHardenedSpawnPolicy,
  releaseSession,
  releaseSessionByToken,
  type AgentGateContext,
} from "./gate";
import { installWorktreeSalvageNotifier } from "./worktree-salvage-notice";
import {
  createHandoffSpoolSession,
  disposeHandoffSpoolBySession,
  handoffSpoolRoot,
  startHandoffSpool,
  stopHandoffSpool,
  type HandoffSpoolSession,
} from "./handoff-spool";
import { onHandoffSubmitted } from "./idle-delivery";
import {
  handleMcpMessage,
  isJsonRpcRequest,
  type JsonRpcResponse,
  type McpRegistry,
} from "./mcp-protocol";
import {
  runInsideHttpMcpTransport,
  runInsidePtyStreamAgentTransport,
} from "./http-mcp-boundary";
import {
  dispatchToolCall,
  type ToolDispatchResult,
} from "./mcp-dispatch";
import { dispatchPtyStreamMissionAction } from "./pty-stream-dispatch";
import {
  McpConfirmationExpiredError,
  type McpConfirmationHandler,
  type McpConfirmationRequest,
} from "./mcp-dispatch-contract";
import { McpConfirmationScheduler } from "./mcp-confirmation-scheduler";
import { clearSession as clearMcpPermissionSession } from "../jarvis/permissions";
import {
  boundedConfirmationArgs,
  boundedConfirmationLine,
} from "./confirmation-format";
import { MAX_MCP_PAYLOAD_BYTES } from "./mcp-args-validation";
import { buildToolset } from "./tools";
import {
  assertMissionSpawnAuthorityCurrent,
} from "./pane-registry";
import {
  isPlaceholderSummary,
  LegacyHandoffDedupe,
} from "./legacy-handoff";
import { missionMarkerObserver } from "./mission-completion-marker";
import { requireMissionLeaderSession } from "./mission-leader-gate";
import { getProjectDomainStores } from "./project-domain-store-registry";
import {
  isStaleReadOnlyObservationHandoffResult,
  submitPtyStreamHandoff,
  terminateStaleReadOnlyMcpSession,
  terminateStaleReadOnlyPtyStreamSession,
} from "./pty-stream-handoff";
import {
  installPtyStreamMissionControl,
  PtyStreamMissionControl,
} from "./pty-stream-mission-control";
import { cliPromptAutoResponder } from "./cli-prompt-autoresponder";
import { CLAUDE_MANAGED_AUTH_ENV, validateManagedClaudeAuthDirectory } from "../adapters/managed-claude-auth";
import {
  cleanupSessionArtifacts,
  ensureNativeClaudeProjectTrust,
  prepareEphemeralHome,
  writeClaudeFamilyZeroClickSettings,
  writeMcpConfigFile,
} from "./hooks-gen";
import { handleHookStatusHttp } from "./hook-status-endpoint";
import { handleHookTriageHttp } from "./hook-triage-endpoint";
import { handleHookRegressionHttp } from "./hook-regression-endpoint";
import { handleHookIntegrationHttp } from "./hook-integration-endpoint";
import { handleHookPermissionHttp } from "./hook-permission-endpoint";
import { handleHookDelegateHttp } from "./hook-delegate-endpoint";
import { authenticateArmsToken } from "../connectors/arms-token-store";
import { handleArmsJsonRpc, markArmsBoot } from "../connectors/arms-endpoint";
import { emitAppEvent } from "../connectors/app-events";
import {
  isMcpSharedHubEnabled,
  McpStdioBridge,
  resolveMcpHubBridgeKeys,
  resolveNativeStdioServerDescriptor,
} from "../mcp-hub/mcp-stdio-bridge";

import {
  resolveArmsRuntimeDescriptorPath,
  resolveArmsRuntimeInstance,
  type ArmsRuntimeInstance,
} from "./arms-runtime-path";
import { prepareMinimaxMcpSession } from "./cli-mcp-session-minimax";
import { prepareMuseMcpSession } from "./cli-mcp-session-muse";
import { ensureAgyNexusMcpRegistration } from "./cli-mcp-session-agy";
import { ensureDevinNexusMcpRegistration } from "./cli-mcp-session-devin";

export { resolveArmsRuntimeDescriptorPath, resolveArmsRuntimeInstance, type ArmsRuntimeInstance };

export function getArmsRuntimeDescriptorInfo(): {
  instance: ArmsRuntimeInstance;
  descriptorPath: string;
} {
  const instance = resolveArmsRuntimeInstance(app.isPackaged);
  return {
    instance,
    descriptorPath: resolveArmsRuntimeDescriptorPath(os.homedir(), instance),
  };
}

export function buildArmsRuntimeDescriptor(
  boundPort: number,
  instance: ArmsRuntimeInstance,
  descriptorPath: string,
  at = Date.now(),
): {
  schemaVersion: 1;
  port: number;
  at: number;
  instance: ArmsRuntimeInstance;
  descriptorPath: string;
} {
  return {
    schemaVersion: 1,
    port: boundPort,
    at,
    instance,
    descriptorPath,
  };
}

/**
 * Porta viva do loopback server para o bin nexus-arms descobrir o app sem
 * token no arquivo (o token entra por env na config do conector externo).
 * Sem segredo aqui — só a porta e o instante do boot.
 */
function writeArmsRuntimeDescriptor(boundPort: number): void {
  const { instance, descriptorPath } = getArmsRuntimeDescriptorInfo();
  try {
    fs.mkdirSync(path.dirname(descriptorPath), { recursive: true });
    fs.writeFileSync(
      descriptorPath,
      `${JSON.stringify(
        buildArmsRuntimeDescriptor(boundPort, instance, descriptorPath),
        null,
        2,
      )}\n`,
      { mode: 0o644 },
    );
  } catch (error) {
    console.warn("[arms] runtime descriptor write failed:", error);
  }
}

function removeArmsRuntimeDescriptor(): void {
  const { descriptorPath } = getArmsRuntimeDescriptorInfo();
  try {
    fs.rmSync(descriptorPath, { force: true });
  } catch {
    /* best effort */
  }
}
import {
  getAgentSemanticStatusBySession,
  isSessionInjectableIdle,
  resetAgentStatusOnExit,
} from "./agent-status";
import { startAgentScreenDetection } from "../detect/detector";
import { startJevPaneStateClassifier } from "../jev/jev-pane-state";
import { setToolPickRegistry } from "./tools-tool-pick";
import { installMcpSessionTerminationRevocation } from "./mcp-session-revocation";
import { codexStatusHookArgs } from "./hook-status-config";
import { codexPrivateHookArgs } from "./codex-private-hook-trust";
import {
  cleanupAgyMcpConfig,
  canUseNexusMcp,
  codexMcpArgs,
  purgeStaleAgyMcpConfigs,
  supportsMcpInjection,
} from "./cli-mcp-inject";
import {
  cleanupCliMcpSession,
  prepareGrokMcpSession,
  prepareKimiMcpSession,
  prepareOpenCodeMcpSession,
  prepareMimoMcpSession,
  prepareQwenMcpSession,
  purgeStaleCliMcpSessions,
} from "./cli-mcp-session-config";
import { readTomlObject } from "./cli-mcp-session-artifacts";
import { recoverMuseNativeHeavyLeases } from "./native-heavy-muse-lease";
import { getActiveAgentHookHttpServer } from "../agent-hooks/hook-http-server";
import { registerMimoRuntime } from "../agent-hooks/mimo-session-registry";
import { currentMimoSessionOwnerKey } from "../adapters/mimo-session-owner";
import {
  claudeFamilyHubMcpServers,
  codexHubMcpArgs,
  loadMcpHubServersForSpawn,
  selectHubServersForSpawn,
  type McpHubSpawnServer,
} from "../mcp-hub/mcp-hub-spawn";
import { ensureSkillsForCli } from "./skill-mirror";
import {
  isPetStudioNativeWorkspaceAuthority,
} from "../pty/autonomous-cli-policy";
import { getOrchSettings } from "../persistence/settings-store";
import { isGovernedPolicy, isOperatorChoicePolicy } from "../../shared/squad-cli-policy";
import {
  isThirdPartyClaudeFamily,
  requiresSpawnGate,
  shouldUseEphemeralHome,
  acceptsClaudeMcpCliFlags,
  usesClaudeHomeLayout,
} from "./spawn-home-policy";
import { nativeSubagentPolicyArgs } from "./native-subagent-policy";
import {
  findActiveContextDraftReviewerId,
} from "../context/cli-context-draft-reviewer";
import {
  listenOnLoopback,
  ReplaceableEventTapScope,
} from "./mcp-server-lifecycle";
import { automatedReviewSessions } from "../context/automated-review-session";
import { getContextWorkflowService } from "../context/context-workflow-registry";
import {
  automatedReviewSkills,
  automatedReviewTools,
  isExactInternalPrevcReviewerProfile,
  sameExactProfileList,
  type InternalPrevcReviewerAuthority,
} from "./prevc-reviewer-profile";
import type { BoundSpawnAuthority } from "./spawn-authority";
import { resolveCwdForScope } from "./workspace-path";
import {
  createMissionShimRuntime,
  isMissionShimSandboxSupported,
  type MissionShimRuntime,
} from "./mission-shim-runtime";

/**
 * Embedded MCP server (docs/ARCHITECTURE.md §E.2): a localhost HTTP endpoint
 * speaking MCP streamable-HTTP JSON-RPC, exposing the nexus_* tools to the
 * CLI agents running inside PTY panes. The same server hosts the /gate/*
 * endpoints used by the client-side skill-gate hooks.
 *
 * Every agent session gets its own bearer token bound to its allowlists —
 * authentication is per-agent, the port never leaves 127.0.0.1.
 */

const MAX_BODY_BYTES = MAX_MCP_PAYLOAD_BYTES;

let server: http.Server | null = null;
let port = 0;
let registry: McpRegistry | null = null;
let mcpStopFlight: Promise<void> | null = null;
const sessionTokens = new Map<string, string>(); // sessionId → token
const missionShims = new Set<MissionShimRuntime>();
const missionShimBySession = new Map<string, MissionShimRuntime>(); // sessionId → runtime
let disposeTerminationRevocation: (() => void) | null = null;
let disposePtyMissionControl: (() => void) | null = null;
let disposeScreenDetection: (() => void) | null = null;
let disposeJevPaneClassifier: (() => void) | null = null;
/** Hub MCP compartilhado (07645): um McpStdioBridge por vida do servidor embutido. */
let mcpStdioHub: McpStdioBridge | null = null;
const legacyParserTaps = new ReplaceableEventTapScope();
/**
 * First-run interstitial responder (workspace trust, data-sharing consent,
 * migration offers). It shares the operator's kill switch with
 * `cliPromptAutoResponder`: one switch in Settings › Mission Driver disables
 * every automatic keypress Nexus can make.
 */


const missionShimDisposals = new Map<MissionShimRuntime, Promise<void>>();

function disposeMissionShim(runtime: MissionShimRuntime | null): void {
  if (!runtime) return;
  missionShims.delete(runtime);
  for (const [sessionId, candidate] of missionShimBySession) {
    if (candidate === runtime) missionShimBySession.delete(sessionId);
  }
  const disposal = runtime.dispose();
  missionShimDisposals.set(runtime, disposal);
  void disposal.then(
    () => { if (missionShimDisposals.get(runtime) === disposal) missionShimDisposals.delete(runtime); },
    () => { console.warn('[mission-shim] disposal incomplete; retained for lifecycle drain'); },
  );
}

/** Errors are observed immediately and remain failures for the lifecycle owner. */
export async function drainMissionShimDisposals(): Promise<void> {
  for (const runtime of [...missionShims]) disposeMissionShim(runtime);
  for (const runtime of [...missionShimDisposals.keys()]) disposeMissionShim(runtime);
  await Promise.all([...missionShimDisposals.values()]);
}

function disposeMissionShimBySession(sessionId: string): void {
  disposeMissionShim(missionShimBySession.get(sessionId) ?? null);
}

/**
 * F-1236: prazo da confirmação HTTP de agente. Longo de propósito (o operador
 * pode estar lendo o pedido, noutra janela, numa call), mas finito: sheet numa
 * janela minimizada ou noutro Space ficava aberto para sempre e, como o
 * scheduler mostra uma confirmação por vez, segurava as de todas as sessões.
 * Ao estourar, NEGA (fail-closed, como o ACP) e a fila anda.
 */
export const HTTP_MCP_CONFIRMATION_TIMEOUT_MS = 10 * 60_000;

const CONFIRMATION_EXPIRED = Symbol("confirmation-expired");

/**
 * F-1200: a confirmação nasce de uma tool call de agente, muitas vezes com o
 * operador longe. Sem janela-mãe o macOS a mostrava como NSAlert runModal e
 * prendia a main thread (todo o MCP, PTYs e missões) até o clique. Agora é sheet
 * numa janela viva; sem janela nenhuma, nega na hora.
 */
export async function showHttpMcpConfirmation(
  request: McpConfirmationRequest,
): Promise<boolean> {
  const timeoutMs = HTTP_MCP_CONFIRMATION_TIMEOUT_MS;
  // O prazo nasce antes do sheet: com o mesmo timeoutMs este timer dispara
  // primeiro, então a expiração sai como expiração (não como "Negar") e libera
  // a fila mesmo se o sheet não fechar com o abort.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<typeof CONFIRMATION_EXPIRED>((resolve) => {
    timer = setTimeout(() => resolve(CONFIRMATION_EXPIRED), timeoutMs);
  });
  const dialog = showMessageBoxWithoutBlocking({
    type: "warning",
    title: "Nexus IDE — autorização do agente",
    buttons: ["Negar", "Permitir"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    message: "Permitir ação solicitada pelo agente?",
    detail:
      `Agente: ${request.agentLabel}\n` +
      `Ferramenta: ${request.toolName}\n` +
      `Workspace: ${request.workspaceId}\n` +
      `Missão: ${request.missionId ?? "bootstrap"}\n` +
      `Contexto: ${request.contextRevision ?? "bootstrap"}\n` +
      `Motivo: ${boundedConfirmationLine(request.reason)}\n\n` +
      `Argumentos (segredos ocultos):\n${boundedConfirmationArgs(request.args)}`,
  }, { timeoutMs });
  try {
    const result = await Promise.race([expiry, dialog]);
    if (result === CONFIRMATION_EXPIRED) {
      throw new McpConfirmationExpiredError(
        `confirmação expirou: o operador não respondeu em ` +
          `${timeoutMs / 60_000} min; nada foi executado. ` +
          `Peça de novo quando ele voltar.`,
      );
    }
    return result?.response === 1;
  } finally {
    clearTimeout(timer);
  }
}

let httpConfirmationScheduler = new McpConfirmationScheduler(
  showHttpMcpConfirmation,
);

const confirmHttpMcpTool: McpConfirmationHandler = (request) =>
  httpConfirmationScheduler.enqueue(request);

function mcpUrl(): string {
  return `http://127.0.0.1:${port}/mcp`;
}

function isSymbolicLinkPath(target: string): boolean {
  try {
    return fs.lstatSync(target).isSymbolicLink();
  } catch {
    return false;
  }
}

function gateUrl(): string {
  return `http://127.0.0.1:${port}/gate`;
}

/**
 * Hub MCP compartilhado (07645): base URL onde os stdio do perfil nativo
 * (~/.claude.json) são servidos UMA vez para todos os panes da mão do
 * operador. Único processo por servidor no main — não um por pane.
 */
function mcpHubUrl(): string {
  return `http://127.0.0.1:${port}/hub`;
}

/**
 * `undefined` degrada hooks-gen.ts para o comportamento atual (copiar stdio
 * verbatim): flag desligada, ou perfil nativo sem servidor stdio bridgeável,
 * ou erro ao ler `~/.claude.json` (nunca deve travar um spawn).
 */
function computeMcpHubBridge(): { baseUrl: string; keys: readonly string[] } | undefined {
  // Flag real do catálogo (painel Labs / overrides) E o kill switch por env
  // do bridge: qualquer um desligado ⇒ herança por pane, como antes.
  if (!isMcpSharedHubEnabled()) return undefined;
  if (!getFeatureFlagRegistry().isEnabled(FEATURE_FLAG_IDS.mcpSharedHub)) return undefined;
  try {
    const keys = resolveMcpHubBridgeKeys();
    return keys.length > 0 ? { baseUrl: mcpHubUrl(), keys } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Semantic agent-status ingest (emdash wave 1): same loopback server, same
 * per-pane bearer as /gate/* — hook commands reference this via $NEXUS_HOOK_URL.
 */
function hookStatusUrl(): string {
  return `http://127.0.0.1:${port}/hook/status`;
}

/** PostToolUseFailure Bash-triage ingest — same loopback server/bearer. */
function hookTriageUrl(): string {
  return `http://127.0.0.1:${port}/hook/triage`;
}

/** UserPromptSubmit delegation advice — same loopback server/bearer. */
function hookDelegateUrl(): string {
  return `http://127.0.0.1:${port}/hook/delegate`;
}

/** Stop regression gate — same loopback server/bearer. */
function hookRegressionUrl(): string {
  return `http://127.0.0.1:${port}/hook/regression`;
}

/** PreToolUse/Bash integration gate — same loopback server/bearer. */
function hookIntegrationUrl(): string {
  return `http://127.0.0.1:${port}/hook/integration`;
}

/** PermissionRequest structured approval (PRV-02) — same loopback server/bearer. */
function hookPermissionUrl(): string {
  return `http://127.0.0.1:${port}/hook/permission`;
}

const SHA256_HEX = /^[a-f0-9]{64}$/u;

/**
 * Claude's folder-trust gate is redundant only after Main has already approved
 * and sealed the exact mission/workspace. This predicate deliberately rejects
 * direct panes, legacy immediate squads, incomplete seals and cwd drift.
 *
 * The upstream spawn boundary has already compared the seal with the current
 * mission stores. We repeat its structural invariants here before projecting a
 * single cwd into the disposable HOME; no trust ever reaches ~/.claude.json.
 */
/**
 * Um preparador por processo. O adaptador de sistema não tem estado — o que
 * importa é existir UM, para que ligar o dispatch seja impossível de esquecer.
 */
const destructiveReversibilityPreparer = createDestructiveReversibilityPreparer(
  createSystemReversibilityIo(),
);

/**
 * O cwd do pane está dentro do workspace aberto no Nexus (mesma prova de
 * escopo das missões: o cwd resolvido pela autoridade do Main é o próprio
 * cwd). É a regra "workspace aberto = pasta confiada" para qualquer pane da
 * família Claude.
 */
export function isCwdInsideOpenedWorkspace(
  authority: Readonly<BoundSpawnAuthority>,
): boolean {
  if (!authority.cwd) return false;
  try {
    return resolveCwdForScope(authority.scope, authority.cwd) === authority.cwd;
  } catch {
    return false;
  }
}

export function hasApprovedMissionProjectTrust(
  authority: Readonly<BoundSpawnAuthority>,
): boolean {
  const meta = authority.context;
  const seal = meta?.authoritySeal;
  if (
    (authority.source !== "pending" &&
      authority.source !== "persisted-pane") ||
    !meta?.missionId?.trim() ||
    (meta.role !== "orchestrator" && meta.role !== "worker") ||
    !seal ||
    meta.contextRevision !== seal.contextRevision ||
    !Number.isInteger(seal.intentVersion) ||
    seal.intentVersion <= 0 ||
    !SHA256_HEX.test(seal.intentContractHash) ||
    !SHA256_HEX.test(seal.contextRevision) ||
    !SHA256_HEX.test(seal.contractHash) ||
    !SHA256_HEX.test(seal.squadRevisionHash)
  ) {
    return false;
  }
  try {
    return resolveCwdForScope(authority.scope, authority.cwd) === authority.cwd;
  } catch {
    return false;
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(
  res: http.ServerResponse,
  status: number,
  payload: unknown,
  headers: Record<string, string> = {},
): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

function bearerContext(req: http.IncomingMessage): AgentGateContext | null {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return null;
  return getContext(header.slice("Bearer ".length).trim());
}

async function handleMcpRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: AgentGateContext,
): Promise<void> {
  if (req.method === "GET") {
    // We do not push server-initiated messages; clients poll via POST.
    sendJson(res, 405, { error: "SSE stream not supported" });
    return;
  }
  if (req.method === "DELETE") {
    sendJson(res, 200, { ok: true });
    return;
  }
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "method not allowed" });
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readBody(req));
  } catch {
    sendJson(res, 400, {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "parse error" },
    });
    return;
  }

  const messages = Array.isArray(parsed) ? parsed : [parsed];
  const responses: JsonRpcResponse[] = [];
  const staleHandoffResults = new Map<string, ToolDispatchResult>();
  let authorityRevoked = false;
  await runInsideHttpMcpTransport(req, ctx, async () => {
    for (const message of messages) {
      if (!isJsonRpcRequest(message)) continue;
      if (!isCurrentGateContext(ctx)) {
        authorityRevoked = true;
        sendJson(res, 401, { error: "session authority was revoked" });
        return;
      }
      const response = await handleMcpMessage(registry!, ctx, message, {
        confirm: confirmHttpMcpTool,
        prepareDestructiveReversibility: destructiveReversibilityPreparer,
        source:
          req.headers['x-nexus-transport'] === 'acp-stdio'
            ? 'acp-stdio'
            : 'http-mcp',
        onToolResult: (result) => {
          if (
            ctx.sessionId &&
            isStaleReadOnlyObservationHandoffResult(result)
          ) {
            staleHandoffResults.set(ctx.sessionId, result);
          }
        },
      });
      if (response) responses.push(response);
    }
  });
  if (authorityRevoked) return;
  const headers = { "mcp-session-id": ctx.token.slice(0, 16) };
  const recoverStaleHandoffs = (): void => {
    for (const [sessionId, result] of staleHandoffResults) {
      void terminateStaleReadOnlyMcpSession(sessionId, result)
        .then((terminated) => {
          if (terminated) {
            console.warn(
              `[handoff] stale read-only MCP session terminated for recovery (${sessionId})`,
            );
          }
        })
        .catch((error) => {
          console.warn(
            `[handoff] stale read-only MCP recovery failed (${sessionId}):`,
            error,
          );
        });
    }
  };
  if (responses.length === 0) {
    res.writeHead(202, headers);
    res.end();
    recoverStaleHandoffs();
    return;
  }
  sendJson(res, 200, Array.isArray(parsed) ? responses : responses[0], headers);
  recoverStaleHandoffs();
}

/**
 * Hub MCP compartilhado (07645): `/hub/<key>` proxies one JSON-RPC message to
 * the ONE spawned process for that native stdio server. Security §3 of the
 * brief: only the role that would have inherited these servers directly (the
 * operator's own pane) may reach it — a worker must never see or reach the
 * user's global MCP roster.
 */
async function handleMcpHubRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: AgentGateContext,
  rawKey: string,
): Promise<void> {
  if (req.method === "GET") {
    sendJson(res, 405, { error: "SSE stream not supported" });
    return;
  }
  if (req.method === "DELETE") {
    sendJson(res, 200, { ok: true });
    return;
  }
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "method not allowed" });
    return;
  }
  if (ctx.role !== "user" || !isCurrentGateContext(ctx)) {
    sendJson(res, 403, { error: "forbidden" });
    return;
  }
  let key: string;
  try {
    key = decodeURIComponent(rawKey);
  } catch {
    sendJson(res, 400, { error: "malformed hub key" });
    return;
  }
  const descriptor = resolveNativeStdioServerDescriptor(key);
  if (!descriptor) {
    sendJson(res, 404, { error: "unknown hub server" });
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readBody(req));
  } catch {
    sendJson(res, 400, {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "parse error" },
    });
    return;
  }
  if (!isJsonRpcRequest(parsed)) {
    sendJson(res, 400, {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: "invalid request" },
    });
    return;
  }
  const response = await (mcpStdioHub ??= new McpStdioBridge()).handle(descriptor, parsed);
  if (!response) {
    res.writeHead(204);
    res.end();
    return;
  }
  sendJson(res, 200, response);
}

async function handleGateRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: AgentGateContext,
  event: string,
): Promise<void> {
  // The body (tool name/input) no longer decides anything; drain it.
  await readBody(req).catch(() => "");
  if (!isCurrentGateContext(ctx)) {
    sendJson(res, 401, { error: "session authority was revoked" });
    return;
  }
  switch (event) {
    // F-1154/F-1157: o hook só pergunta se o Main da sessão responde (o
    // spool do handoff depende disso); nenhuma tool é negada aqui.
    case "pretool":
    case "posttool":
      sendJson(res, 200, { allow: true });
      return;
    // No generated hook calls /gate/stop since F-1154; kept for panes spawned
    // by an earlier build whose nexus-gate.mjs still reports Stop (they die
    // with the app). Remove after the 0.77 line.
    case "stop": {
      let hasTrustedHandoff = false;
      try {
        hasTrustedHandoff = Boolean(
          ctx.sessionId &&
          getProjectDomainStores(ctx.scope).handoffs.hasTrustedFromSession(
            ctx.sessionId,
            ctx.workerIncarnationId,
          ),
        );
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        sendJson(res, 200, {
          allow: false,
          reason: `trusted handoff could not be revalidated: ${detail}`,
        });
        return;
      }
      const verdict = evaluateStop(ctx, hasTrustedHandoff);
      sendJson(res, 200, verdict);
      return;
    }
    default:
      sendJson(res, 404, { error: "unknown gate event" });
  }
}

/**
 * Config MCP por sessão da família Claude. Os servidores que o operador
 * declarou no hub (`.nexus/mcp-hub.json`) entram AQUI, no mesmo arquivo 0600 —
 * é o que torna `--strict-mcp-config` compatível com "levar as configs de um
 * pane para outro". `nexus` é escrito por último e nunca pode ser sobrescrito.
 */
function buildMcpConfig(
  token: string,
  hubServers: readonly McpHubSpawnServer[] = [],
): object {
  return {
    mcpServers: {
      ...claudeFamilyHubMcpServers(hubServers),
      nexus: {
        type: "http",
        url: mcpUrl(),
        headers: { Authorization: `Bearer ${token}` },
      },
    },
  };
}

/**
 * Resolve an internal reviewer marker from active main-owned state plus the
 * exact physical pane profile. No prompt string or renderer claim is trusted.
 */
export function resolveInternalPrevcReviewerAuthorityForSpawn(
  adapterId: string,
  authority: BoundSpawnAuthority,
): InternalPrevcReviewerAuthority | undefined {
  const meta = authority.context;
  const missionId = meta?.missionId?.trim();
  const agentName = meta?.agentName?.trim();
  if (
    !meta ||
    !missionId ||
    !agentName ||
    meta.role !== "worker" ||
    meta.readOnly !== true
  ) {
    return undefined;
  }
  const coordinationScope = authority.coordinationScope ?? authority.scope;
  const profile = {
    role: meta.role,
    missionId,
    agentName,
    providerId: adapterId,
    readOnly: meta.readOnly,
    allowedTools: meta.allowedTools,
    allowedSkills: meta.allowedSkills,
  } as const;

  if (
    isExactInternalPrevcReviewerProfile({
      ...profile,
      authority: {
        kind: "context-draft",
        // Exact id is resolved below before authority is minted.
        draftId: "pending",
      },
    })
  ) {
    try {
      const workflow = getContextWorkflowService(
        coordinationScope,
      ).getMissionWorkflow(missionId);
      if (workflow.contract || workflow.workflow) return undefined;
      const draftId = findActiveContextDraftReviewerId({
        scope: coordinationScope,
        missionId,
        providerId: adapterId,
        agentName,
      });
      if (draftId) {
        return Object.freeze({ kind: "context-draft", draftId });
      }
    } catch {
      // Missing/corrupt knowledge state cannot mint reviewer authority.
    }
  }

  if (
    !isExactInternalPrevcReviewerProfile({
      ...profile,
      authority: {
        kind: "automated-review",
        // Shape-only precheck; the active opaque binding is resolved below.
        reviewSessionId: "00000000-0000-0000-0000-000000000000",
        issuedFor: "pre-execution",
      },
    })
  ) {
    return undefined;
  }
  try {
    const stored = getContextWorkflowService(
      coordinationScope,
    ).getMissionWorkflow(missionId);
    const workflow = stored.workflow;
    const contract = stored.contract?.contract;
    if (!contract || !workflow) return undefined;
    const executionIndex = workflow?.route.indexOf("execution") ?? -1;
    const currentIndex =
      workflow.stage !== "complete"
        ? workflow.route.indexOf(workflow.stage)
        : -1;
    const preExecutionReview =
      (contract.risk === "high" || contract.risk === "critical") &&
      (workflow.stage === "review-primary" ||
        workflow.stage === "review-secondary") &&
      executionIndex >= 0 &&
      currentIndex >= 0 &&
      currentIndex < executionIndex;
    const postExecutionReview =
      executionIndex >= 0 &&
      currentIndex >= executionIndex &&
      workflow.stage !== "complete";
    const issuedFor = preExecutionReview
      ? "pre-execution"
      : postExecutionReview
        ? "post-execution"
        : null;
    if (!issuedFor) return undefined;
    const includeDesign =
      contract.requiredSensors.includes("design-system");
    if (
      !sameExactProfileList(
        meta.allowedTools,
        automatedReviewTools(includeDesign),
      ) ||
      !sameExactProfileList(
        meta.allowedSkills,
        automatedReviewSkills(includeDesign),
      )
    ) {
      return undefined;
    }
    const reviewSessionId =
      automatedReviewSessions.findActiveReviewerSessionId({
        missionId,
        checkoutPath: authority.scope.rootRealPath,
        providerId: adapterId,
        agentName,
      });
    if (reviewSessionId) {
      return Object.freeze({
        kind: "automated-review",
        reviewSessionId,
        issuedFor,
      });
    }
  } catch {
    // Missing/corrupt workflow state or an expired session fails closed.
  }
  return undefined;
}

function missionAttachmentReadPathsForSpawn(
  authority: Parameters<AgentSpawnHook>[2],
  hasPetStudioAuthority: boolean,
): readonly string[] | undefined {
  const missionId = authority.context?.missionId;
  if (!missionId) return undefined;
  let mission: Mission | null;
  try {
    mission = getProjectDomainStores(authority.coordinationScope ?? authority.scope).missions.get(missionId);
  } catch {
    // Legacy Pet authority has no sealed external artifact to grant. A new
    // governed mission always has the strict snapshot below and reaches this
    // hook through the configured project-domain registry.
    return undefined;
  }
  const attachments = mission?.intentContract?.attachmentSnapshots ?? [];
  if (!mission) return undefined;
  if (attachments.length === 0) return undefined;
  if (
    attachments.some(
      (attachment) =>
        attachment.sourcePath === undefined ||
        attachment.sealId === undefined ||
        attachment.device === undefined ||
        attachment.inode === undefined,
    )
  ) {
    return undefined;
  }
  if (
    (hasPetStudioAuthority && mission.squadId !== PET_STUDIO_SQUAD_ID) ||
    !hasCurrentApprovedDispatchContract(mission)
  ) {
    throw new Error("mission attachment authority is not current");
  }
  assertMissionSpawnAuthorityCurrent({
    missionId,
    scope: authority.coordinationScope ?? authority.scope,
    contextRevision: authority.context?.contextRevision,
    authoritySeal: authority.context?.authoritySeal,
  });
  const snapshots = revalidateSealedAttachmentSnapshots(attachments, {
    workspaceRootAuthority: workspaceRootAuthorityFromScope(authority.coordinationScope ?? authority.scope),
    checkoutId: authority.scope.checkoutId,
  });
  if (
    snapshots.length !== attachments.length ||
    mission.intentContract?.attachmentPaths?.length !== snapshots.length ||
    snapshots.some(
      (snapshot, index) =>
        mission.intentContract?.attachmentPaths?.[index] !== snapshot.path,
    )
  ) {
    throw new Error("sealed attachment grant is invalid");
  }
  return Object.freeze(snapshots.map((snapshot) => snapshot.path));
}

/**
 * Names already declared in the Codex home this pane will preserve.
 * Missing/unreadable config degrades to "none" — hub `-c` then injects
 * the full list, same as a worker overlay that stripped ambient MCP.
 */
function existingCodexMcpServerKeys(
  providerHome: string | undefined,
): string[] {
  const home =
    typeof providerHome === "string" && providerHome.trim().length > 0
      ? providerHome
      : path.join(os.homedir(), ".codex");
  try {
    const parsed = readTomlObject(path.join(home, "config.toml"));
    const block = parsed.mcp_servers;
    if (!block || typeof block !== "object" || Array.isArray(block)) return [];
    return Object.keys(block);
  } catch {
    return [];
  }
}

/**
 * Build the main-owned spawn boundary for one agent. Exported so integration
 * tests can prove the real wiring, rather than exercising overlay helpers in
 * isolation.
 */
export const prepareAgentSpawnDecoration: AgentSpawnHook = (
  adapter,
  _req,
  authority,
  preparedEnv,
  transportEnv,
) => {
    const meta = authority.context;
    const gated = requiresSpawnGate(meta);
    // Filho ad-hoc do operador sem missão: o token nasce `user` (o role é
    // omitido no spawn para o Main mintar user) mas o vínculo
    // `operatorParentSessionId` o distingue da própria mão do operador.
    const operatorChild =
      (meta?.role ?? "user") === "user" &&
      typeof meta?.operatorParentSessionId === "string" &&
      !meta?.missionId;
    const internalPrevcReviewerAuthority =
      resolveInternalPrevcReviewerAuthorityForSpawn(adapter.id, authority);
    const governedNativeProvider =
      adapter.id === "codex" &&
      meta?.role === "worker" &&
      Boolean(meta.missionId?.trim()) &&
      meta.readOnly !== true &&
      !isOperatorChoicePolicy(getOrchSettings().squadCliPolicy)
        ? "codex"
        : undefined;
    const petStudioMediaAuthority = isPetStudioNativeWorkspaceAuthority({
      source: authority.source,
      adapterId: adapter.id,
      role: meta?.role,
      missionId: meta?.missionId,
      squadId: meta?.squadId,
      agentName: meta?.agentName,
      allowedTools: meta?.allowedTools,
      allowedSkills: meta?.allowedSkills,
      contextRevision: meta?.contextRevision,
      authoritySeal: meta?.authoritySeal,
      readOnly: meta?.readOnly,
      nativeReadOnly: meta?.nativeReadOnly,
    })
      ? true
      : undefined;
    const petStudioAuthoritySource =
      petStudioMediaAuthority &&
      (authority.source === "legacy-squad" ||
        authority.source === "persisted-pane")
        ? authority.source
        : undefined;
    const approveBoundCodexTools =
      adapter.id === "codex" &&
      (petStudioMediaAuthority === true ||
        ((authority.source === "pending" ||
          authority.source === "persisted-pane") &&
          Boolean(meta?.missionId?.trim()) &&
          (meta?.role === "orchestrator" || meta?.role === "worker")));
    const ctx = mintToken({
      label: meta?.agentName ?? adapter.label,
      role: meta?.role ?? "user",
      missionId: meta?.missionId,
      workerIncarnationId: meta?.workerIncarnationId,
      contextRevision: meta?.contextRevision,
      agentName: meta?.agentName,
      providerId: adapter.id,
      governedNativeProvider,
      petStudioMediaAuthority,
      petStudioAuthoritySource,
      petStudioSquadId: petStudioMediaAuthority
        ? meta?.squadId
        : undefined,
      internalPrevcReviewerAuthority,
      internalPrevcReviewerAuthoritySource:
        internalPrevcReviewerAuthority !== undefined
          ? "verified-active-profile"
          : undefined,
      readOnly: meta?.readOnly === true,
      visualTask: meta?.visualTask,
      allowedTools: meta?.allowedTools ?? null,
      allowedSkills: meta?.allowedSkills ?? null,
      scope: authority.coordinationScope ?? authority.scope,
      executionScope: authority.scope,
      ...(isSharedPaneSpaceWorktree(authority.coordinationScope ?? authority.scope, authority.scope)
        ? { sharedTabWorktree: true as const } : {}),
      // Jev dispatch guard (modo operator-child): o brief do spawn é o
      // objetivo contra o qual as tool calls do helper são julgadas —
      // só injeção, nunca modal. Não é persistido nem devolvido a callers.
      operatorBrief:
        operatorChild &&
        typeof meta?.initialPrompt === "string" &&
        meta.initialPrompt.trim()
          ? meta.initialPrompt.trim().slice(0, 1_500)
          : undefined,
      // Handoff sem missão acha o pai mesmo com a janela noutro workspace.
      operatorParentSessionId: operatorChild ? meta?.operatorParentSessionId : undefined,
      // Writer isolado da mão do operador: mesma guarda de git do worker.
      ...(operatorChild && meta?.isolatedWriter === true ? { isolatedWriter: true as const } : {}),
    });
    const env: Record<string, string> = canUseNexusMcp(adapter)
      ? {
          NEXUS_MCP_URL: mcpUrl(),
          NEXUS_MCP_TOKEN: ctx.token,
          NEXUS_GATE_URL: gateUrl(),
          NEXUS_GATE_TOKEN: ctx.token,
          // Status hooks inherit this from the PTY env (never written to disk).
          NEXUS_HOOK_URL: hookStatusUrl(),
          // PostToolUseFailure Bash triage hook — same transport contract.
          NEXUS_HOOK_TRIAGE_URL: hookTriageUrl(),
          // UserPromptSubmit delegation advice hook — same transport contract.
          NEXUS_HOOK_DELEGATE_URL: hookDelegateUrl(),
          // Stop regression gate hook — same transport contract.
          NEXUS_HOOK_REGRESSION_URL: hookRegressionUrl(),
          // PreToolUse/Bash integration review gate — same transport contract.
          NEXUS_HOOK_INTEGRATION_URL: hookIntegrationUrl(),
          // PermissionRequest → broker de aprovação (card do desktop/celular).
          NEXUS_HOOK_PERMISSION_URL: hookPermissionUrl(),
        }
      : {};
    {
      // Every CLI agent has a Main-minted session token, including the operator hand and loose helpers.
      Object.assign(env, heavyCommandShellEnvironment(preparedEnv ?? process.env, heavyCommandPreloadPath(), ctx.token));
      env.NEXUS_GATE_TOKEN = ctx.token;
      env.NEXUS_HEAVY_COMMAND_URL = `http://127.0.0.1:${port}/hook/heavy-command`;
      env.NODE_OPTIONS = appendHeavyCommandPreload(preparedEnv?.NODE_OPTIONS ?? process.env.NODE_OPTIONS, heavyCommandPreloadPath());
    }
    const extraArgs: string[] = [];
    const envRemove: string[] = [];
    envRemove.push('NEXUS_HEAVY_LEASE', 'NEXUS_HEAVY_HELPER');
    let ephemeralHomeDir: string | null = null;
    let skillsPrepared = false;
    // Real provider home (~/.kimi-code, ~/.grok) the governed overlay symlinks
    // session/auth state into. The advisory sandbox grants it read+write.
    let advisoryProviderStateHome: string | undefined;
    let advisoryProviderSessionHome: string | undefined;
    let mimoNativeOwnerKey: string | undefined;
    // F-569: exact auth paths a governed Grok/Kimi session may read/write —
    // never the whole provider home. Additive to providerStateHome.
    let advisoryProviderStateReadPaths: readonly string[] = [];
    let advisoryProviderStateWritePaths: readonly string[] = [];
    const claudeStatePaths: string[] = [];
    const claudeProfileReadPaths: string[] = [];
    // Servidores MCP que o operador declarou explicitamente no hub do
    // workspace. Única leitura de hub no spawn; nunca lê o config ambiente de
    // outra ferramenta e nunca falha o spawn (hub quebrado ⇒ lista vazia).
    // Helper aberto por agente sem missão só leva os que o allowlist pede.
    const hubServers = selectHubServersForSpawn(
      loadMcpHubServersForSpawn((authority.coordinationScope ?? authority.scope).rootRealPath),
      {
        operatorChild,
        allowedTools: meta?.allowedTools ?? null,
        role: meta?.role,
      },
    );
    // F-1157: every role keeps its native helper tools (Task); only the
    // operator's explicit Hardened mode cuts them, without changing the adapter.
    extraArgs.push(...nativeSubagentPolicyArgs(adapter, {
      squadCliPolicy: getOrchSettings().squadCliPolicy,
    }));
    const mcpConfig = buildMcpConfig(ctx.token, hubServers);
    const thirdPartyClaudeFamily = isThirdPartyClaudeFamily(
      adapter,
      preparedEnv,
    );
    const managedClaudeAuthDir = adapter.id === "claude" && !thirdPartyClaudeFamily && preparedEnv?.[CLAUDE_MANAGED_AUTH_ENV]
      ? validateManagedClaudeAuthDirectory(preparedEnv[CLAUDE_MANAGED_AUTH_ENV])
      : undefined;
    if (managedClaudeAuthDir) {
      env[CLAUDE_MANAGED_AUTH_ENV] = managedClaudeAuthDir;
      envRemove.push("CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_REFRESH_TOKEN", "CLAUDE_CODE_OAUTH_SCOPES");
      claudeStatePaths.push(managedClaudeAuthDir);
    } else {
      envRemove.push(CLAUDE_MANAGED_AUTH_ENV);
    }
    const homeMode =
      adapter.quirks.mcpAutoload &&
      isOperatorChoicePolicy(getOrchSettings().squadCliPolicy) &&
      petStudioMediaAuthority !== true
        ? "operator-choice"
        : "hardened";

    const gateHome = shouldUseEphemeralHome(adapter, gated, {
      mode: homeMode,
      effectiveEnv: preparedEnv,
    });
    // F-646: fora do macOS o segredo do login nativo é o arquivo
    // ~/.claude/.credentials.json, e a CLI o regrava por temporário + rename.
    // Um link no overlay virava arquivo próprio na primeira renovação do pane,
    // o perfil real ficava com o refresh token já consumido (o Claude de fora
    // caía) e o sync-back do fechamento podia devolver um token velho. O
    // secure storage da CLI aponta para o ~/.claude real e o overlay não
    // recebe cópia: o store nativo tem um dono só. Gated e terceiros
    // autenticam por env e ficam fora.
    const nativeSecureStorageInPlace =
      process.platform !== "darwin" &&
      adapter.id === "claude" &&
      !managedClaudeAuthDir &&
      !thirdPartyClaudeFamily &&
      !gateHome;
    try {
      if (usesClaudeHomeLayout(adapter)) {
        // Só o Claude NATIVO carrega a identidade OAuth da assinatura para o
        // overlay; GLM/LongCat (base URL de terceiro) jamais podem recebê-la.
        const approvedMissionProjectTrust =
          hasApprovedMissionProjectTrust(authority);
        // F-572: só a mão do operador (role user) herda o perfil MCP global
        // (~19 servidores, ~600 MB por pane no incidente de 16/09). Worker e
        // orquestrador nascem só com o MCP do Nexus — como já era em
        // "hardened" — e ganham o resto por allowlist, não por herança.
        const inheritNativeProfile =
          !thirdPartyClaudeFamily &&
          !gateHome &&
          (meta?.role ?? "user") === "user";
        const home = prepareEphemeralHome(ctx.token, mcpConfig, {
          carryNativeClaudeAuth: !thirdPartyClaudeFamily && !managedClaudeAuthDir,
          nativeCredentialsInPlace: nativeSecureStorageInPlace,
          managedClaudeAuthDir,
          adapterId: adapter.id,
          userDataPath: app.getPath("userData"),
          checkoutId: authority.scope.checkoutId,
          coordinationScope: authority.coordinationScope ?? authority.scope,
          effectiveEnv: transportEnv,
          inheritNativeProfile,
          // Hub MCP compartilhado (07645): só computado quando o pane
          // herdaria mesmo — nunca calculado nem exposto a worker/orquestrador.
          mcpHubBridge: inheritNativeProfile ? computeMcpHubBridge() : undefined,
          gateHooks: gateHome,
          cwd: authority.cwd,
          approvedMissionProjectTrust,
          workspaceProjectTrust: isCwdInsideOpenedWorkspace(authority),
          // F-579: lanes commit and push as the operator. F-1157: outside
          // the operator's explicit Hardened mode no lane is read-only, so
          // every one carries the identity; a Hardened read-only lane (never
          // commits, may be Seatbelt-confined) still gets nothing.
          carryDeveloperIdentity:
            meta?.readOnly !== true ||
            isOperatorChoicePolicy(getOrchSettings().squadCliPolicy),
          // Operator-choice/direct lane (no gate hooks): the pane is the
          // operator's own HOME minus Claude conversation state. Hardened
          // gated panes keep the minimal surface and receive only the
          // identity entries above.
          carryNativeHome:
            (meta?.readOnly !== true ||
              isOperatorChoicePolicy(getOrchSettings().squadCliPolicy)) &&
            !gateHome,
        });
        if (approvedMissionProjectTrust) {
          const stagedProfile = JSON.parse(
            fs.readFileSync(path.join(home.dir, ".claude.json"), "utf8"),
          ) as {
            projects?: Record<
              string,
              {
                hasTrustDialogAccepted?: unknown;
                hasCompletedProjectOnboarding?: unknown;
              }
            >;
          };
          const exactTrust = stagedProfile.projects?.[authority.cwd];
          if (
            exactTrust?.hasTrustDialogAccepted !== true ||
            exactTrust.hasCompletedProjectOnboarding !== true
          ) {
            throw new Error(
              "failed to stage exact Claude-family project trust for the sealed mission",
            );
          }
        }
        env.HOME = home.dir;
        if (process.platform === "win32") env.USERPROFILE = home.dir;
        // F-629: no macOS o spawn liga o keychain real em todo HOME privado
        // (senão gh/git/CLIs abrem o modal "Chaves Não Encontradas"). Terceiros
        // (GLM/LongCat) e panes gated autenticam por env e NUNCA podem ler ou
        // sobrescrever o item "Claude Code-credentials" nativo: um diretório de
        // securestorage privado do overlay escopa o serviço do CLI
        // (`Claude Code-credentials-<sha256(dir)[:8]>`, binário 2.1.280).
        if (
          process.platform === "darwin" &&
          !managedClaudeAuthDir &&
          (thirdPartyClaudeFamily || gateHome)
        ) {
          const scopedSecureStorage = path.join(home.dir, ".nexus-claude-securestorage");
          fs.mkdirSync(scopedSecureStorage, { recursive: true, mode: 0o700 });
          env[CLAUDE_MANAGED_AUTH_ENV] = scopedSecureStorage;
          const removeAt = envRemove.indexOf(CLAUDE_MANAGED_AUTH_ENV);
          if (removeAt >= 0) envRemove.splice(removeAt, 1);
        }
        if (nativeSecureStorageInPlace) {
          env[CLAUDE_MANAGED_AUTH_ENV] = path.join(os.homedir(), ".claude");
          const removeAt = envRemove.indexOf(CLAUDE_MANAGED_AUTH_ENV);
          if (removeAt >= 0) envRemove.splice(removeAt, 1);
        }
        // The default config location follows this private HOME, preserving
        // native Keychain semantics. Do not inherit a custom path to real
        // sessions — and never blank it either: "CLAUDE_CONFIG_DIR=" still
        // lands in the child env block and the binary's `??` config-dir
        // probe accepts "" literally, resolving .credentials.json/projects
        // relative to the pane cwd (F-576: every Windows pane read its
        // credentials from <cwd>/.credentials.json and stayed logged out).
        envRemove.push("CLAUDE_CONFIG_DIR");
        // Package managers resolve their caches from $HOME, so a disposable
        // HOME re-downloaded every npx/uvx MCP server on each pane (~500 MB
        // and minutes of fs churn that froze the Main process). The durable
        // cache root is per adapter — a third-party pane can never poison the
        // cache the native pane toolchain executes from.
        const providerCacheRoot = path.join(
          app.getPath("userData"),
          "provider-cache",
          adapter.id,
        );
        env.XDG_CACHE_HOME = path.join(providerCacheRoot, "xdg");
        env.npm_config_cache = path.join(providerCacheRoot, "npm");
        env.UV_CACHE_DIR = path.join(providerCacheRoot, "uv");
        claudeStatePaths.push(providerCacheRoot);
        ephemeralHomeDir = home.dir;
        if (home.providerSessionHome) claudeStatePaths.push(home.providerSessionHome);
        claudeProfileReadPaths.push(...(home.providerProfileReadPaths ?? []));
        const nativeCredentials = path.join(os.homedir(), ".claude", ".credentials.json");
        if (!thirdPartyClaudeFamily && !managedClaudeAuthDir && fs.existsSync(nativeCredentials)) {
          claudeStatePaths.push(nativeCredentials);
        }
        if (gateHome) {
          env.CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL = "1";
          env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
        }
        if (thirdPartyClaudeFamily) {
          env.CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT = "1";
        }
        extraArgs.push("--mcp-config", home.mcpConfigPath);
        // F-572: um helper aberto pelo operador NÃO pode herdar o perfil MCP
        // global dele (~19 servidores, ~600 MB por pane, incidente 16/09).
        // Os servidores do hub declarados em `.nexus/mcp-hub.json` seguem
        // viajando no `--mcp-config`.
        if (gateHome || gated || operatorChild)
          extraArgs.push("--strict-mcp-config");
        if (!gateHome) {
          extraArgs.push(
            "--settings",
            writeClaudeFamilyZeroClickSettings(ctx.token),
          );
        }
      } else if (
        adapter.quirks.mcpAutoload &&
        acceptsClaudeMcpCliFlags(adapter)
      ) {
        // Real HOME: ensure native Claude also trusts the active workspace
        ensureNativeClaudeProjectTrust(os.homedir(), authority.cwd);
        // still force zero-click via flag settings (system default).
        extraArgs.push(
          "--mcp-config",
          writeMcpConfigFile(ctx.token, mcpConfig),
          "--settings",
          writeClaudeFamilyZeroClickSettings(ctx.token),
        );
        if (gated) {
          // A mission-owned pane must not inherit the operator's unrelated
          // MCP connectors from the native HOME. Those connectors can require
          // their own OAuth/bootstrap round trips and leave Claude with a
          // pasted prompt that never reaches the model. The per-session Nexus
          // config above is the complete MCP surface for governed agents;
          // direct user panes intentionally keep the native profile behavior.
          extraArgs.push("--strict-mcp-config");
        }
      }
      // CLIs não-Claude: injeta o servidor MCP DE VERDADE (não só env), para
      // que Codex/AGY chamem as tools nexus_* e submetam
      // handoff. Sem isto a orquestração era efetivamente Claude-cêntrica.
      if (!adapter.quirks.mcpAutoload) {
        const flavor = supportsMcpInjection(adapter);
        if (flavor) {
          // Governed preparers materialize only the bearer-authorized skills
          // inside their private provider homes. Never seed the real profile
          // before taking that overlay; direct panes retain the historical,
          // full-profile mirror.
          if (!gated) {
            ensureSkillsForCli(adapter.id, {
              allowedSkills: meta?.allowedSkills ?? null,
              allowedTools: meta?.allowedTools ?? null,
            });
          }
          skillsPrepared = true;
        }
        if (flavor === "codex") {
          extraArgs.push(
            ...codexMcpArgs(mcpUrl(), ctx.token, {
              // This is deliberately server-scoped, never a global Codex
              // approval bypass. Main minted this random, bearer-bound Nexus
              // server from mission/Pet authority; the HTTP boundary still
              // enforces role/tool/intent and its own sensitive-action gates.
              // Codex 0.145 auto-approves AppToolApproval::Approve even while
              // global AskForApproval remains OnRequest, so pre-PREVC workers
              // do not produce a redundant provider modal.
              approveBoundTools: approveBoundCodexTools,
            }),
          );
          // Hub servers via the same `-c` channel. Gated/helper overlays
          // strip ambient `mcp_servers`, so the full hub list is safe.
          // Operator-hand panes keep the user's config (preserveUserMcp):
          // skip names that already exist so a hub HTTP `url` cannot land
          // on a preserved stdio `command` (Codex: "url is not supported
          // for stdio" — pane 2, 2026-09-19).
          extraArgs.push(
            ...codexHubMcpArgs(hubServers, {
              skipKeys:
                !gated && !operatorChild
                  ? existingCodexMcpServerKeys(preparedEnv?.CODEX_HOME)
                  : undefined,
            }),
          );
          // The preparer writes our hooks.json and exact trust in the private
          // profile. Empty event overrides preserve the old inline-hook
          // replacement without extending trust to user/plugin hooks.
          // Without a prepared private profile, retain Codex's review gate.
          extraArgs.push(...(preparedEnv?.CODEX_HOME ? codexPrivateHookArgs() : codexStatusHookArgs()));
        } else if (flavor === "opencode") {
          const prepared = prepareOpenCodeMcpSession(mcpUrl(), ctx.token, {
            userDataPath: app.getPath("userData"),
            checkoutId: authority.scope.checkoutId,
            providerHome: preparedEnv?.XDG_DATA_HOME,
            cwd: authority.cwd,
            workspaceRoot: authority.scope.rootRealPath,
            hubServers,
          });
          Object.assign(env, prepared.env);
          extraArgs.push(...prepared.extraArgs);
          advisoryProviderStateHome = prepared.providerStateHome;
          advisoryProviderSessionHome = prepared.providerSessionHome;
          advisoryProviderStateReadPaths = prepared.providerStateReadPaths ?? [];
          advisoryProviderStateWritePaths = prepared.providerStateWritePaths ?? [];
        } else if (flavor === "mimo-code") {
          const hookEndpoint = getActiveAgentHookHttpServer();
          const prepared = prepareMimoMcpSession(mcpUrl(), ctx.token, {
            userDataPath: app.getPath("userData"),
            checkoutId: authority.scope.checkoutId,
            providerHome: preparedEnv?.MIMOCODE_HOME,
            mimoApiKeySelected: Boolean(preparedEnv?.XIAOMI_API_KEY?.trim()),
            mimoHookEndpoint: hookEndpoint ? { port: hookEndpoint.port, token: hookEndpoint.token } : undefined,
            mimoCustomConfigDir: preparedEnv?.MIMOCODE_CONFIG_DIR ?? process.env.MIMOCODE_CONFIG_DIR,
            cwd: authority.cwd,
            workspaceRoot: authority.scope.rootRealPath,
            hubServers,
          });
          Object.assign(env, prepared.env);
          mimoNativeOwnerKey = prepared.mimoNativeOwnerKey ?? currentMimoSessionOwnerKey(preparedEnv?.XIAOMI_API_KEY) ?? undefined;
          extraArgs.push(...prepared.extraArgs);
          advisoryProviderStateHome = prepared.providerStateHome;
          advisoryProviderSessionHome = prepared.providerSessionHome;
          advisoryProviderStateReadPaths = prepared.providerStateReadPaths ?? [];
          advisoryProviderStateWritePaths = prepared.providerStateWritePaths ?? [];
        } else if (flavor === "minimax-code") {
          // F-678: ponte stdio registrada em ~/.minimax/mcp.json; a sessão
          // chega só por ENV (URL + bearer), nunca por arquivo.
          const prepared = prepareMinimaxMcpSession(mcpUrl(), ctx.token);
          if (!prepared.registered) {
            console.warn("[mcp] MiniMax Code sem MCP do Nexus:", prepared.reason);
          }
          Object.assign(env, prepared.env);
        } else if (flavor === "agy") {
          // F-697: ponte stdio no perfil nativo do AGY (via `agy mcp add`);
          // URL e bearer já estão no env base (canUseNexusMcp).
          const prepared = ensureAgyNexusMcpRegistration();
          if (!prepared.registered) {
            if (gated || meta?.missionId) {
              throw new Error(
                `AGY sem MCP do Nexus: ${prepared.reason ?? "registro falhou"} — sem ele o worker não entrega o handoff`,
              );
            }
            console.warn("[mcp] AGY sem MCP do Nexus:", prepared.reason);
          }
        } else if (flavor === "devin") {
          // F-698: ponte stdio no escopo de usuário do Devin (via
          // `devin mcp add --scope user`); URL e bearer no env base.
          const prepared = ensureDevinNexusMcpRegistration();
          if (!prepared.registered) {
            if (gated || meta?.missionId) {
              throw new Error(
                `Devin sem MCP do Nexus: ${prepared.reason ?? "registro falhou"} — sem ele o worker não entrega o handoff`,
              );
            }
            console.warn("[mcp] Devin sem MCP do Nexus:", prepared.reason);
          }
        } else if (flavor === "muse") {
          // F-696: Muse Code 1.4+ lê mcpServers do settings.json; mesma ponte
          // stdio do MiniMax, sessão só por ENV (URL + bearer).
          const prepared = prepareMuseMcpSession(mcpUrl(), ctx.token);
          if (!prepared.registered) {
            console.warn("[mcp] Muse Code sem MCP do Nexus:", prepared.reason);
          }
          Object.assign(env, prepared.env);
        } else if (flavor === "kimi") {
          const prepared = prepareKimiMcpSession(mcpUrl(), ctx.token, {
            userDataPath: app.getPath("userData"),
            checkoutId: authority.scope.checkoutId,
            providerHome: preparedEnv?.KIMI_CODE_HOME,
            cwd: authority.cwd,
            hubServers,
          });
          Object.assign(env, prepared.env);
          extraArgs.push(...prepared.extraArgs);
          advisoryProviderStateHome = prepared.providerStateHome;
          advisoryProviderSessionHome = prepared.providerSessionHome;
          advisoryProviderStateReadPaths = prepared.providerStateReadPaths ?? [];
          advisoryProviderStateWritePaths = prepared.providerStateWritePaths ?? [];
        } else if (flavor === "grok") {
          const prepared = prepareGrokMcpSession(mcpUrl(), ctx.token, {
            userDataPath: app.getPath("userData"),
            checkoutId: authority.scope.checkoutId,
            providerHome: preparedEnv?.GROK_HOME,
            cwd: authority.cwd,
            workspaceRoot: authority.scope.rootRealPath,
            hubServers,
          });
          Object.assign(env, prepared.env);
          extraArgs.push(...prepared.extraArgs);
          advisoryProviderStateHome = prepared.providerStateHome;
          advisoryProviderSessionHome = prepared.providerSessionHome;
          advisoryProviderStateReadPaths = prepared.providerStateReadPaths ?? [];
          advisoryProviderStateWritePaths = prepared.providerStateWritePaths ?? [];
        } else if (flavor === "qwen") {
          // F-238: QWEN_HOME aponta um overlay por sessão (settings.json
          // ligado, conversas no provider-state do checkout); o MCP chega por
          // --mcp-config + --allowed-mcp-server-names (worker: só o Nexus).
          const prepared = prepareQwenMcpSession(mcpUrl(), ctx.token, {
            userDataPath: app.getPath("userData"),
            checkoutId: authority.scope.checkoutId,
            providerHome: preparedEnv?.QWEN_HOME,
            cwd: authority.cwd,
            workspaceRoot: authority.scope.rootRealPath,
            hubServers,
          });
          Object.assign(env, prepared.env);
          extraArgs.push(...prepared.extraArgs);
          advisoryProviderStateHome = prepared.providerStateHome;
          advisoryProviderSessionHome = prepared.providerSessionHome;
          advisoryProviderStateReadPaths = prepared.providerStateReadPaths ?? [];
          advisoryProviderStateWritePaths = prepared.providerStateWritePaths ?? [];
        }
      }
      if (!skillsPrepared) {
        // Claude-family panes receive skills in their private HOME. Other
        // autoload providers retain their existing native-profile delivery.
        const deliversToRealProfile =
          gated && ephemeralHomeDir === null && adapter.quirks.mcpAutoload;
        const overlaySkills = ephemeralHomeDir
          ? path.join(ephemeralHomeDir, ".claude", "skills")
          : null;
        // The operator hand's overlay links the REAL ~/.claude/skills
        // (inheritNativeProfile). With a gate, Nexus writes nothing through
        // that link: it is the operator's own profile.
        const overlayIsRealProfile =
          overlaySkills !== null && isSymbolicLinkPath(overlaySkills);
        // F-1157: a private Claude HOME receives every skill (no filter);
        // the real provider profile still receives only what was granted.
        const privateClaudeHome =
          gated &&
          usesClaudeHomeLayout(adapter) &&
          overlaySkills !== null &&
          !overlayIsRealProfile;
        {
          ensureSkillsForCli(adapter.id, {
            allowedSkills: privateClaudeHome
              ? null
              : (deliversToRealProfile || (gated && usesClaudeHomeLayout(adapter)))
                ? [...(meta?.allowedSkills ?? [])]
                : (meta?.allowedSkills ?? null),
            allowedTools: meta?.allowedTools ?? null,
            ephemeralHomeDir: gated && overlayIsRealProfile ? null : ephemeralHomeDir,
            includeCliTarget: !gated || deliversToRealProfile,
          });
        }
      }
    } catch (err) {
      releaseSessionByToken(ctx.token);
      cleanupAgyMcpConfig(ctx.token);
      cleanupCliMcpSession(ctx.token);
      cleanupSessionArtifacts(ctx.token);
      throw new Error(
        `failed to prepare the isolated ${adapter.id} agent runtime`,
        { cause: err },
      );
    }

  let missionShim: MissionShimRuntime | null = null;
  if (
    ctx.role === "worker" &&
    Boolean(ctx.missionId?.trim()) &&
    Boolean(ctx.workerIncarnationId?.trim()) &&
    isMissionShimSandboxSupported(process.platform)
  ) {
    try {
      missionShim = createMissionShimRuntime({
        ctx,
        invoke: async ({ toolName, args }) => {
          if (!registry) {
            return {
              ok: false,
              tool: toolName,
              denied: true,
              error: "mission_shim_dispatch_unavailable",
            };
          }
          return await dispatchToolCall(
            "mission-shim",
            registry,
            toolName,
            args,
            ctx,
            {
              confirm: confirmHttpMcpTool,
              prepareDestructiveReversibility: destructiveReversibilityPreparer,
            },
          );
        },
      });
      missionShims.add(missionShim);
      Object.assign(env, missionShim.env);
      env.PATH = [
        missionShim.binDir,
        preparedEnv?.PATH ?? process.env.PATH ?? "",
      ]
        .filter(Boolean)
        .join(path.delimiter);
    } catch (error) {
      disposeMissionShim(missionShim);
      releaseSessionByToken(ctx.token);
      cleanupAgyMcpConfig(ctx.token);
      cleanupCliMcpSession(ctx.token);
      cleanupSessionArtifacts(ctx.token);
      throw new Error("failed to prepare the private mission shim runtime", {
        cause: error,
      });
    }
  }

  // F-795: spool de handoff da sessão — o diretório privado onde shim, ponte
  // stdio e hook guardam o handoff quando o Main não responde. Vai no mesmo
  // grant de sandbox do shim. Rede de segurança: falhar aqui nunca impede o
  // spawn (o worker segue com os caminhos de entrega de antes).
  let handoffSpool: HandoffSpoolSession | null = null;
  if (missionShim && ctx.missionId) {
    try {
      handoffSpool = createHandoffSpoolSession({
        scope: ctx.scope,
        missionId: ctx.missionId,
        ...(ctx.workerIncarnationId ? { workerIncarnationId: ctx.workerIncarnationId } : {}),
        agentLabel: ctx.agentName ?? ctx.label,
        providerId: adapter.id,
      });
      if (handoffSpool) Object.assign(env, handoffSpool.env);
    } catch (error) {
      console.warn("[handoff-spool] sessão sem spool:", error);
      handoffSpool = null;
    }
  }

  let attachmentReadPaths: readonly string[] | undefined;
  try {
    attachmentReadPaths = missionAttachmentReadPathsForSpawn(
      authority,
      petStudioMediaAuthority === true,
    );
  } catch (error) {
    disposeMissionShim(missionShim);
    handoffSpool?.discard();
    releaseSessionByToken(ctx.token);
    cleanupAgyMcpConfig(ctx.token);
    cleanupCliMcpSession(ctx.token);
    cleanupSessionArtifacts(ctx.token);
    throw new Error("failed to bind sealed mission attachments", {
      cause: error,
    });
  }

  let disposeHeavyProfileExit: (() => void) | undefined;
  selectGrokHeavyShell(env, adapter.id);
  const decoration: AgentSpawnDecoration = {
    authorityToken: ctx.token,
    env,
    ...(envRemove.length > 0 ? { envRemove } : {}),
    extraArgs,
    ...(attachmentReadPaths ? { attachmentReadPaths } : {}),
    ...(missionShim
      ? {
          missionShimReadPaths: [
            ...missionShim.readPaths,
            ...(handoffSpool?.readPaths ?? []),
          ],
          missionShimWritePaths: [
            ...missionShim.writePaths,
            ...(handoffSpool?.writePaths ?? []),
          ],
        }
      : {}),
    ...((advisoryProviderStateHome ||
      advisoryProviderSessionHome ||
      advisoryProviderStateReadPaths.length > 0 ||
      advisoryProviderStateWritePaths.length > 0 ||
      claudeStatePaths.length > 0 ||
      env.NEXUS_HEAVY_COMMAND_URL)
      ? {
          // Grant auth/profile and the exact checkout's durable conversations.
          providerStateReadPaths: [
            path.dirname(heavyCommandPreloadPath()),
            ...claudeStatePaths,
            ...claudeProfileReadPaths,
            ...advisoryProviderStateReadPaths,
            ...(advisoryProviderStateHome ? [advisoryProviderStateHome] : []),
            ...(advisoryProviderSessionHome ? [advisoryProviderSessionHome] : []),
          ],
          providerStateWritePaths: [
            ...claudeStatePaths,
            ...advisoryProviderStateWritePaths,
            ...(advisoryProviderStateHome ? [advisoryProviderStateHome] : []),
            ...(advisoryProviderSessionHome ? [advisoryProviderSessionHome] : []),
          ],
        }
      : {}),
    onSpawned: (sessionId) => {
      bindTokenToSession(ctx.token, sessionId);
      sessionTokens.set(sessionId, ctx.token);
      if (heavyZshProfile(ctx.token)) {
        // This ownership tap outlives MCP shutdown. Only the PTY's physical
        // exit proof authorizes removing a surviving child's bootstrap.
        disposeHeavyProfileExit?.();
        disposeHeavyProfileExit = tapSessionExit((exitedSessionId) => {
          if (exitedSessionId !== sessionId) return;
          disposeHeavyProfileExit?.();
          disposeHeavyProfileExit = undefined;
          cleanupSessionArtifacts(ctx.token);
        });
      }
      cliPromptAutoResponder.bind(sessionId, adapter.id, Date.now(), {
        governed: gated,
      });
      // First-run interstitials (workspace trust, data-sharing consent,
      // migration offers): mission panes only, and always against the exact
      // main-owned cwd this spawn was authorized for — never a path read off
      // the screen. A pane without a missionId binds anyway but can never be
      // answered: the operator answers their own terminal's prompts.
      const spawned = getAgentSessionInfo(sessionId);
      if (spawned) {
        if (spawned.adapterId === "mimo-code" && spawned.paneId && advisoryProviderSessionHome && env.MIMOCODE_DB) {
          registerMimoRuntime({
            ptySessionId: sessionId, paneId: spawned.paneId, accountId: spawned.accountId,
            missionId: spawned.missionId, scope: spawned.scope, cwd: fs.realpathSync(spawned.cwd),
            stateRoot: advisoryProviderSessionHome, databasePath: env.MIMOCODE_DB,
            nativeOwnerKey: mimoNativeOwnerKey,
          }, env.NEXUS_MIMO_HOOK_TOKEN);
        }
        analysisClient.control(sessionId, 'first-run', { bind: {
          adapterId: spawned.adapterId,
          ...(spawned.missionId ? { missionId: spawned.missionId } : {}),
          cwd: spawned.cwd,
          homeDir: os.homedir(),
        } });
      }
      if (missionShim) {
        missionShim.bindSession(sessionId);
        missionShimBySession.set(sessionId, missionShim);
      }
      try {
        handoffSpool?.bindSession(sessionId);
      } catch (error) {
        console.warn("[handoff-spool] vínculo da sessão não gravado:", error);
      }
    },
    onSpawnFailed: () => {
      disposeHeavyProfileExit?.();
      disposeHeavyProfileExit = undefined;
      // No session will ever exist for this token — drop it from the auth
      // registry and remove any token-bearing files we wrote.
      releaseSessionByToken(ctx.token);
      cleanupAgyMcpConfig(ctx.token);
      cleanupCliMcpSession(ctx.token);
      cleanupSessionArtifacts(ctx.token);
      disposeMissionShim(missionShim);
      handoffSpool?.discard();
    },
  };
  return decoration;
};

/** Wire per-agent spawn decoration: gate tokens, MCP config and skill mirrors. */
function installSpawnHook(): void {
  setAgentSpawnHook(prepareAgentSpawnDecoration);
  // F-670/F-671: brief que não pôde ir no argv do Windows é colado depois do
  // boot com a mesma prova de turno das colagens do orquestrador.
  setDeferredInitialPromptHook(({ sessionId, adapterId, prompt, reason }) => {
    console.info(`[pty] brief fora do argv do Windows (${reason}); colando após o boot em ${sessionId}`);
    void deliverAgentPrompt(sessionId, prompt, undefined, { adapterId }).catch((error) => {
      console.warn(
        '[pty] colagem do brief adiado falhou:',
        error instanceof Error ? error.message : error,
      );
    });
  });
}

/** Legacy `### NEXUS_HANDOFF v1` stream fallback (ARCHITECTURE §E.3). */
export function currentPtyMaestroContext(
  sessionId: string,
): AgentGateContext | null {
  const ctx = getContextBySession(sessionId);
  if (
    !ctx ||
    ctx.role !== "orchestrator" ||
    ctx.sessionId !== sessionId ||
    !ctx.missionId ||
    !isCurrentGateContext(ctx)
  ) {
    return null;
  }
  try {
    const mission = getProjectDomainStores(ctx.scope).missions.get(ctx.missionId);
    if (
      !mission ||
      !requireMissionLeaderSession(ctx.scope, ctx.missionId, { sessionId }).ok ||
      !hasCurrentApprovedDispatchContract(mission) ||
      mission.intentContract?.orchestratorRuntime?.nativeReadOnly !== false
    ) {
      return null;
    }
    return ctx;
  } catch {
    return null;
  }
}

function createPtyMissionControl(): PtyStreamMissionControl {
  return new PtyStreamMissionControl({
    onChannel: (sessionId, channelId) => analysisClient.control(sessionId, 'mission-control', { channelId }),
    isAuthorized: (sessionId) =>
      currentPtyMaestroContext(sessionId) !== null,
    isInjectableIdle: (sessionId) =>
      getSessionState(sessionId) === "idle" &&
      isSessionInjectableIdle(sessionId),
    write: orchWriteSession,
    invoke: async (sessionId, request, channelId, callerSignal): Promise<ToolDispatchResult> => {
      const ctx = currentPtyMaestroContext(sessionId);
      if (!ctx || !registry) {
        throw new Error(
          "Canal Nexus revogado: retome a missão para restaurar o Maestro atual.",
        );
      }
      return await runInsidePtyStreamAgentTransport(sessionId, ctx, () =>
        dispatchPtyStreamMissionAction({
          sessionId,
          channelId,
          request,
          registry: registry!,
          ctx,
          options: {
            callerSignal,
            confirm: confirmHttpMcpTool,
            prepareDestructiveReversibility: destructiveReversibilityPreparer,
          },
        }),
      );
    },
  });
}

/** Legacy handoff + provider-independent Maestro control stream parsers. */
export function installLegacyParser(
  missionControl: PtyStreamMissionControl,
): void {
  const dedupe = new LegacyHandoffDedupe();
  const onPayload = (sessionId: string, payload: import("./legacy-handoff").LegacyHandoffPayload) => {
    if (isPlaceholderSummary(payload.summary)) {
      console.log(
        `[handoff] bloco PTY com summary placeholder ignorado (${sessionId})`,
      );
      return;
    }
    // Repaint do TUI re-emite o MESMO bloco — uma entrega só por conteúdo.
    if (dedupe.isDuplicate(sessionId, payload)) return;
    void submitPtyStreamHandoff(sessionId, payload).catch((error) => {
      // A transient Git/store failure must remain retryable on the next real
      // terminal emission. Repaints are still suppressed while ingest runs.
      dedupe.forget(sessionId, payload);
      console.warn(
        `[handoff] PTY stream handoff rejected (${sessionId}):`,
        error,
      );
      void terminateStaleReadOnlyPtyStreamSession(sessionId, error)
        .then((terminated) => {
          if (terminated) {
            console.warn(
              `[handoff] stale read-only PTY session terminated for recovery (${sessionId})`,
            );
          }
        })
        .catch((terminationError) => {
          console.warn(
            `[handoff] stale read-only PTY recovery failed (${sessionId}):`,
            terminationError,
          );
        });
    });
  };
  const delayedWrite = (sessionId: string, data: string, fence: AnalysisFence) => {
    const original = getAgentSessionInfo(sessionId);
    if (!original) return;
    setTimeout(() => {
      const current = getAgentSessionInfo(sessionId);
      if (analysisClient.generation(sessionId) !== fence.generation || analysisClient.status(sessionId) !== 'active' ||
          !current || current.paneId !== original.paneId || current.adapterId !== original.adapterId ||
          current.missionId !== original.missionId || current.workerIncarnationId !== original.workerIncarnationId) return;
      orchWriteSession(sessionId, data);
    }, 50);
  };
  legacyParserTaps.replace((track) => {
    track(subscribePtyAnalysis('mission-control', (sessionId, request) => missionControl.acceptObservedAction(sessionId, request as import('./pty-stream-mission-control').PtyStreamMissionAction)));
    track(subscribePtyAnalysis('handoff', (sessionId, payload) => {
      // Sealed final evidence remains in the immutable archive. A dead PTY
      // cannot mint a new tool transport or authorize late writes.
      if (analysisClient.status(sessionId) === 'active') onPayload(sessionId, payload as import('./legacy-handoff').LegacyHandoffPayload);
    }));
    track(subscribePtyAnalysis('prompt', (sessionId, value, fence) => {
      if (!getOrchSettings().cliPromptAutoResponderEnabled) return;
      const result = value as Parameters<typeof cliPromptAutoResponder.acceptWorker>[1];
      cliPromptAutoResponder.acceptWorker(sessionId, result, fence.observedAt);
      if (result.response) delayedWrite(sessionId, result.response, fence);
    }));
    track(subscribePtyAnalysis('first-run', (sessionId, value, fence) => {
      if (!getOrchSettings().cliPromptAutoResponderEnabled || getAgentSemanticStatusBySession(sessionId)?.status === 'working') return;
      delayedWrite(sessionId, (value as { answer: string }).answer, fence);
    }));
    track(tapSessionState((sessionId, state) => {
      // State effects wait through their output cutoff, then revalidate in the
      // Main-owned channel. No idle reparse of terminal text in Main.
      void flushPtyAnalysis(sessionId).then((ok) => { if (ok) missionControl.observeSessionState(sessionId, state); });
    }));
    track(tapSessionExit((sessionId) => {
      cliPromptAutoResponder.drop(sessionId);
      analysisClient.control(sessionId, 'first-run', { drop: true });
      // `seal`, not `drop`: an agent that writes "PRONTO:" and exits in the
      // same breath must still be heard by the next fast-lane tick. Buffers
      // and prompts are freed; only the verdict survives.
      missionMarkerObserver.seal(sessionId);
      dedupe.dropSession(sessionId);
      missionControl.dropSession(sessionId);
      // PTY died without a stop hook → semantic status resets to idle (kills
      // the "busy preso" class the 5-minute hook watchdog merely bounds).
      resetAgentStatusOnExit(sessionId);
      const token = sessionTokens.get(sessionId);
      if (token) {
        sessionTokens.delete(sessionId);
        cleanupAgyMcpConfig(token);
        cleanupCliMcpSession(token);
        cleanupSessionArtifacts(token);
      }
      clearMcpPermissionSession(sessionId);
      disposeMissionShimBySession(sessionId);
      // F-795: última passada do spool desta sessão; o diretório some vazio.
      disposeHandoffSpoolBySession(sessionId);
      releaseSession(sessionId);
    }));
    track(
      tapSessionTermination((sessionId) => {
        disposeMissionShimBySession(sessionId);
        disposeHandoffSpoolBySession(sessionId);
      }),
    );
  });
}

/**
 * A stuck disk operation must not hold back the start of every other CLI. Past the
 * deadline the recovery counts as incomplete and keeps finishing in the background.
 */
const MUSE_RECOVERY_DEADLINE_MS = 3_000;
function museRecoveryWithinDeadline(
  recovery: Promise<{ restored: number; retained: number; failed: number }>,
): Promise<{ restored: number; retained: number; failed: number }> {
  const incomplete = { restored: 0, retained: 0, failed: 1 };
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<typeof incomplete>((resolve) => {
    timer = setTimeout(() => resolve(incomplete), MUSE_RECOVERY_DEADLINE_MS);
    timer.unref?.();
  });
  return Promise.race([recovery.catch(() => incomplete), late]).finally(() => clearTimeout(timer));
}

export async function startMcpServer(): Promise<void> {
  // A retry cannot install new dependencies while an old spool FD or
  // already-started delivery still owns the previous registry generation.
  if (mcpStopFlight) await mcpStopFlight;
  // The start supervisor drains this attempt before MCP/store shutdown.
  // Recover shared hooks before a generic artifact purge can run.
  const museRecovery = await museRecoveryWithinDeadline(recoverMuseNativeHeavyLeases());
  if (museRecovery.failed > 0) {
    console.warn("[orch] Muse hook lease recovery was incomplete", {
      failed: museRecovery.failed, retained: museRecovery.retained,
    });
  }
  nativeHeavyCommands.startAdmission();
  httpConfirmationScheduler.close();
  httpConfirmationScheduler = new McpConfirmationScheduler(
    showHttpMcpConfirmation,
  );
  const staleAgy = purgeStaleAgyMcpConfigs();
  const staleCli = purgeStaleCliMcpSessions();
  const removedArtifacts = staleAgy.removed + staleCli.removed;
  const failedArtifacts = staleAgy.failed + staleCli.failed;
  if (removedArtifacts > 0) {
    console.log(`[orch] removed ${removedArtifacts} stale MCP artifact(s)`);
  }
  if (failedArtifacts > 0 || staleAgy.truncated || staleCli.truncated) {
    console.warn("[orch] stale MCP artifact purge was incomplete", {
      failed: failedArtifacts,
      truncated: staleAgy.truncated || staleCli.truncated,
    });
  }
  registry = {
    tools: buildToolset(),
    serverName: "nexus-ide",
    serverVersion: app.getVersion(),
  };
  // nexus_tool_pick recomenda só entre as ferramentas deste servidor, filtradas
  // por chamador na hora da chamada (mesmo critério do tools/list).
  setToolPickRegistry(registry.tools);
  installSpawnHook();
  // F-1157: `readOnly` só confina quando o operador escolheu o Hardened.
  registerHardenedSpawnPolicy(() =>
    isGovernedPolicy(getOrchSettings().squadCliPolicy),
  );
  // F-794: salvaguarda da worktree do writer avisa o orquestrador da missão.
  installWorktreeSalvageNotifier();
  // F-795: spool de handoffs que o Main não recebeu — ingestão no boot, na
  // volta do loop (watch) e no fim de cada sessão; nunca no caminho quente.
  try {
    startHandoffSpool({
      root: handoffSpoolRoot(app.getPath("userData")),
      deps: { getStores: getProjectDomainStores, deliver: onHandoffSubmitted },
    });
  } catch (error) {
    console.warn("[handoff-spool] spool desligado:", error);
  }
  // F-529: reenvios do autoresponder (tecla perdida na race do desenho do
  // diálogo de trust) digitam pelo mesmo caminho da resposta original.
  cliPromptAutoResponder.setWriter(orchWriteSession);
  const missionControl = createPtyMissionControl();
  disposePtyMissionControl?.();
  disposePtyMissionControl = installPtyStreamMissionControl(missionControl);
  installLegacyParser(missionControl);
  // Manifest-based screen detection (src/main/detect/): additive "screen"
  // source into the semantic status reducer; hook authority still wins.
  disposeScreenDetection?.();
  disposeScreenDetection = startAgentScreenDetection();
  try {
    disposeJevPaneClassifier?.();
    disposeJevPaneClassifier = startJevPaneStateClassifier();
  } catch (err) {
    // Fail-open: o classificador Jev é advisory; sem ele os manifests seguem.
    console.warn("[jev] classificador de pane desligado:", err);
    disposeJevPaneClassifier = null;
  }
  disposeTerminationRevocation?.();
  disposeTerminationRevocation = installMcpSessionTerminationRevocation();
  const candidate = http.createServer((req, res) => {
    void (async () => {
      const url = req.url ?? "";
      // Nexus Arms PRIMEIRO: token dedicado, não é bearer de sessão de pane.
      // Nexus Arms: conector externo (Grok Bot/Cursor). Token dedicado — NÃO é
      // um bearer de sessão de pane; este endpoint só serve observação de app.
      if (url === "/arms/mcp" && req.method === "POST") {
        const armsHeader = req.headers.authorization;
        const armsToken = armsHeader?.startsWith("Bearer ")
          ? armsHeader.slice("Bearer ".length).trim()
          : null;
        if (!armsToken || !authenticateArmsToken(armsToken)) {
          sendJson(res, 401, { error: "invalid or missing Arms token" });
          return;
        }
        try {
          const body = JSON.parse(await readBody(req));
          sendJson(res, 200, handleArmsJsonRpc(body));
        } catch {
          sendJson(
            res,
            400,
            { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } },
          );
        }
        return;
      }
      const ctx = bearerContext(req);
      if (!ctx) {
        sendJson(res, 401, { error: "missing or unknown bearer token" });
        return;
      }
      if (url === "/mcp" || url.startsWith("/mcp?")) {
        await handleMcpRequest(req, res, ctx);
        return;
      }
      const gateMatch = /^\/gate\/([a-z]+)$/.exec(url);
      if (gateMatch && req.method === "POST") {
        await handleGateRequest(req, res, ctx, gateMatch[1]);
        return;
      }
      const hubMatch = /^\/hub\/([^/?]+)(?:\?.*)?$/.exec(url);
      if (hubMatch) {
        await handleMcpHubRequest(req, res, ctx, hubMatch[1]!);
        return;
      }
      // Semantic status hooks (emdash wave 1) — additive, never enforcement.
      if (url === "/hook/status" && req.method === "POST") {
        await handleHookStatusHttp(req, res, ctx);
        return;
      }
      // PostToolUseFailure/Bash triage — additive, never blocks the CLI.
      if (url === "/hook/triage" && req.method === "POST") {
        await handleHookTriageHttp(req, res, ctx);
        return;
      }
      // UserPromptSubmit → conselho de delegação do Jev — aditivo, nunca bloqueia.
      if (url === "/hook/delegate" && req.method === "POST") {
        await handleHookDelegateHttp(req, res, ctx);
        return;
      }
      // Stop → portão de regressão (testes impactados) — nunca quebra o CLI.
      if (url === "/hook/regression" && req.method === "POST") {
        await handleHookRegressionHttp(req, res, ctx);
        return;
      }
      if (url === '/hook/heavy-command' && req.method === 'POST') {
        await handleNativeHeavyCommandHttp(req, res, ctx); return;
      }
      // PreToolUse/Bash → portão de integração (veredito de ponta por HEAD).
      if (url === "/hook/integration" && req.method === "POST") {
        await handleHookIntegrationHttp(req, res, ctx);
        return;
      }
      // PermissionRequest → aprovação estruturada; só espera com respondente.
      if (url === "/hook/permission" && req.method === "POST") {
        await handleHookPermissionHttp(req, res, ctx);
        return;
      }
      sendJson(res, 404, { error: "not found" });
    })().catch((err) => {
      console.warn("[orch] MCP request failed:", err);
      try {
        sendJson(res, 500, { error: "internal error" });
      } catch {
        // Response already started — nothing to salvage.
      }
    });
  });
  server = candidate;
  port = 0;

  return listenOnLoopback(candidate)
    .then((boundPort) => {
      if (server !== candidate) {
        candidate.close();
        throw new Error("embedded MCP server startup was superseded");
      }
      port = boundPort;
      console.log(`[orch] embedded MCP server on ${mcpUrl()}`);
      writeArmsRuntimeDescriptor(boundPort);
      markArmsBoot();
      // Warm pool (paridade Overclock): registra o criador de CLI ocioso.
      // Sem workspace ativo o provider devolve null — miss honesto, nunca cwd inventado.
      void (async () => {
        try {
          const { registerWarmAgentSpawner } = await import('../pty/warm-agent-spawner');
          const { getAdapter } = await import('../adapters/adapter-registry');
          const { requireProjectDomainStoreRegistry } = await import(
            './project-domain-store-registry'
          );
          const { resolveCwdForScope } = await import('./workspace-path');
          registerWarmAgentSpawner({
            resolveAdapter: (cli) => getAdapter(cli),
            resolveContext: () => {
              try {
                const suite = requireProjectDomainStoreRegistry().listSuites()[0];
                if (!suite) return null;
                const cwd = resolveCwdForScope(suite.scope);
                return { scope: suite.scope, cwd };
              } catch {
                return null;
              }
            },
          });
        } catch (err) {
          console.warn('[warm-pool] spawner não registrado:', err);
        }
      })();
      emitAppEvent('app.boot', { port: boundPort });
    })
    .catch((error: unknown) => {
      if (candidate.listening) {
        candidate.close();
      }
      if (server === candidate) {
        server = null;
        port = 0;
      }
      throw error;
    });
}

export function stopMcpServer(): Promise<void> {
  if (mcpStopFlight) return mcpStopFlight;
  // Fence the spool before synchronous session/shim cleanup can run.
  const spoolDrain = stopHandoffSpool();
  nativeHeavyCommands.stopAdmission();
  setAgentSpawnHook(null);
  setDeferredInitialPromptHook(null);
  legacyParserTaps.dispose();
  disposeTerminationRevocation?.();
  disposeTerminationRevocation = null;
  httpConfirmationScheduler.close();
  cliPromptAutoResponder.clear();

  missionMarkerObserver.clear();
  disposePtyMissionControl?.();
  disposePtyMissionControl = null;
  disposeScreenDetection?.();
  disposeScreenDetection = null;
  disposeJevPaneClassifier?.();
  disposeJevPaneClassifier = null;
  mcpStdioHub?.disposeAll();
  mcpStdioHub = null;
  for (const token of sessionTokens.values()) {
    cleanupAgyMcpConfig(token);
    cleanupCliMcpSession(token);
    // Proven physical exits already removed their sessionTokens entry. A
    // remaining child may still start zsh; preserve its entire overlay (the
    // bootstrap lives inside it) until the independent exit tap cleans it.
    if (!heavyZshProfile(token)) cleanupSessionArtifacts(token);
    releaseSessionByToken(token);
  }
  sessionTokens.clear();
  for (const runtime of [...missionShims]) disposeMissionShim(runtime);
  missionShimBySession.clear();
  // Fecha watchers/timers; o que estiver no disco fica para o próximo boot.
  server?.close();
  server = null;
  port = 0;
  removeArmsRuntimeDescriptor();
  const physical = spoolDrain.finally(() => {
    if (mcpStopFlight === physical) mcpStopFlight = null;
  });
  mcpStopFlight = physical;
  return physical;
}

export function getMcpRuntimeInfo(): McpRuntimeInfo {
  return {
    running: server !== null && port > 0,
    url: port > 0 ? mcpUrl() : null,
    toolCount: registry?.tools.length ?? 0,
  };
}

/** Names + descriptions of the native MCP toolset (settings drawer TOOLS). */
export function getToolCatalog(): Array<{ name: string; description: string }> {
  const tools = registry?.tools ?? buildToolset();
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
  }));
}
