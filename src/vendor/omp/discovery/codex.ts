/**
 * Derivado de oh-my-pi (omp) — packages/coding-agent/src/discovery/codex.ts
 * https://github.com/can1357/oh-my-pi @ 03c48d073bd4849726cc14750b5aecfa310bdf26 (MIT)
 * Copyright (c) 2025 Mario Zechner; (c) 2025-2026 Can Bölük — ver NOTICE.
 *
 * Provider OpenAI Codex — prioridade 70.
 * Adaptação NexusIDE: Bun.TOML.parse vira smol-toml (dep já usada pelo
 * mcp-hub); Bun.env vira ctx.env. Prompts (~/.codex/prompts) entram como
 * slash commands — é o equivalente de comando custom do Codex CLI.
 */
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { coerceStringRecord, scanCommandsFromDir, scanSkillsFromDir } from './helpers';
import {
  emptyProviderResult,
  type DiscoveredMcpServer,
  type DiscoveryContext,
  type DiscoveryLevel,
  type ProviderResult,
} from './types';

const SOURCE = 'codex' as const;
const CONFIG_DIR = '.codex';

/** Formato Codex de MCP server em config.toml ([mcp_servers.*]). */
interface CodexMcpConfig {
  command?: unknown;
  args?: unknown;
  env?: unknown;
  /** Nomes de env vars a encaminhar do processo pai. */
  env_vars?: unknown;
  url?: unknown;
  http_headers?: unknown;
  /** Nome do header -> nome da env var. */
  env_http_headers?: unknown;
  bearer_token_env_var?: unknown;
  cwd?: unknown;
  tool_timeout_sec?: unknown;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((v): v is string => typeof v === 'string');
  return out.length > 0 ? out : undefined;
}

/**
 * Extrai [mcp_servers.*] de um config.toml já parseado (paridade omp).
 * env_vars/env_http_headers/bearer_token_env_var resolvem valores a partir
 * de ctx.env — os valores resultantes podem ser segredos; nunca logar.
 */
function extractMcpServersFromToml(
  toml: Record<string, unknown>,
  meta: { level: DiscoveryLevel; path: string },
  env: Readonly<Record<string, string | undefined>>,
): DiscoveredMcpServer[] {
  const block = toml.mcp_servers;
  if (!block || typeof block !== 'object' || Array.isArray(block)) return [];

  const out: DiscoveredMcpServer[] = [];
  for (const [name, rawConfig] of Object.entries(
    block as Record<string, unknown>,
  )) {
    if (!rawConfig || typeof rawConfig !== 'object' || Array.isArray(rawConfig)) {
      continue;
    }
    const config = rawConfig as CodexMcpConfig;
    const server: DiscoveredMcpServer = {
      source: SOURCE,
      level: meta.level,
      path: meta.path,
      name,
      command: typeof config.command === 'string' ? config.command : undefined,
      args: stringArray(config.args),
      url: typeof config.url === 'string' ? config.url : undefined,
      cwd: typeof config.cwd === 'string' ? config.cwd : undefined,
    };

    // env explícito + env_vars encaminhadas do ambiente do processo.
    const mergedEnv: Record<string, string> = {
      ...coerceStringRecord(config.env),
    };
    for (const varName of stringArray(config.env_vars) ?? []) {
      const value = env[varName];
      if (value !== undefined) mergedEnv[varName] = value;
    }
    if (Object.keys(mergedEnv).length > 0) server.env = mergedEnv;

    // headers: http_headers + env_http_headers + bearer_token_env_var.
    const headers: Record<string, string> = {
      ...coerceStringRecord(config.http_headers),
    };
    const envHeaders = coerceStringRecord(config.env_http_headers);
    if (envHeaders) {
      for (const [headerName, envVarName] of Object.entries(envHeaders)) {
        const value = env[envVarName];
        if (value !== undefined) headers[headerName] = value;
      }
    }
    if (typeof config.bearer_token_env_var === 'string') {
      const token = env[config.bearer_token_env_var];
      if (token) headers.Authorization = `Bearer ${token}`;
    }
    if (Object.keys(headers).length > 0) server.headers = headers;

    // Transporte inferido do config (validação fica no consumidor).
    if (server.url) server.transport = 'http';
    else if (server.command) server.transport = 'stdio';

    // tool_timeout_sec (segundos) -> timeout (ms).
    if (
      typeof config.tool_timeout_sec === 'number' &&
      Number.isFinite(config.tool_timeout_sec) &&
      config.tool_timeout_sec > 0
    ) {
      server.timeout = config.tool_timeout_sec * 1000;
    }

    out.push(server);
  }
  return out;
}

export function loadCodex(ctx: DiscoveryContext): ProviderResult {
  const result = emptyProviderResult();
  const userBase = path.join(ctx.home, CONFIG_DIR);
  const projectBase = path.join(ctx.workspaceRoot, CONFIG_DIR);

  // ── MCP servers (config.toml [mcp_servers.*]) ─────────────────────────────
  for (const { filePath, level } of [
    { filePath: path.join(userBase, 'config.toml'), level: 'user' as const },
    {
      filePath: path.join(projectBase, 'config.toml'),
      level: 'project' as const,
    },
  ]) {
    const content = ctx.io.readTextFile(filePath);
    if (content === null) continue;
    let toml: Record<string, unknown>;
    try {
      toml = parseToml(content) as Record<string, unknown>;
    } catch {
      result.warnings.push(`TOML inválido em ${filePath}`);
      continue;
    }
    result.mcpServers.push(
      ...extractMcpServersFromToml(toml, { level, path: filePath }, ctx.env),
    );
  }

  // ── Context file (~/.codex/AGENTS.md — só nível user, paridade omp) ──────
  const agentsMd = path.join(userBase, 'AGENTS.md');
  if (ctx.io.fileExists(agentsMd)) {
    result.contextFiles.push({
      source: SOURCE,
      level: 'user',
      path: agentsMd,
      name: 'AGENTS.md',
      kind: 'context',
    });
  }

  // ── Skills ────────────────────────────────────────────────────────────────
  for (const { dir, level } of [
    { dir: path.join(userBase, 'skills'), level: 'user' as const },
    { dir: path.join(projectBase, 'skills'), level: 'project' as const },
  ]) {
    const scanned = scanSkillsFromDir(ctx.io, dir, { source: SOURCE, level });
    result.skills.push(...scanned.skills);
    result.warnings.push(...scanned.warnings);
  }

  // ── Slash commands (commands/ não-recursivo, paridade omp; + prompts/) ───
  for (const { dir, level } of [
    { dir: path.join(userBase, 'commands'), level: 'user' as const },
    { dir: path.join(projectBase, 'commands'), level: 'project' as const },
    { dir: path.join(userBase, 'prompts'), level: 'user' as const },
    { dir: path.join(projectBase, 'prompts'), level: 'project' as const },
  ]) {
    result.commands.push(
      ...scanCommandsFromDir(
        ctx.io,
        dir,
        { source: SOURCE, level },
        { recursive: false },
      ),
    );
  }

  return result;
}
