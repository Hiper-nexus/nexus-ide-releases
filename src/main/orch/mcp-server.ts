import http from "node:http";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { app, dialog } from "electron";
import type { McpRuntimeInfo } from "../../shared/orch-types";
import { hasCurrentApprovedDispatchContract } from "../../shared/mission-intent";
import {
  getSessionState,
  orchWriteSession,
  setAgentSpawnHook,
  tapSessionData,
  tapSessionExit,
  tapSessionState,
  type AgentSpawnDecoration,
  type AgentSpawnHook,
} from "../pty/pty-manager";
import {
  bindTokenToSession,
  evaluateStop,
  getContext,
  getContextBySession,
  isCurrentGateContext,
  isSkillAllowed,
  isHookToolAllowed,
  isInternalPrevcReviewerHookToolAllowed,
  mintToken,
  releaseSession,
  releaseSessionByToken,
  type AgentGateContext,
} from "./gate";
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
import type {
  McpConfirmationHandler,
  McpConfirmationRequest,
} from "./mcp-dispatch-contract";
import { McpConfirmationScheduler } from "./mcp-confirmation-scheduler";
import { isHookMcpToolAllowedForReadOnlyContext } from "./mcp-effect-policy";
import { clearSession as clearMcpPermissionSession } from "../jarvis/permissions";
import {
  boundedConfirmationArgs,
  boundedConfirmationLine,
} from "./confirmation-format";
import { MAX_MCP_PAYLOAD_BYTES } from "./mcp-args-validation";
import { buildToolset } from "./tools";
import { stripAnsi } from "./pane-registry";
import {
  isPlaceholderSummary,
  LegacyHandoffDedupe,
  LegacyHandoffParser,
} from "./legacy-handoff";
import { getProjectDomainStores } from "./project-domain-store-registry";
import { submitPtyStreamHandoff } from "./pty-stream-handoff";
import {
  installPtyStreamMissionControl,
  PtyStreamMissionControl,
} from "./pty-stream-mission-control";
import { cliPromptAutoResponder } from "./cli-prompt-autoresponder";
import {
  cleanupSessionArtifacts,
  prepareEphemeralHome,
  prepareThirdPartyClaudeHome,
  writeClaudeFamilyZeroClickSettings,
  writeMcpConfigFile,
} from "./hooks-gen";
import { handleHookStatusHttp } from "./hook-status-endpoint";
import {
  isSessionInjectableIdle,
  resetAgentStatusOnExit,
} from "./agent-status";
import { installMcpSessionTerminationRevocation } from "./mcp-session-revocation";
import { codexStatusHookArgs } from "./hook-status-config";
import { codexHookTrustBypassArgs } from "./codex-cli-version";
import {
  cleanupAgyMcpConfig,
  codexMcpArgs,
  purgeStaleAgyMcpConfigs,
  supportsMcpInjection,
} from "./cli-mcp-inject";
import {
  cleanupCliMcpSession,
  prepareGrokMcpSession,
  prepareKimiMcpSession,
  prepareOpenCodeMcpSession,
  purgeStaleCliMcpSessions,
} from "./cli-mcp-session-config";
import { ensureSkillsForCli } from "./skill-mirror";
import {
  isPetStudioNativeWorkspaceAuthority,
} from "../pty/autonomous-cli-policy";
import { getOrchSettings } from "../persistence/settings-store";
import { isOperatorChoicePolicy } from "../../shared/squad-cli-policy";
import {
  isThirdPartyClaudeFamily,
  requiresSpawnGate,
  shouldUseEphemeralHome,
} from "./spawn-home-policy";
import {
  findActiveContextDraftReviewerId,
} from "../context/cli-context-draft-reviewer";
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
const sessionTokens = new Map<string, string>(); // sessionId → token
let disposeTerminationRevocation: (() => void) | null = null;
let disposePtyMissionControl: (() => void) | null = null;

