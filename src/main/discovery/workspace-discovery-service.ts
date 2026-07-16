/**
 * Descoberta universal de configs de ecossistemas de agente por workspace
 * (integração oh-my-pi × NexusIDE, entrega B4).
 *
 * Orquestra a camada vendorada (src/vendor/omp/discovery) e devolve o
 * inventário tipado com zod: MCP servers, context/rule files, skills e slash
 * commands, cada item com {source, level, path, name} e dedup por prioridade
 * de ecossistema (claude 80 > codex 70 > gemini 60 > cursor 50 > …).
 *
 * Cache por mtime: cada varredura grava o fingerprint dos caminhos tocados;
 * a chamada seguinte só re-stata esse conjunto (barato) e reusa o resultado
 * quando nada mudou. Varredura restrita a workspaceRoot + home do usuário,
 * com limite de profundidade e sem node_modules (ver fs-probe.ts).
 *
 * Segurança: valores de env/headers podem ser segredos — nunca são logados
 * aqui nem na camada vendorada; a superfície de UI recebe a versão mascarada
 * via maskWorkspaceDiscoveryForUi (mesma convenção do mcp-hub).
 */
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { normalizeMcpServerKey } from '../../shared/mcp-across-tools';
import {
  DISCOVERY_SOURCES,
  FsProbe,
  discoverConfigs,
  fingerprintStillValid,
  type FsFingerprint,
} from '../../vendor/omp/discovery';
import {
  maskSecretsInValue,
  mcpHubServerSchema,
  type McpHubServer,
} from '../mcp-hub/mcp-hub-core';

// =============================================================================
// Schemas (zod) — contrato do serviço e do canal IPC
// =============================================================================

export const discoverySourceSchema = z.enum(DISCOVERY_SOURCES);
export const discoveryLevelSchema = z.enum(['user', 'project']);

const itemMetaShape = {
  source: discoverySourceSchema,
  level: discoveryLevelSchema,
  path: z.string().min(1).max(4096),
  name: z.string().min(1).max(512),
} as const;

