import { validateHeaderName, validateHeaderValue } from 'node:http';
import path from 'node:path';
import { z } from 'zod';
import { MCP_MANIFEST_SCHEMA, SUPPORTED_PLUGIN_SPEC } from './agent-plugin-manifest';

const MAX_MCP_SERVERS = 64;
const MAX_ARGS = 64;
const BARE_EXECUTABLE = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
const SECRET_HEADER =
  /^(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|x-auth-token)$/i;
const SECRET_ENV = /(?:token|secret|password|api[_-]?key|credential)/i;

const stdioSchema = z
  .object({
    type: z.literal('stdio'),
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    cwd: z.string().optional(),
  })
  .strict();

const remoteSchema = z
  .object({
    type: z.enum(['streamable-http', 'sse']),
    url: z.string().min(1),
    headers: z.record(z.string(), z.string()).optional(),
  })
  .strict();

export interface AgentPluginMcpNotice {
  readonly component: 'mcpServers';
  readonly entry: string;
  readonly why: string;
}

interface AgentPluginMcpBase {
  readonly name: string;
  readonly activation: 'explicit-user-action';
  readonly permissionGate: 'PreToolUse';
}

export interface AgentPluginStdioServer extends AgentPluginMcpBase {
  readonly transport: 'stdio';
  readonly command: string;
  readonly args?: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
}

export interface AgentPluginRemoteServer extends AgentPluginMcpBase {
  readonly transport: 'streamable-http' | 'sse';
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
}

export type AgentPluginMcpServer =
  | AgentPluginStdioServer
  | AgentPluginRemoteServer;

export type AgentPluginMcpVerdict =
  | {
      readonly ok: true;
      readonly servers: readonly AgentPluginMcpServer[];
      readonly degraded: readonly AgentPluginMcpNotice[];
    }
  | { readonly ok: false; readonly reason: string };

export interface AgentPluginMcpContext {
  readonly pluginRoot: string;
  readonly pluginDataRoot: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function expandPluginVariables(value: string, context: AgentPluginMcpContext): string {
  return value.replace(
    /\$\{PLUGIN_ROOT\}|\$\{PLUGIN_DATA\}/g,
    (placeholder) =>
      placeholder === '${PLUGIN_ROOT}'
        ? context.pluginRoot
        : context.pluginDataRoot,
  );
}

function resolvedCwd(
  value: string | undefined,
  context: AgentPluginMcpContext,
): string | null {
  if (value === undefined) return context.pluginRoot;
  let root: string;
  let suffix: string;
  if (value.startsWith('./')) {
    root = context.pluginRoot;
    suffix = value.slice(2);
  } else if (value === '${PLUGIN_ROOT}' || value.startsWith('${PLUGIN_ROOT}/')) {
    root = context.pluginRoot;
    suffix = value.slice('${PLUGIN_ROOT}'.length).replace(/^\//, '');
  } else if (value === '${PLUGIN_DATA}' || value.startsWith('${PLUGIN_DATA}/')) {
    root = context.pluginDataRoot;
    suffix = value.slice('${PLUGIN_DATA}'.length).replace(/^\//, '');
  } else {
    return null;
  }
  const resolved = path.resolve(root, suffix);
  return isInside(root, resolved) ? resolved : null;
}

function resolvedCommand(command: string, pluginRoot: string): string | null {
  if (/[\u0000-\u001f\u007f]/.test(command)) return null;
  if (command.startsWith('./')) {
    const resolved = path.resolve(pluginRoot, command.slice(2));
    return isInside(pluginRoot, resolved) ? resolved : null;
  }
  return BARE_EXECUTABLE.test(command) ? command : null;
}

function zodReason(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'entrada fora do schema MCP v1.0.0';
  const field = issue.path.length > 0 ? issue.path.join('.') : 'server';
  return `${field}: ${issue.message}`;
}

function readStdioServer(
  name: string,
  raw: unknown,
  context: AgentPluginMcpContext,
): AgentPluginMcpServer | string {
  const parsed = stdioSchema.safeParse(raw);
  if (!parsed.success) return zodReason(parsed.error);
  if ((parsed.data.args?.length ?? 0) > MAX_ARGS) {
    return `args excede o limite Nexus de ${MAX_ARGS}`;
  }
  if (
    parsed.data.env &&
    Object.keys(parsed.data.env).some(
      (key) => key === 'PLUGIN_ROOT' || key === 'PLUGIN_DATA',
    )
  ) {
    return 'env tenta sobrescrever PLUGIN_ROOT ou PLUGIN_DATA';
  }
  if (
    parsed.data.env &&
    Object.entries(parsed.data.env).some(
      ([key, value]) => SECRET_ENV.test(key) && value.length > 0,
    )
  ) {
    return 'env contém credencial embutida; segredos devem ser geridos pelo cliente';
  }
  const command = resolvedCommand(parsed.data.command, context.pluginRoot);
  if (!command) return 'command deve ser um executável único, bare ou iniciado por ./' ;
  const cwd = resolvedCwd(parsed.data.cwd, context);
  if (!cwd) return 'cwd inválido ou fora de PLUGIN_ROOT/PLUGIN_DATA';

  const configuredEnv = Object.fromEntries(
    Object.entries(parsed.data.env ?? {}).map(([key, value]) => [
      key,
      expandPluginVariables(value, context),
    ]),
  );
  return Object.freeze({
    name,
    transport: 'stdio' as const,
    command,
    ...(parsed.data.args
      ? {
          args: Object.freeze(
            parsed.data.args.map((arg) => expandPluginVariables(arg, context)),
          ),
        }
      : {}),
    env: Object.freeze({
      ...configuredEnv,
      PLUGIN_ROOT: context.pluginRoot,
      PLUGIN_DATA: context.pluginDataRoot,
    }),
    cwd,
    activation: 'explicit-user-action' as const,
    permissionGate: 'PreToolUse' as const,
  });
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '::1' || host === '0:0:0:0:0:0:0:1') {
    return true;
  }
  if (/^127(?:\.\d{1,3}){3}$/.test(host)) return true;
  return /^::ffff:127(?:\.\d{1,3}){3}$/.test(host);
}

function validateRemoteUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'url não é absoluta';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return 'url deve usar HTTP ou HTTPS';
  }
  if (url.username || url.password) return 'url não pode conter credenciais';
  if (url.hash) return 'url não pode conter fragmento';
  if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) {
    return 'HTTP sem TLS só é permitido em localhost/loopback';
  }
  return null;
}