async function showHttpMcpConfirmation(
  request: McpConfirmationRequest,
): Promise<boolean> {
  const result = await dialog.showMessageBox({
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
  });
  return result.response === 1;
}

let httpConfirmationScheduler = new McpConfirmationScheduler(
  showHttpMcpConfirmation,
);

const confirmHttpMcpTool: McpConfirmationHandler = (request) =>
  httpConfirmationScheduler.enqueue(request);

function mcpUrl(): string {
  return `http://127.0.0.1:${port}/mcp`;
}

function gateUrl(): string {
  return `http://127.0.0.1:${port}/gate`;
}

/**
 * Semantic agent-status ingest (emdash wave 1): same loopback server, same
 * per-pane bearer as /gate/* — hook commands reference this via $NEXUS_HOOK_URL.
 */
function hookStatusUrl(): string {
  return `http://127.0.0.1:${port}/hook/status`;
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
      });
      if (response) responses.push(response);
    }
  });
  if (authorityRevoked) return;
  const headers = { "mcp-session-id": ctx.token.slice(0, 16) };
  if (responses.length === 0) {
    res.writeHead(202, headers);
    res.end();
    return;
  }
  sendJson(res, 200, Array.isArray(parsed) ? responses : responses[0], headers);
}

interface GateBody {
  toolName?: string | null;
  toolInput?: Record<string, unknown> | null;
}