export const discoveredMcpServerSchema = z
  .object({
    ...itemMetaShape,
    command: z.string().max(4096).optional(),
    args: z.array(z.string().max(4096)).max(128).optional(),
    env: z.record(z.string().max(256), z.string().max(8192)).optional(),
    cwd: z.string().max(4096).optional(),
    url: z.string().max(4096).optional(),
    headers: z.record(z.string().max(256), z.string().max(8192)).optional(),
    transport: z.enum(['stdio', 'sse', 'http']).optional(),
    timeout: z.number().nonnegative().finite().optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

export const discoveredContextFileSchema = z
  .object({
    ...itemMetaShape,
    kind: z.enum(['context', 'rule']),
  })
  .strict();

export const discoveredSkillSchema = z
  .object({
    ...itemMetaShape,
    description: z.string().max(4096).optional(),
  })
  .strict();

export const discoveredCommandSchema = z.object(itemMetaShape).strict();

export const workspaceDiscoveryResultSchema = z
  .object({
    workspaceRoot: z.string().min(1).max(4096),
    mcpServers: z.array(discoveredMcpServerSchema).max(256),
    contextFiles: z.array(discoveredContextFileSchema).max(1024),
    skills: z.array(discoveredSkillSchema).max(1024),
    commands: z.array(discoveredCommandSchema).max(2048),
    /** Avisos de parse/leitura — só caminhos/chaves, nunca valores. */
    warnings: z.array(z.string().max(1024)).max(256),
    discoveredAt: z.number(),
  })
  .strict();

export type DiscoveredMcpServer = z.infer<typeof discoveredMcpServerSchema>;
export type DiscoveredContextFile = z.infer<typeof discoveredContextFileSchema>;
export type DiscoveredSkill = z.infer<typeof discoveredSkillSchema>;
export type DiscoveredCommand = z.infer<typeof discoveredCommandSchema>;
export type WorkspaceDiscoveryResult = z.infer<
  typeof workspaceDiscoveryResultSchema
>;

// =============================================================================
// Serviço com cache por mtime
// =============================================================================

export interface DiscoverWorkspaceOptions {
  /** Home alternativa (testes). Default: os.homedir(). */
  home?: string;
  /** Ambiente para expansão de ${VAR} nos configs. Default: process.env. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Ignora o cache e revarre (raro; o fingerprint já invalida sozinho). */
  force?: boolean;
}

interface CacheEntry {
  fingerprint: FsFingerprint;
  result: WorkspaceDiscoveryResult;
}

const cache = new Map<string, CacheEntry>();

function cacheKey(workspaceRoot: string, home: string): string {
  return `${workspaceRoot}\u0000${home}`;
}

/** Filtra itens inválidos individualmente (fail-soft) sem derrubar o todo. */
function sanitizeItems<S extends z.ZodTypeAny>(
  schema: S,
  items: readonly unknown[],
  max: number,
  warnings: string[],
  label: string,
): Array<z.infer<S>> {
  const out: Array<z.infer<S>> = [];
  for (const item of items) {
    if (out.length >= max) break;
    const parsed = schema.safeParse(item);
    if (parsed.success) {
      out.push(parsed.data as z.infer<S>);
    } else {
      // Aviso sem o conteúdo do item (pode conter segredos) — só a categoria.
      warnings.push(`item de ${label} inválido descartado`);
    }
  }
  return out;
}

/**
 * Descobre os configs de ecossistemas de agente do workspace.
 * Síncrono por consistência com o restante do main (mcp-hub, skills-catalog);
 * o conjunto varrido é pequeno e limitado (workspaceRoot + home, sem
 * node_modules, profundidade limitada).
 */
export function discoverWorkspaceConfigs(
  workspaceRoot: string,
  options: DiscoverWorkspaceOptions = {},
): WorkspaceDiscoveryResult {
  if (!path.isAbsolute(workspaceRoot)) {
    throw new Error('workspaceRoot deve ser um caminho absoluto');
  }
  const root = path.resolve(workspaceRoot);
  const home = path.resolve(options.home ?? os.homedir());
  const key = cacheKey(root, home);

  const cached = cache.get(key);
  if (cached && !options.force && fingerprintStillValid(cached.fingerprint)) {
    return cached.result;
  }

  const io = new FsProbe();
  const raw = discoverConfigs({
    workspaceRoot: root,
    home,
    env: options.env ?? process.env,
    io,
  });

  const warnings = raw.warnings.slice(0, 240);
  const result = workspaceDiscoveryResultSchema.parse({
    workspaceRoot: root,
    mcpServers: sanitizeItems(
      discoveredMcpServerSchema,
      raw.mcpServers,
      256,
      warnings,
      'mcpServers',
    ),
    contextFiles: sanitizeItems(
      discoveredContextFileSchema,
      raw.contextFiles,
      1024,
      warnings,
      'contextFiles',
    ),
    skills: sanitizeItems(
      discoveredSkillSchema,
      raw.skills,
      1024,
      warnings,
      'skills',
    ),
    commands: sanitizeItems(
      discoveredCommandSchema,
      raw.commands,
      2048,
      warnings,
      'commands',
    ),
    warnings: warnings.slice(0, 256),
    discoveredAt: Date.now(),
  });

  cache.set(key, { fingerprint: io.fingerprint(), result });
  return result;
}

/** Limpa o cache (um workspace ou todos) — útil em testes e pós-escritas. */
export function invalidateWorkspaceDiscoveryCache(workspaceRoot?: string): void {
  if (workspaceRoot === undefined) {
    cache.clear();
    return;
  }
  const root = path.resolve(workspaceRoot);
  for (const key of [...cache.keys()]) {
    if (key.startsWith(`${root}\u0000`)) cache.delete(key);
  }
}

// =============================================================================
// Máscara de segredos para a UI (mesma convenção do mcp-hub-core)
// =============================================================================

/** Mesmo padrão do SECRET_KEY do mcp-hub-core (não exportado lá). */
const SECRET_KEY = /(token|secret|password|api[_-]?key|authorization|credential)/i;

function maskSecretRecord(
  record: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!record) return record;
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [
      key,
      SECRET_KEY.test(key) ? maskSecretsInValue(value) : value,
    ]),
  );
}

