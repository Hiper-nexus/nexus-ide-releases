import fs from 'node:fs';
import path from 'node:path';
import {
  isMaskedSecretValue,
  mcpHubConfigSchema,
  type McpHubServer,
  type McpHubTransport,
} from './mcp-hub-core';
import { isSecretFieldName, isVaultRef } from './mcp-hub-secrets';

/**
 * O hub (`<workspace>/.nexus/mcp-hub.json`) era um registro morto: ninguém
 * lia fora do IPC de Settings. Como todo pane de missão nasce com
 * `--strict-mcp-config` / `--pure`, o agente ficava sem os MCPs que o operador
 * declarou E sem os MCPs ambientes do CLI — ou seja, sincronizar não concedia
 * nada.
 *
 * Este módulo é o ÚNICO caminho de leitura do hub no spawn. Ele materializa os
 * servidores do hub no MESMO config por sessão que o hook de spawn já gera,
 * ao lado do `nexus`. Invariantes:
 *
 * - fonte de verdade é só o arquivo do hub: nada do config ambiente do
 *   operador (Cursor/Claude Code/Codex/...) é lido aqui;
 * - o isolamento continua exatamente como hoje (`--strict-mcp-config`,
 *   `--pure`, strip do ambiente do Codex) — o que muda é o CONTEÚDO gerado;
 * - hub quebrado/ausente/malformado degrada para o comportamento de hoje
 *   (só `nexus`); nenhum spawn falha por causa do hub;
 * - segredos (`env`/`headers`) nunca são logados e nunca entram em argv.
 */

/** Teto de leitura: o schema já limita 64 servidores e o tamanho dos campos. */
const MAX_HUB_FILE_BYTES = 1_048_576;

/** Espelha `mcpHubConfigSchema.servers.max(64)` — cap explícito no spawn. */
export const MCP_HUB_SPAWN_MAX_SERVERS = 64;

/** Namespace reservado ao servidor embutido (`nexus`, `nexus_<hex>`). */
const RESERVED_SERVER_PREFIX = 'nexus';

/** Chaves seguras em TOML/argv com caminho pontilhado e em JSON. */
const SAFE_KEY = /^[A-Za-z0-9_-]+$/;

const MAX_SERVER_KEY_LENGTH = 64;

export interface McpHubSpawnServer {
  /** Chave já saneada, usada como nome do servidor em todo adapter. */
  readonly key: string;
  readonly transport: McpHubTransport;
  readonly command?: string;
  readonly args: readonly string[];
  readonly url?: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly env: Readonly<Record<string, string>>;
}

function hubFilePath(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.nexus', 'mcp-hub.json');
}

/**
 * Sanea o id para uma chave estável. Ids do hub vêm de configs de terceiros
 * (`io.github.owner/server`, `chrome-devtools`), então normalizamos em vez de
 * descartar. Colisões pós-saneamento são resolvidas pelo primeiro (ordem do
 * arquivo) para manter o resultado determinístico.
 */
function serverKeyOf(id: string): string | null {
  const key = id
    .replace(/[^A-Za-z0-9_-]/g, '_')
    .slice(0, MAX_SERVER_KEY_LENGTH);
  if (key.length === 0) return null;
  // O servidor embutido ocupa `nexus` e `nexus_<hex>`: um servidor do hub
  // jamais pode sobrescrever a única porta de entrada das tools nexus_*.
  if (key.toLowerCase().startsWith(RESERVED_SERVER_PREFIX)) return null;
  return key;
}

/**
 * Valores que não são segredo real são preservados; refs de cofre
 * (`__nexus_vault__:…`) e placeholders de máscara da UI nunca são escritos em
 * config gerado — seriam credenciais inúteis e vazariam o nome da chave.
 */
function sanitizeRecord(
  record: Record<string, string> | undefined,
): Record<string, string> {
  if (!record) return {};
  const next: Record<string, string> = {};
  for (const key of Object.keys(record).sort()) {
    const value = record[key]!;
    if (!SAFE_KEY.test(key)) continue;
    if (value.length === 0) continue;
    if (isVaultRef(value) || isMaskedSecretValue(value)) continue;
    next[key] = value;
  }
  return next;
}

function toSpawnServer(server: McpHubServer): McpHubSpawnServer | null {
  const key = serverKeyOf(server.id);
  if (!key) return null;
  const command = server.command?.trim() || undefined;
  const url = server.url?.trim() || undefined;
  // Sem command E sem url não há nada para o CLI conectar.
  if (!command && !url) return null;
  return {
    key,
    transport: server.transport,
    ...(command ? { command } : {}),
    args: Object.freeze([...(server.args ?? [])]),
    ...(url ? { url } : {}),
    headers: Object.freeze(sanitizeRecord(server.headers)),
    env: Object.freeze(sanitizeRecord(server.env)),
  };
}

/** True quando o servidor deve ser declarado como processo local (stdio). */
function isStdioHubServer(server: McpHubSpawnServer): boolean {
  if (server.transport === 'stdio') return Boolean(server.command);
  return !server.url && Boolean(server.command);
}