function validateHeaders(headers: Record<string, string> | undefined): string | null {
  if (!headers) return null;
  const seen = new Set<string>();
  for (const [name, value] of Object.entries(headers)) {
    const folded = name.toLowerCase();
    if (seen.has(folded)) return `header duplicado sem diferenciar caixa: ${name}`;
    seen.add(folded);
    if (SECRET_HEADER.test(name)) {
      return `header ${name} contém credencial embutida`;
    }
    try {
      validateHeaderName(name);
      validateHeaderValue(name, value);
    } catch {
      return `header HTTP inválido: ${name}`;
    }
  }
  return null;
}

function readRemoteServer(name: string, raw: unknown): AgentPluginMcpServer | string {
  const parsed = remoteSchema.safeParse(raw);
  if (!parsed.success) return zodReason(parsed.error);
  const urlError = validateRemoteUrl(parsed.data.url);
  if (urlError) return urlError;
  const headerError = validateHeaders(parsed.data.headers);
  if (headerError) return headerError;
  return Object.freeze({
    name,
    transport: parsed.data.type,
    url: parsed.data.url,
    ...(parsed.data.headers
      ? { headers: Object.freeze({ ...parsed.data.headers }) }
      : {}),
    activation: 'explicit-user-action' as const,
    permissionGate: 'PreToolUse' as const,
  });
}

function readServer(
  name: string,
  raw: unknown,
  context: AgentPluginMcpContext,
): AgentPluginMcpServer | string {
  if (!isRecord(raw)) return 'entrada não é um objeto';
  if (raw.type === 'stdio') return readStdioServer(name, raw, context);
  if (raw.type === 'streamable-http' || raw.type === 'sse') {
    return readRemoteServer(name, raw);
  }
  return `transporte não suportado ou desconhecido: ${String(raw.type)}`;
}

export function readAgentPluginMcp(
  raw: unknown,
  context: AgentPluginMcpContext,
): AgentPluginMcpVerdict {
  if (!isRecord(raw)) return { ok: false, reason: 'mcp.json não é objeto JSON' };
  if (raw.$schema !== MCP_MANIFEST_SCHEMA) {
    const requested =
      typeof raw.$schema === 'string'
        ? /\/schemas\/([^/]+)\/mcp\.schema\.json$/.exec(raw.$schema)?.[1] ?? raw.$schema
        : typeof raw.$schema;
    return {
      ok: false,
      reason: `mcp.json exige ${requested}; Nexus fixa Agent Plugins ${SUPPORTED_PLUGIN_SPEC}`,
    };
  }
  const unknown = Object.keys(raw).filter(
    (key) => key !== '$schema' && key !== 'mcpServers',
  );
  if (unknown.length > 0) {
    return { ok: false, reason: `campo raiz desconhecido em mcp.json: ${unknown[0]}` };
  }
  if (!isRecord(raw.mcpServers)) {
    return { ok: false, reason: 'mcp.json.mcpServers não é objeto' };
  }

  const servers: AgentPluginMcpServer[] = [];
  const degraded: AgentPluginMcpNotice[] = [];
  for (const [index, [name, serverRaw]] of Object.entries(raw.mcpServers).entries()) {
    if (index >= MAX_MCP_SERVERS) {
      degraded.push({
        component: 'mcpServers',
        entry: name,
        why: `servidor ignorado: limite Nexus de ${MAX_MCP_SERVERS}`,
      });
      continue;
    }
    if (!name || name.length > 256) {
      degraded.push({
        component: 'mcpServers',
        entry: name || '(nome vazio)',
        why: 'nome não pode ser vazio nem exceder 256 caracteres no Nexus',
      });
      continue;
    }
    const parsed = readServer(name, serverRaw, context);
    if (typeof parsed === 'string') {
      degraded.push({ component: 'mcpServers', entry: name, why: parsed });
      continue;
    }
    servers.push(parsed);
  }
  return Object.freeze({
    ok: true,
    servers: Object.freeze(servers),
    degraded: Object.freeze(degraded),
  });
}