/**
 * Versão segura para o renderer: valores de env/headers com chave que parece
 * segredo são mascarados. Nunca muta o resultado cacheado.
 */
export function maskWorkspaceDiscoveryForUi(
  result: WorkspaceDiscoveryResult,
): WorkspaceDiscoveryResult {
  return {
    ...result,
    mcpServers: result.mcpServers.map((server) => ({
      ...server,
      ...(server.env !== undefined
        ? { env: maskSecretRecord(server.env) }
        : {}),
      ...(server.headers !== undefined
        ? { headers: maskSecretRecord(server.headers) }
        : {}),
    })),
  };
}

// =============================================================================
// Ponto de consumo para o MCP Hub (feature.mcp.hub)
// =============================================================================

const HUB_SOURCE_BY_DISCOVERY: Partial<
  Record<DiscoveredMcpServer['source'], McpHubServer['source']>
> = {
  claude: 'claude-code',
  codex: 'codex',
  cursor: 'cursor',
  opencode: 'opencode',
};

/**
 * Lista os MCP servers descobertos no formato canônico do hub
 * (mcpHubServerSchema), prontos para merge no `.nexus/mcp-hub.json`.
 *
 * PENDÊNCIA (integração hub): o fluxo de import do hub hoje é
 * collectObservedHubServers (mcp-hub-sync.ts), que só observa configs de
 * HOME. Ligar este inventário por-workspace no planMcpSync/applyMcpSync
 * exigiria mudar a semântica de import do hub (dedupe entre home e workspace,
 * origem do backup, escopo do fill-gaps) — mudança profunda, fora da B4.
 * Esta função deixa o formato pronto; o hub pode chamá-la quando o fluxo de
 * import ganhar suporte a fontes workspace-level.
 */
export function listDiscoveredMcpServersForHub(
  workspaceRoot: string,
  options: DiscoverWorkspaceOptions = {},
): McpHubServer[] {
  const { mcpServers } = discoverWorkspaceConfigs(workspaceRoot, options);
  const out: McpHubServer[] = [];
  const seen = new Set<string>();

  for (const server of mcpServers) {
    if (out.length >= 64) break; // teto do mcpHubConfigSchema
    const id = normalizeMcpServerKey(server.name);
    if (!id || seen.has(id)) continue;
    if (!server.command && !server.url) continue;

    const transport: McpHubServer['transport'] =
      server.transport === 'sse'
        ? 'sse-legacy'
        : server.url && !server.command
          ? 'streamable-http'
          : 'stdio';

    const candidate = {
      id,
      name: server.name.slice(0, 256),
      transport,
      ...(server.command ? { command: server.command.slice(0, 4096) } : {}),
      ...(server.args
        ? { args: server.args.slice(0, 64).map((a) => a.slice(0, 1024)) }
        : {}),
      ...(server.url ? { url: server.url.slice(0, 4096) } : {}),
      ...(server.env ? { env: boundedRecord(server.env) } : {}),
      ...(server.headers ? { headers: boundedRecord(server.headers) } : {}),
      tools: [],
      source: HUB_SOURCE_BY_DISCOVERY[server.source] ?? 'other',
    };

    const parsed = mcpHubServerSchema.safeParse(candidate);
    if (!parsed.success) continue; // fail-soft: entrada fora do contrato do hub
    seen.add(id);
    out.push(parsed.data);
  }

  return out;
}

/** Copia limitada aos tetos do hub (chave 128 / valor 4096). */
function boundedRecord(
  record: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    if (key.length === 0 || key.length > 128) continue;
    out[key] = value.slice(0, 4096);
  }
  return out;
}
