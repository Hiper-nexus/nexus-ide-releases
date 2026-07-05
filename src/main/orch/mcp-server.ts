import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { app } from 'electron';
import type { McpRuntimeInfo } from '../../shared/orch-types';
import {
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
  isToolAllowed,
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
import { buildToolset } from './tools';
import { getPendingSpawnMeta, stripAnsi } from './pane-registry';
import { LegacyHandoffParser } from './legacy-handoff';
import { submitHandoff } from './handoff-store';
import { onHandoffSubmitted } from './idle-delivery';
import {
  cleanupSessionArtifacts,
  prepareEphemeralHome,
  writeMcpConfigFile,
} from './hooks-gen';

/**
 * Embedded MCP server (docs/ARCHITECTURE.md §E.2): a localhost HTTP endpoint
 * speaking MCP streamable-HTTP JSON-RPC, exposing the nexus_* tools to the
 * CLI agents running inside PTY panes. The same server hosts the /gate/*
 * endpoints used by the client-side skill-gate hooks.
 *
 * Every agent session gets its own bearer token bound to its allowlists —
 * authentication is per-agent, the port never leaves 127.0.0.1.
 */

const MAX_BODY_BYTES = 2_097_152;

let server: http.Server | null = null;
let port = 0;
let registry: McpRegistry | null = null;
const sessionTokens = new Map<string, string>(); // sessionId → token

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
    const response = await handleMcpMessage(registry!, ctx, message);
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
        sendJson(res, 200, { allow: true });
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
      const allow = isToolAllowed(ctx.allowedTools, toolName);
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

/** Wire the per-agent spawn decoration (tokens, gate env, ephemeral HOME). */
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
    // Delegação VISÍVEL (benchmark §4.5): panes orquestrados do claude não
    // podem abrir subagentes invisíveis (tool Task) — todo trabalho entre
    // agentes passa por panes reais + handoff, onde há autorização, telemetria
    // e watchdog. Panes abertos diretamente pelo usuário (sem meta) ficam
    // livres: o Task deles age em nome do próprio usuário.
    if (meta && adapter.id === 'claude') {
      extraArgs.push('--disallowedTools', 'Task');
    }
    const mcpConfig = buildMcpConfig(ctx.token);

    try {
      if (gated || adapter.env.ephemeralHome) {
        const home = prepareEphemeralHome(ctx.token, mcpConfig);
        env.HOME = home.dir;
        if (adapter.quirks.mcpAutoload) {
          extraArgs.push('--mcp-config', home.mcpConfigPath);
        }
      } else if (adapter.quirks.mcpAutoload) {
        extraArgs.push(
          '--mcp-config',
          writeMcpConfigFile(ctx.token, mcpConfig),
        );
      }
    } catch (err) {
      console.warn('[orch] failed to prepare agent home/config:', err);
    }

    const decoration: AgentSpawnDecoration = {
      env,
      extraArgs,
      onSpawned: (sessionId) => {
        bindTokenToSession(ctx.token, sessionId);
        sessionTokens.set(sessionId, ctx.token);
      },
      onSpawnFailed: () => {
        // No session will ever exist for this token — drop it from the auth
        // registry and remove any token-bearing files we wrote.
        releaseSessionByToken(ctx.token);
        cleanupSessionArtifacts(ctx.token);
      },
    };
    return decoration;
  });
}

/** Legacy `### NEXUS_HANDOFF v1` stream fallback (ARCHITECTURE §E.3). */
function installLegacyParser(): void {
  const parser = new LegacyHandoffParser((sessionId, payload) => {
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
    const tail = rawTails.get(sessionId) ?? '';
    const probe = tail + data;
    rawTails.set(sessionId, probe.slice(-32));
    if (!parser.isCollecting(sessionId) && !probe.includes(MARKER_HINT)) {
      return;
    }
    parser.feed(sessionId, stripAnsi(data));
  });
  tapSessionExit((sessionId) => {
    parser.dropSession(sessionId);
    rawTails.delete(sessionId);
    const token = sessionTokens.get(sessionId);
    if (token) {
      sessionTokens.delete(sessionId);
      cleanupSessionArtifacts(token);
    }
    releaseSession(sessionId);
  });
}

export function startMcpServer(): Promise<void> {
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
