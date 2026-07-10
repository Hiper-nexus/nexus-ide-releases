import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { app, dialog } from 'electron';
import type { McpRuntimeInfo } from '../../shared/orch-types';
import {
  orchWriteSession,
  setAgentSpawnHook,
  tapSessionData,
  tapSessionExit,
  type AgentSpawnDecoration,
} from '../pty/pty-manager';
import {
  bindTokenToSession,
  evaluateStop,
  getContext,
  getContextBySession,
  isSkillAllowed,
  isHookToolAllowed,
  mintToken,
  releaseSession,
  releaseSessionByToken,
  type AgentGateContext,
} from './gate';
import {
  handleMcpMessage,
  isJsonRpcRequest,
  type McpRegistry,
} from './mcp-protocol';
import type {
  McpConfirmationHandler,
  McpConfirmationRequest,
} from './mcp-dispatch';
import { redactArgs } from '../jarvis/audit-log';
import { clearSession as clearMcpPermissionSession } from '../jarvis/permissions';
import { MAX_MCP_PAYLOAD_BYTES } from './mcp-args-validation';
import { buildToolset } from './tools';
import { getPendingSpawnMeta, stripAnsi } from './pane-registry';
import {
  isPlaceholderSummary,
  LegacyHandoffDedupe,
  LegacyHandoffParser,
} from './legacy-handoff';
import { submitHandoff } from './handoff-store';
import { onHandoffSubmitted } from './idle-delivery';
import {
  CliPromptAutoResponder,
} from './cli-prompt-autoresponder';
import {
  cleanupSessionArtifacts,
  prepareEphemeralHome,
  writeMcpConfigFile,
} from './hooks-gen';
import {
  cleanupAgyMcpConfig,
  codexMcpArgs,
  prepareAgyMcpConfig,
  purgeStaleAgyMcpConfigs,
  supportsMcpInjection,
} from './cli-mcp-inject';
import {
  cleanupCliMcpSession,
  prepareGrokMcpSession,
  prepareKimiMcpSession,
  prepareOpenCodeMcpSession,
  purgeStaleCliMcpSessions,
} from './cli-mcp-session-config';
import { ensureSkillsForCli } from './skill-mirror';
import { shouldUseEphemeralHome } from './spawn-home-policy';

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
const MAX_CONFIRMATION_ARGUMENTS_CHARS = 6_000;

let server: http.Server | null = null;
let port = 0;
let registry: McpRegistry | null = null;
const sessionTokens = new Map<string, string>(); // sessionId → token
const cliPromptAutoResponder = new CliPromptAutoResponder();
let httpConfirmationQueue: Promise<void> = Promise.resolve();

function boundedConfirmationArgs(args: Record<string, unknown>): string {
  const serialized = JSON.stringify(redactArgs(args), null, 2);
  if (serialized.length <= MAX_CONFIRMATION_ARGUMENTS_CHARS) return serialized;
  return `${serialized.slice(0, MAX_CONFIRMATION_ARGUMENTS_CHARS)}\n… [truncado]`;
}

async function showHttpMcpConfirmation(
  request: McpConfirmationRequest,
): Promise<boolean> {
  const result = await dialog.showMessageBox({
    type: 'warning',
    title: 'Nexus IDE — autorização do agente',
    buttons: ['Negar', 'Permitir'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    message: 'Permitir ação solicitada pelo agente?',
    detail:
      `Agente: ${request.agentLabel}\n` +
      `Ferramenta: ${request.toolName}\n` +
      `Workspace: ${request.workspaceId}\n` +
      `Motivo: ${request.reason}\n\n` +
      `Argumentos (segredos ocultos):\n${boundedConfirmationArgs(request.args)}`,
  });
  return result.response === 1;
}

const confirmHttpMcpTool: McpConfirmationHandler = (request) => {
  const pending = httpConfirmationQueue.then(() =>
    showHttpMcpConfirmation(request),
  );
  httpConfirmationQueue = pending.then(
    () => undefined,
    () => undefined,
  );
  return pending;
};

function mcpUrl(): string {
  return `http://127.0.0.1:${port}/mcp`;
}

function gateUrl(): string {
  return `http://127.0.0.1:${port}/gate`;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
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
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

function bearerContext(req: http.IncomingMessage): AgentGateContext | null {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  return getContext(header.slice('Bearer '.length).trim());
}

async function handleMcpRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: AgentGateContext,
): Promise<void> {
  if (req.method === 'GET') {
    // We do not push server-initiated messages; clients poll via POST.
    sendJson(res, 405, { error: 'SSE stream not supported' });
    return;
  }
  if (req.method === 'DELETE') {
    sendJson(res, 200, { ok: true });
    return;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'method not allowed' });
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readBody(req));
  } catch {
    sendJson(res, 400, {
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: 'parse error' },
    });
    return;
  }

  const messages = Array.isArray(parsed) ? parsed : [parsed];
  const responses = [];
  for (const message of messages) {
    if (!isJsonRpcRequest(message)) continue;
    const response = await handleMcpMessage(registry!, ctx, message, {
      confirm: confirmHttpMcpTool,
    });
    if (response) responses.push(response);
  }
  const headers = { 'mcp-session-id': ctx.token.slice(0, 16) };
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
    body = JSON.parse((await readBody(req)) || '{}') as GateBody;
  } catch {
    // Empty/invalid body — treat as a bare event.
  }
  switch (event) {
    case 'pretool': {
      const toolName = body.toolName ?? '';
      if (!toolName) {
        sendJson(res, 200, {
          allow: false,
          reason: 'hook omitted tool identity',
        });
        return;
      }
      if (toolName === 'Skill') {
        const skill = String(
          (body.toolInput as { skill?: unknown } | null)?.skill ?? '',
        );
        const allow = skill === '' || isSkillAllowed(ctx.allowedSkills, skill);
        sendJson(res, 200, {
          allow,
          reason: allow
            ? undefined
            : `skill "${skill}" is outside this agent's allowlist`,
        });
        return;
      }
      const allow = isHookToolAllowed(ctx.allowedTools, toolName);
      sendJson(res, 200, {
        allow,
        reason: allow
          ? undefined
          : `tool "${toolName}" is outside this agent's allowlist`,
      });
      return;
    }
    case 'posttool':
      sendJson(res, 200, { allow: true });
      return;
    case 'stop': {
      const verdict = evaluateStop(ctx);
      sendJson(res, 200, verdict);
      return;
    }
    default:
      sendJson(res, 404, { error: 'unknown gate event' });
  }
}