async function handleGateRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: AgentGateContext,
  event: string,
): Promise<void> {
  let body: GateBody = {};
  try {
    body = JSON.parse((await readBody(req)) || "{}") as GateBody;
  } catch {
    // Empty/invalid body — treat as a bare event.
  }
  if (!isCurrentGateContext(ctx)) {
    sendJson(res, 401, { error: "session authority was revoked" });
    return;
  }
  switch (event) {
    case "pretool": {
      const toolName = body.toolName ?? "";
      if (!toolName) {
        sendJson(res, 200, {
          allow: false,
          reason: "hook omitted tool identity",
        });
        return;
      }
      if (toolName === "Skill") {
        const skill = String(
          (body.toolInput as { skill?: unknown } | null)?.skill ?? "",
        );
        const allow = skill === "" || isSkillAllowed(ctx.allowedSkills, skill);
        sendJson(res, 200, {
          allow,
          reason: allow
            ? undefined
            : `skill "${skill}" is outside this agent's allowlist`,
        });
        return;
      }
      const allowlisted = isHookToolAllowed(
        ctx.allowedTools,
        toolName,
        ctx.role,
      );
      const reviewerAllowed = isInternalPrevcReviewerHookToolAllowed(
        ctx,
        toolName,
      );
      const readOnlyAllowed =
        !ctx.readOnly ||
        (ctx.internalPrevcReviewerAuthority !== undefined &&
          reviewerAllowed) ||
        isHookMcpToolAllowedForReadOnlyContext(toolName);
      const allow = allowlisted && reviewerAllowed && readOnlyAllowed;
      sendJson(res, 200, {
        allow,
        reason: allow
          ? undefined
          : !allowlisted
            ? `tool "${toolName}" is outside this agent's allowlist`
            : !reviewerAllowed
              ? `tool "${toolName}" is outside this internal reviewer's exact profile`
            : `read-only authority denied tool "${toolName}"`,
      });
      return;
    }
    case "posttool":
      sendJson(res, 200, { allow: true });
      return;
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

function buildMcpConfig(token: string): object {
  return {
    mcpServers: {
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
) => {
    const meta = authority.context;
    const gated = requiresSpawnGate(meta);
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
      allowedTools: meta?.allowedTools ?? null,
      allowedSkills: meta?.allowedSkills ?? null,
      scope: authority.coordinationScope ?? authority.scope,
      executionScope: authority.scope,
    });

    const env: Record<string, string> = {
      NEXUS_MCP_URL: mcpUrl(),
      NEXUS_MCP_TOKEN: ctx.token,
      NEXUS_GATE_URL: gateUrl(),
      NEXUS_GATE_TOKEN: ctx.token,
      // Status hooks inherit this from the PTY env (never written to disk).
      NEXUS_HOOK_URL: hookStatusUrl(),
    };
    const extraArgs: string[] = [];
    let ephemeralHomeDir: string | null = null;
    let skillsPrepared = false;
    // Real provider home (~/.kimi-code, ~/.grok) the governed overlay symlinks
    // session/auth state into. The advisory sandbox grants it read+write.
    let advisoryProviderStateHome: string | undefined;
    // Delegação VISÍVEL (benchmark §4.5): Claude recebe o hard-deny de Task
    // pelo adapter base, então o bloqueio vale para panes diretos e
    // orquestrados sem duplicar flags aqui.
    const mcpConfig = buildMcpConfig(ctx.token);
    const thirdPartyClaudeFamily = isThirdPartyClaudeFamily(
      adapter,
      preparedEnv,
    );
    const homeMode =
      adapter.quirks.mcpAutoload &&
      isOperatorChoicePolicy(getOrchSettings().squadCliPolicy) &&
      petStudioMediaAuthority !== true
        ? "operator-choice"
        : "hardened";

    try {
      if (
        shouldUseEphemeralHome(adapter, gated, {
          mode: homeMode,
          effectiveEnv: preparedEnv,
        })
      ) {
        // Só o Claude NATIVO carrega a identidade OAuth da assinatura para o
        // overlay; GLM/LongCat (base URL de terceiro) jamais podem recebê-la.
        const approvedMissionProjectTrust =
          hasApprovedMissionProjectTrust(authority);
        const home = prepareEphemeralHome(ctx.token, mcpConfig, {
          carryNativeClaudeAuth: !thirdPartyClaudeFamily,
          cwd: authority.cwd,
          approvedMissionProjectTrust,
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
        ephemeralHomeDir = home.dir;
        // A identidade OAuth carregada faz o CLI baixar os conectores MCP da
        // CONTA (Drive, Vercel, HF…): meia dúzia de OAuth remotos no boot de
        // um agente que só pode usar mcp__nexus. Isso atrasava/mutava o boot
        // (o paint espera handshake MCP) e afogava o orquestrador em
        // ferramentas que ele nunca poderia chamar. Estrito: só o nexus.
        extraArgs.push(
          "--mcp-config",
          home.mcpConfigPath,
          "--strict-mcp-config",
        );
      } else if (thirdPartyClaudeFamily) {
        // GLM/LongCat run the `claude` binary against a third-party endpoint via
        // an injected token. Sharing the native ~/.claude lets the binary
        // rewrite the subscription's OAuth session → the native Claude
        // orchestrator gets logged out (/login). Isolate them in a persistent
        // private HOME; MCP + zero-click settings still arrive via flags, and
        // skills mirror into the isolated home.
        const isolatedHome = prepareThirdPartyClaudeHome(adapter.id);
        env.HOME = isolatedHome;
        ephemeralHomeDir = isolatedHome;
        extraArgs.push(
          "--mcp-config",
          writeMcpConfigFile(ctx.token, mcpConfig),
          "--settings",
          writeClaudeFamilyZeroClickSettings(ctx.token),
        );
      } else if (adapter.quirks.mcpAutoload) {
        // Real HOME: still force zero-click via flag settings (system default).
        extraArgs.push(
          "--mcp-config",
          writeMcpConfigFile(ctx.token, mcpConfig),
          "--settings",
          writeClaudeFamilyZeroClickSettings(ctx.token),
        );
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
          // Additive status hooks as per-session -c overrides (emdash wave 1)
          // — same argv-only channel as the MCP injection, zero disk writes.
          extraArgs.push(...codexStatusHookArgs());
          // Codex >= 0.129 requires interactive review of untrusted hooks —
          // fatal for orchestrated boot. The -c hooks.* above have no on-disk
          // identity that could be pre-trusted via config.toml hooks.state,
          // so bypass trust: Nexus IS the automation that vets these hook
          // sources (it writes them). Version-gated (>= 0.134): unknown flag
          // on older codex would break the spawn; unresolved version omits.
          extraArgs.push(...codexHookTrustBypassArgs(adapter.bin));
        } else if (flavor === "opencode") {
          const prepared = prepareOpenCodeMcpSession(mcpUrl(), ctx.token);
          Object.assign(env, prepared.env);
          extraArgs.push(...prepared.extraArgs);
        } else if (flavor === "kimi") {
          const prepared = prepareKimiMcpSession(mcpUrl(), ctx.token, {
            providerHome: preparedEnv?.KIMI_CODE_HOME,
          });
          Object.assign(env, prepared.env);
          extraArgs.push(...prepared.extraArgs);
          advisoryProviderStateHome = prepared.providerStateHome;
        } else if (flavor === "grok") {
          const prepared = prepareGrokMcpSession(mcpUrl(), ctx.token, {
            providerHome: preparedEnv?.GROK_HOME,
            cwd: authority.cwd,
            workspaceRoot: authority.scope.rootRealPath,
          });
          Object.assign(env, prepared.env);
          extraArgs.push(...prepared.extraArgs);
          advisoryProviderStateHome = prepared.providerStateHome;
        }
      }
      if (!skillsPrepared) {
        ensureSkillsForCli(adapter.id, {
          allowedSkills: meta?.allowedSkills ?? null,
          ephemeralHomeDir,
          includeCliTarget: !gated,
        });
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

    const decoration: AgentSpawnDecoration = {
      env,
      extraArgs,
      ...(advisoryProviderStateHome
        ? {
            // Overlay providers (Kimi/Grok): keep the minted runtime as HOME
            // (pty-manager path), but grant the real provider home so the
            // overlay's session/auth symlinks resolve read+write.
            providerStateReadPaths: [advisoryProviderStateHome],
            providerStateWritePaths: [advisoryProviderStateHome],
          }
        : {}),
      onSpawned: (sessionId) => {
        bindTokenToSession(ctx.token, sessionId);
        sessionTokens.set(sessionId, ctx.token);
        cliPromptAutoResponder.bind(sessionId, adapter.id);
      },
      onSpawnFailed: () => {
        // No session will ever exist for this token — drop it from the auth
        // registry and remove any token-bearing files we wrote.
        releaseSessionByToken(ctx.token);
        cleanupAgyMcpConfig(ctx.token);
        cleanupCliMcpSession(ctx.token);
        cleanupSessionArtifacts(ctx.token);
      },
    };
    return decoration;
};

/** Wire per-agent spawn decoration: gate tokens, MCP config and skill mirrors. */
function installSpawnHook(): void {
  setAgentSpawnHook(prepareAgentSpawnDecoration);
}

/** Legacy `### NEXUS_HANDOFF v1` stream fallback (ARCHITECTURE §E.3). */
function currentPtyMaestroContext(
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
      mission.orchestratorSessionId !== sessionId ||
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
    isAuthorized: (sessionId) =>
      currentPtyMaestroContext(sessionId) !== null,
    isInjectableIdle: (sessionId) =>
      getSessionState(sessionId) === "idle" &&
      isSessionInjectableIdle(sessionId),
    write: orchWriteSession,
    invoke: async (sessionId, request): Promise<ToolDispatchResult> => {
      const ctx = currentPtyMaestroContext(sessionId);
      if (!ctx || !registry) {
        throw new Error(
          "Canal Nexus revogado: retome a missão para restaurar o Maestro atual.",
        );
      }
      return await runInsidePtyStreamAgentTransport(sessionId, ctx, () =>
        dispatchToolCall(
          "pty-stream",
          registry!,
          request.tool,
          request.args,
          ctx,
          { confirm: confirmHttpMcpTool },
        ),
      );
    },
  });
}

/** Legacy handoff + provider-independent Maestro control stream parsers. */
function installLegacyParser(
  missionControl: PtyStreamMissionControl,
): void {
  const dedupe = new LegacyHandoffDedupe();
  const parser = new LegacyHandoffParser((sessionId, payload) => {
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
    });
  });
  // Prefiltro: stripAnsi + parse custam ~104ms/10k chunks e rodavam em TODO
  // output de PTY. Só paga quando o chunk pode conter o marker (tail cru curto
  // cobre marker dividido entre chunks) ou quando um bloco já está aberto.
  const rawTails = new Map<string, string>();
  const MARKER_HINT = "NEXUS_HANDOFF";
  tapSessionData((sessionId, data) => {
    let plain: string | null = null;
    if (cliPromptAutoResponder.isPending(sessionId)) {
      plain = stripAnsi(data);
    }
    const response =
      plain !== null ? cliPromptAutoResponder.observe(sessionId, plain) : null;
    if (response !== null) {
      setTimeout(() => {
        orchWriteSession(sessionId, response);
      }, 50);
    }
    if (missionControl.hasChannel(sessionId)) {
      plain ??= stripAnsi(data);
      missionControl.feed(sessionId, plain);
    }
    const tail = rawTails.get(sessionId) ?? "";
    const probe = tail + data;
    rawTails.set(sessionId, probe.slice(-32));
    const isCollecting = parser.isCollecting(sessionId);
    if (!isCollecting && !probe.includes(MARKER_HINT)) {
      return;
    }
    // When the marker crosses the PTY chunk boundary, the parser never saw
    // `tail` because the cheap prefilter skipped that previous chunk.
    parser.feed(
      sessionId,
      isCollecting ? (plain ?? stripAnsi(data)) : stripAnsi(probe),
    );
  });
  tapSessionState((sessionId, state) => {
    missionControl.observeSessionState(sessionId, state);
  });
  tapSessionExit((sessionId) => {
    cliPromptAutoResponder.drop(sessionId);
    parser.dropSession(sessionId);
    dedupe.dropSession(sessionId);
    rawTails.delete(sessionId);
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
    releaseSession(sessionId);
  });
}

export function startMcpServer(): Promise<void> {
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
  installSpawnHook();
  const missionControl = createPtyMissionControl();
  disposePtyMissionControl?.();
  disposePtyMissionControl = installPtyStreamMissionControl(missionControl);
  installLegacyParser(missionControl);
  disposeTerminationRevocation?.();
  disposeTerminationRevocation = installMcpSessionTerminationRevocation();
  server = http.createServer((req, res) => {
    void (async () => {
      const url = req.url ?? "";
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
      // Semantic status hooks (emdash wave 1) — additive, never enforcement.
      if (url === "/hook/status" && req.method === "POST") {
        await handleHookStatusHttp(req, res, ctx);
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

  return new Promise((resolve) => {
    server!.listen(0, "127.0.0.1", () => {
      port = (server!.address() as AddressInfo).port;
      console.log(`[orch] embedded MCP server on ${mcpUrl()}`);
      resolve();
    });
  });
}

export function stopMcpServer(): void {
  setAgentSpawnHook(null);
  disposeTerminationRevocation?.();
  disposeTerminationRevocation = null;
  httpConfirmationScheduler.close();
  cliPromptAutoResponder.clear();
  disposePtyMissionControl?.();
  disposePtyMissionControl = null;
  for (const token of sessionTokens.values()) {
    cleanupAgyMcpConfig(token);
    cleanupCliMcpSession(token);
    cleanupSessionArtifacts(token);
    releaseSessionByToken(token);
  }
  sessionTokens.clear();
  server?.close();
  server = null;
  port = 0;
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