/**
 * Lê o hub do workspace e devolve os servidores prontos para materialização.
 * Nunca lança: qualquer falha (ausente, symlink, JSON inválido, schema fora do
 * contrato) devolve lista vazia — o pane volta ao comportamento de hoje.
 */
export function loadMcpHubServersForSpawn(
  workspaceRoot: string | undefined | null,
): readonly McpHubSpawnServer[] {
  if (!workspaceRoot || !path.isAbsolute(workspaceRoot)) return [];
  try {
    const file = hubFilePath(workspaceRoot);
    // lstat (não stat): um `.nexus` ou `mcp-hub.json` symlinkado não pode
    // redirecionar a leitura para fora do workspace.
    if (!fs.lstatSync(path.dirname(file)).isDirectory()) return [];
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > MAX_HUB_FILE_BYTES) return [];
    const config = mcpHubConfigSchema.parse(
      JSON.parse(fs.readFileSync(file, 'utf8')),
    );
    const byKey = new Map<string, McpHubSpawnServer>();
    for (const server of config.servers) {
      const prepared = toSpawnServer(server);
      // Primeiro vence: duas entradas que saneiam para a mesma chave não podem
      // produzir configs diferentes conforme a ordem de iteração.
      if (prepared && !byKey.has(prepared.key)) byKey.set(prepared.key, prepared);
    }
    return Object.freeze(
      [...byKey.values()]
        .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
        .slice(0, MCP_HUB_SPAWN_MAX_SERVERS),
    );
  } catch {
    // Hub quebrado nunca derruba um spawn: degrada para só `nexus`.
    return [];
  }
}

/**
 * Entradas no formato `.mcp.json` do Claude (também aceito pelo Kimi).
 * O chamador faz o spread ANTES da entrada `nexus`, que sempre vence.
 */
export function claudeFamilyHubMcpServers(
  servers: readonly McpHubSpawnServer[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const server of servers) {
    out[server.key] = isStdioHubServer(server)
      ? {
          type: 'stdio',
          command: server.command,
          ...(server.args.length > 0 ? { args: [...server.args] } : {}),
          ...(Object.keys(server.env).length > 0 ? { env: { ...server.env } } : {}),
        }
      : {
          type: server.transport === 'sse-legacy' ? 'sse' : 'http',
          url: server.url,
          ...(Object.keys(server.headers).length > 0
            ? { headers: { ...server.headers } }
            : {}),
        };
  }
  return out;
}

/** Entradas no formato oficial do OpenCode (`mcp.<name>`). */
export function openCodeHubMcpServers(
  servers: readonly McpHubSpawnServer[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const server of servers) {
    out[server.key] = isStdioHubServer(server)
      ? {
          type: 'local',
          command: [server.command!, ...server.args],
          enabled: true,
          ...(Object.keys(server.env).length > 0
            ? { environment: { ...server.env } }
            : {}),
        }
      : {
          type: 'remote',
          url: server.url,
          enabled: true,
          ...(Object.keys(server.headers).length > 0
            ? { headers: { ...server.headers } }
            : {}),
        };
  }
  return out;
}

/** Entradas para `mcp_servers` do config.toml do Grok. */
export function grokHubMcpServers(
  servers: readonly McpHubSpawnServer[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const server of servers) {
    out[server.key] = isStdioHubServer(server)
      ? {
          command: server.command,
          enabled: true,
          ...(server.args.length > 0 ? { args: [...server.args] } : {}),
          ...(Object.keys(server.env).length > 0 ? { env: { ...server.env } } : {}),
        }
      : {
          url: server.url,
          enabled: true,
          ...(Object.keys(server.headers).length > 0
            ? { http_headers: { ...server.headers } }
            : {}),
        };
  }
  return out;
}

/**
 * Overrides `-c mcp_servers.<key>.*` para o Codex.
 *
 * O Codex só tem argv como canal por sessão, e argv é visível em `ps` para
 * qualquer processo da máquina. Por isso valores de campo SECRETO
 * (`token`/`authorization`/`api_key`/…) são deliberadamente omitidos aqui —
 * mesma postura do bearer do Nexus, que também nunca entra em argv. Os demais
 * adapters recebem esses valores por arquivo 0600 / env da sessão.
 */
export function codexHubMcpArgs(
  servers: readonly McpHubSpawnServer[],
): string[] {
  const args: string[] = [];
  const push = (key: string, value: unknown): void => {
    args.push('-c', `${key}=${JSON.stringify(value)}`);
  };
  for (const server of servers) {
    const base = `mcp_servers.${server.key}`;
    if (isStdioHubServer(server)) {
      push(`${base}.command`, server.command);
      if (server.args.length > 0) push(`${base}.args`, [...server.args]);
      for (const [name, value] of Object.entries(server.env)) {
        if (isSecretFieldName(name)) continue;
        push(`${base}.env.${name}`, value);
      }
      continue;
    }
    push(`${base}.url`, server.url);
    for (const [name, value] of Object.entries(server.headers)) {
      if (isSecretFieldName(name)) continue;
      push(`${base}.http_headers.${name}`, value);
    }
  }
  return args;
}