function buildMcpConfig(token: string): object {
  return {
    mcpServers: {
      nexus: {
        type: 'http',
        url: mcpUrl(),
        headers: { Authorization: `Bearer ${token}` },
      },
    },
  };
}

/** Wire per-agent spawn decoration: gate tokens, MCP config and skill mirrors. */
function installSpawnHook(): void {
  setAgentSpawnHook((adapter, req) => {
    const meta = req.orchRequestId
      ? getPendingSpawnMeta(req.orchRequestId)
      : null;
    const gated =
      (meta?.allowedTools ?? null) !== null ||
      (meta?.allowedSkills ?? null) !== null;
    const ctx = mintToken({
      label: meta?.agentName ?? adapter.label,
      role: meta?.role ?? 'user',
      missionId: meta?.missionId,
      agentName: meta?.agentName,
      allowedTools: meta?.allowedTools ?? null,
      allowedSkills: meta?.allowedSkills ?? null,
    });

    const env: Record<string, string> = {
      NEXUS_MCP_URL: mcpUrl(),
      NEXUS_MCP_TOKEN: ctx.token,
      NEXUS_GATE_URL: gateUrl(),
      NEXUS_GATE_TOKEN: ctx.token,
    };
    const extraArgs: string[] = [];
    let ephemeralHomeDir: string | null = null;
    let skillsPrepared = false;
    // Delegação VISÍVEL (benchmark §4.5): Claude recebe o hard-deny de Task
    // pelo adapter base, então o bloqueio vale para panes diretos e
    // orquestrados sem duplicar flags aqui.
    const mcpConfig = buildMcpConfig(ctx.token);

    try {
      if (shouldUseEphemeralHome(adapter, gated)) {
        const home = prepareEphemeralHome(ctx.token, mcpConfig);
        env.HOME = home.dir;
        ephemeralHomeDir = home.dir;
        extraArgs.push('--mcp-config', home.mcpConfigPath);
      } else if (adapter.quirks.mcpAutoload) {
        extraArgs.push(
          '--mcp-config',
          writeMcpConfigFile(ctx.token, mcpConfig),
        );
      }
      // CLIs não-Claude: injeta o servidor MCP DE VERDADE (não só env), para
      // que Codex/AGY chamem as tools nexus_* e submetam
      // handoff. Sem isto a orquestração era efetivamente Claude-cêntrica.
      if (!adapter.quirks.mcpAutoload) {
        const flavor = supportsMcpInjection(adapter);
        if (flavor) {
          // Create the real skill namespace before a provider-home overlay is
          // snapshotted so Kimi/Grok see it in this very session.
          ensureSkillsForCli(adapter.id, {
            allowedSkills: meta?.allowedSkills ?? null,
          });
          skillsPrepared = true;
        }
        if (flavor === 'codex') {
          extraArgs.push(...codexMcpArgs(mcpUrl(), ctx.token));
        } else if (flavor === 'agy') {
          // AGY 1.1 resolves its config through HOME (and newer builds may
          // honor GEMINI_CLI_HOME). Mirror skills first, then overlay both
          // variables with a per-session private config tree.
          const agyConfig = prepareAgyMcpConfig(mcpUrl(), ctx.token);
          env.HOME = agyConfig.homeDir;
          env.GEMINI_CLI_HOME = agyConfig.geminiHomeDir;
        } else if (flavor === 'opencode') {
          const prepared = prepareOpenCodeMcpSession(mcpUrl(), ctx.token);
          Object.assign(env, prepared.env);
          extraArgs.push(...prepared.extraArgs);
        } else if (flavor === 'kimi') {
          const prepared = prepareKimiMcpSession(mcpUrl(), ctx.token);
          Object.assign(env, prepared.env);
          extraArgs.push(...prepared.extraArgs);
        } else if (flavor === 'grok') {
          const prepared = prepareGrokMcpSession(mcpUrl(), ctx.token);
          Object.assign(env, prepared.env);
          extraArgs.push(...prepared.extraArgs);
        }
      }
      if (!skillsPrepared) {
        ensureSkillsForCli(adapter.id, {
          allowedSkills: meta?.allowedSkills ?? null,
          ephemeralHomeDir,
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
  });
}

/** Legacy `### NEXUS_HANDOFF v1` stream fallback (ARCHITECTURE §E.3). */
function installLegacyParser(): void {
  const dedupe = new LegacyHandoffDedupe();
  const parser = new LegacyHandoffParser((sessionId, payload) => {
    // O eco/repaint do kickoff contém o bloco-EXEMPLO do contrato — sem esta
    // régua (a mesma da tool MCP), o template "<resumo objetivo do que fez>"
    // virava handoff real em loop no orquestrador.
    if (isPlaceholderSummary(payload.summary)) {
      console.log(
        `[handoff] bloco legacy com summary placeholder ignorado (${sessionId})`,
      );
      return;
    }
    // Repaint do TUI re-emite o MESMO bloco — uma entrega só por conteúdo.
    if (dedupe.isDuplicate(sessionId, payload)) return;
    const ctx = getContextBySession(sessionId);
    const handoff = submitHandoff({
      status: payload.status,
      summary: payload.summary,
      artifacts: payload.artifacts,
      missionId: ctx?.missionId,
      sessionId,
      fromAgent: ctx?.agentName ?? ctx?.label ?? 'legacy',
    });
    if (ctx) ctx.handoffSubmitted = true;
    onHandoffSubmitted(handoff);
  });
  // Prefiltro: stripAnsi + parse custam ~104ms/10k chunks e rodavam em TODO
  // output de PTY. Só paga quando o chunk pode conter o marker (tail cru curto
  // cobre marker dividido entre chunks) ou quando um bloco já está aberto.
  const rawTails = new Map<string, string>();
  const MARKER_HINT = 'NEXUS_HANDOFF';
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
    const tail = rawTails.get(sessionId) ?? '';
    const probe = tail + data;
    rawTails.set(sessionId, probe.slice(-32));
    if (!parser.isCollecting(sessionId) && !probe.includes(MARKER_HINT)) {
      return;
    }
    parser.feed(sessionId, plain ?? stripAnsi(data));
  });
  tapSessionExit((sessionId) => {
    cliPromptAutoResponder.unbind(sessionId);
    parser.dropSession(sessionId);
    dedupe.dropSession(sessionId);
    rawTails.delete(sessionId);
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
  const staleAgy = purgeStaleAgyMcpConfigs();
  const staleCli = purgeStaleCliMcpSessions();
  const removedArtifacts = staleAgy.removed + staleCli.removed;
  const failedArtifacts = staleAgy.failed + staleCli.failed;
  if (removedArtifacts > 0) {
    console.log(`[orch] removed ${removedArtifacts} stale MCP artifact(s)`);
  }
  if (failedArtifacts > 0 || staleAgy.truncated || staleCli.truncated) {
    console.warn(
      '[orch] stale MCP artifact purge was incomplete',
      {
        failed: failedArtifacts,
        truncated: staleAgy.truncated || staleCli.truncated,
      },
    );
  }
  registry = {
    tools: buildToolset(),
    serverName: 'nexus-ide',
    serverVersion: app.getVersion(),
  };
  installSpawnHook();
  installLegacyParser();

  server = http.createServer((req, res) => {
    void (async () => {
      const url = req.url ?? '';
      const ctx = bearerContext(req);
      if (!ctx) {
        sendJson(res, 401, { error: 'missing or unknown bearer token' });
        return;
      }
      if (url === '/mcp' || url.startsWith('/mcp?')) {
        await handleMcpRequest(req, res, ctx);
        return;
      }
      const gateMatch = /^\/gate\/([a-z]+)$/.exec(url);
      if (gateMatch && req.method === 'POST') {
        await handleGateRequest(req, res, ctx, gateMatch[1]);
        return;
      }
      sendJson(res, 404, { error: 'not found' });
    })().catch((err) => {
      console.warn('[orch] MCP request failed:', err);
      try {
        sendJson(res, 500, { error: 'internal error' });
      } catch {
        // Response already started — nothing to salvage.
      }
    });
  });

  return new Promise((resolve) => {
    server!.listen(0, '127.0.0.1', () => {
      port = (server!.address() as AddressInfo).port;
      console.log(`[orch] embedded MCP server on ${mcpUrl()}`);
      resolve();
    });
  });
}

export function stopMcpServer(): void {
  setAgentSpawnHook(null);
  cliPromptAutoResponder.clear();
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
