import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { FEATURE_FLAG_IDS } from '../../shared/feature-flags';
import { getFeatureFlagRegistry } from '../feature-flags/feature-flag-registry';

/**
 * Local MCP Hub — canonical config sync, drift, backup, masked secrets.
 * Does not bypass existing mcp-dispatch effect policy; this is config-plane only.
 */

export const MCP_HUB_TRANSPORTS = [
  'stdio',
  'streamable-http',
  'sse-legacy',
] as const;

export type McpHubTransport = (typeof MCP_HUB_TRANSPORTS)[number];

export const mcpHubServerSchema = z
  .object({
    id: z.string().min(1).max(128),
    name: z.string().min(1).max(256),
    transport: z.enum(MCP_HUB_TRANSPORTS),
    command: z.string().max(4096).optional(),
    args: z.array(z.string().max(1024)).max(64).optional(),
    url: z.string().max(4096).optional(),
    headers: z.record(z.string().max(128), z.string().max(4096)).optional(),
    env: z.record(z.string().max(128), z.string().max(4096)).optional(),
    tools: z.array(z.string().min(1).max(128)).max(512).default([]),
    source: z
      .enum(['nexus', 'claude-code', 'codex', 'cursor', 'opencode', 'other'])
      .default('nexus'),
  })
  .strict();

export type McpHubServer = z.infer<typeof mcpHubServerSchema>;

export const mcpHubConfigSchema = z
  .object({
    schemaVersion: z.literal(1),
    servers: z.array(mcpHubServerSchema).max(64),
  })
  .strict();

export type McpHubConfig = z.infer<typeof mcpHubConfigSchema>;

const SECRET_KEY = /(token|secret|password|api[_-]?key|authorization|credential)/i;

export function maskSecretsInValue(value: string): string {
  if (value.length <= 8) return '[REDACTED]';
  return `${value.slice(0, 2)}…[REDACTED]`;
}

export function maskServerForUi(server: McpHubServer): McpHubServer {
  const env = server.env
    ? Object.fromEntries(
        Object.entries(server.env).map(([k, v]) => [
          k,
          SECRET_KEY.test(k) ? maskSecretsInValue(v) : v,
        ]),
      )
    : undefined;
  const headers = server.headers
    ? Object.fromEntries(
        Object.entries(server.headers).map(([k, v]) => [
          k,
          SECRET_KEY.test(k) ? maskSecretsInValue(v) : v,
        ]),
      )
    : undefined;
  return { ...server, env, headers };
}

export function toolMatrix(
  config: McpHubConfig,
): ReadonlyArray<{ serverId: string; tool: string }> {
  const rows: Array<{ serverId: string; tool: string }> = [];
  for (const s of config.servers) {
    for (const tool of s.tools) rows.push({ serverId: s.id, tool });
  }
  return rows;
}

export interface DriftReport {
  readonly drifted: boolean;
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly changed: readonly string[];
}

export function detectDrift(
  canonical: McpHubConfig,
  observed: McpHubConfig,
): DriftReport {
  const a = new Map(canonical.servers.map((s) => [s.id, JSON.stringify(s)]));
  const b = new Map(observed.servers.map((s) => [s.id, JSON.stringify(s)]));
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  for (const id of b.keys()) {
    if (!a.has(id)) added.push(id);
    else if (a.get(id) !== b.get(id)) changed.push(id);
  }
  for (const id of a.keys()) {
    if (!b.has(id)) removed.push(id);
  }
  return {
    drifted: added.length + removed.length + changed.length > 0,
    added,
    removed,
    changed,
  };
}

export function writeConfigWithBackup(
  filePath: string,
  next: McpHubConfig,
  options: { dryRun?: boolean } = {},
): { backupPath: string | null; wrote: boolean; diff: string } {
  if (!getFeatureFlagRegistry().isEnabled(FEATURE_FLAG_IDS.mcpHub)) {
    throw new Error('feature.mcp.hub is disabled');
  }
  const parsed = mcpHubConfigSchema.parse(next);
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  let previous = '';
  if (fs.existsSync(filePath)) {
    if (!fs.lstatSync(filePath).isFile()) {
      throw new Error('MCP Hub config must be a regular file');
    }
    previous = fs.readFileSync(filePath, 'utf8');
  }
  const body = `${JSON.stringify(parsed, null, 2)}\n`;
  const diff = previous === body ? '' : `--- previous\n+++ next\n(size ${previous.length} → ${body.length})`;
  if (options.dryRun) {
    return { backupPath: null, wrote: false, diff };
  }
  let backupPath: string | null = null;
  if (previous) {
    backupPath = `${filePath}.${Date.now()}.bak`;
    fs.writeFileSync(backupPath, previous, { mode: 0o600 });
  }
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, body, { mode: 0o600 });
  fs.renameSync(tmp, filePath);
  return { backupPath, wrote: true, diff };
}

export function rollbackFromBackup(filePath: string, backupPath: string): void {
  if (!backupPath.endsWith('.bak') || backupPath.includes('..')) {
    throw new Error('invalid backup path');
  }
  if (!fs.existsSync(backupPath)) throw new Error('backup missing');
  const raw = fs.readFileSync(backupPath, 'utf8');
  mcpHubConfigSchema.parse(JSON.parse(raw));
  fs.copyFileSync(backupPath, filePath);
}

/** Health stub — real transports reconnect in later iterations. */
export function healthForServer(server: McpHubServer): {
  id: string;
  status: 'unknown' | 'configured';
  transport: McpHubTransport;
} {
  return { id: server.id, status: 'configured', transport: server.transport };
}
