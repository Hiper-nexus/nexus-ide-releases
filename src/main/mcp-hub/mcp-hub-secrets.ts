import { createHash } from 'node:crypto';
import path from 'node:path';
import { isMaskedSecretValue, type McpHubConfig } from './mcp-hub-core';

/**
 * MCP Hub secret vault refs.
 *
 * Disk (`mcp-hub.json`) must not hold third-party tokens in plaintext. Secret
 * env/header values are stored in the OS-backed secrets vault and replaced on
 * disk by a reversible ref. The hub remains the source of truth for structure;
 * the vault is the only place real secret bytes live after migration.
 */

export const MCP_HUB_VAULT_PREFIX = '__nexus_vault__:';
const SECRET_FIELD = /(token|secret|password|api[_-]?key|authorization|credential)/i;

export type McpHubSecretGet = (key: string) => string | null;
export type McpHubSecretPut = (
  key: string,
  value: string,
) => { ok: true } | { ok: false; error?: string };
export type McpHubSecretAvailable = () => boolean;

export function isSecretFieldName(name: string): boolean {
  return SECRET_FIELD.test(name);
}

export function isVaultRef(value: string): boolean {
  return value.startsWith(MCP_HUB_VAULT_PREFIX);
}

export function vaultRefOf(key: string): string {
  return `${MCP_HUB_VAULT_PREFIX}${key}`;
}

export function vaultKeyFromRef(value: string): string | null {
  if (!isVaultRef(value)) return null;
  const key = value.slice(MCP_HUB_VAULT_PREFIX.length);
  return key.length > 0 ? key : null;
}

/** Stable vault namespace for a workspace root (no path leak in the key). */
export function mcpHubVaultScope(workspaceRoot: string): string {
  const resolved = path.resolve(workspaceRoot);
  return createHash('sha256').update(resolved).digest('hex').slice(0, 24);
}

export function mcpHubSecretKey(
  scope: string,
  serverId: string,
  kind: 'env' | 'headers',
  name: string,
): string {
  // Keep keys short and path-safe for the vault index.
  return `mcphub:${scope}:${serverId}:${kind}:${name}`;
}

function sealRecord(
  record: Record<string, string> | undefined,
  scope: string,
  serverId: string,
  kind: 'env' | 'headers',
  put: McpHubSecretPut,
): Record<string, string> | undefined {
  if (!record) return record;
  const next: Record<string, string> = {};
  for (const [name, value] of Object.entries(record)) {
    if (!isSecretFieldName(name) || isVaultRef(value) || value.length === 0) {
      next[name] = value;
      continue;
    }
    // Never vault a UI redaction placeholder — that would destroy the real
    // token and make restore-from-mask impossible after the next save.
    if (isMaskedSecretValue(value)) {
      throw new Error(
        `mcp hub refuses to vault masked placeholder for ${serverId}.${kind}.${name} — re-enter the real secret before saving`,
      );
    }
    const key = mcpHubSecretKey(scope, serverId, kind, name);
    const result = put(key, value);
    if (!result.ok) {
      throw new Error(
        `mcp hub vault write failed for ${serverId}.${kind}.${name}: ${result.error ?? 'unknown'}`,
      );
    }
    next[name] = vaultRefOf(key);
  }
  return next;
}

function hydrateRecord(
  record: Record<string, string> | undefined,
  get: McpHubSecretGet,
  label: string,
): Record<string, string> | undefined {
  if (!record) return record;
  return Object.fromEntries(
    Object.entries(record).map(([name, value]) => {
      const key = vaultKeyFromRef(value);
      if (!key) return [name, value];
      const plain = get(key);
      if (plain === null || plain === '') {
        throw new Error(
          `mcp hub vault miss for ${label}.${name} (key present on disk, secret missing in vault)`,
        );
      }
      return [name, plain];
    }),
  );
}

/** Replace plaintext secret fields with vault refs (writes vault). */
export function sealMcpHubSecrets(
  config: McpHubConfig,
  scope: string,
  put: McpHubSecretPut,
): McpHubConfig {
  return {
    ...config,
    servers: config.servers.map((server) => {
      const env = sealRecord(server.env, scope, server.id, 'env', put);
      const headers = sealRecord(
        server.headers,
        scope,
        server.id,
        'headers',
        put,
      );
      return {
        ...server,
        ...(env !== undefined ? { env } : {}),
        ...(headers !== undefined ? { headers } : {}),
      };
    }),
  };
}

/** Resolve vault refs back to plaintext for runtime use. */
export function hydrateMcpHubSecrets(
  config: McpHubConfig,
  get: McpHubSecretGet,
): McpHubConfig {
  return {
    ...config,
    servers: config.servers.map((server) => {
      const env = hydrateRecord(server.env, get, `${server.id}.env`);
      const headers = hydrateRecord(
        server.headers,
        get,
        `${server.id}.headers`,
      );
      return {
        ...server,
        ...(env !== undefined ? { env } : {}),
        ...(headers !== undefined ? { headers } : {}),
      };
    }),
  };
}

/** True when any secret-shaped field still holds a non-ref plaintext value. */
export function mcpHubConfigHasPlaintextSecrets(config: McpHubConfig): boolean {
  for (const server of config.servers) {
    for (const [name, value] of Object.entries(server.env ?? {})) {
      if (
        isSecretFieldName(name) &&
        value &&
        !isVaultRef(value) &&
        !isMaskedSecretValue(value)
      ) {
        return true;
      }
    }
    for (const [name, value] of Object.entries(server.headers ?? {})) {
      if (
        isSecretFieldName(name) &&
        value &&
        !isVaultRef(value) &&
        !isMaskedSecretValue(value)
      ) {
        return true;
      }
    }
  }
  return false;
}

/** Count vault refs (for tests / metrics). */
export function countMcpHubVaultRefs(config: McpHubConfig): number {
  let n = 0;
  for (const server of config.servers) {
    for (const value of Object.values(server.env ?? {})) {
      if (isVaultRef(value)) n += 1;
    }
    for (const value of Object.values(server.headers ?? {})) {
      if (isVaultRef(value)) n += 1;
    }
  }
  return n;
}

/** Pure helper for tests: seal without OS vault using an in-memory map. */
export function sealMcpHubSecretsInMemory(
  config: McpHubConfig,
  scope: string,
  store: Map<string, string>,
): McpHubConfig {
  return sealMcpHubSecrets(config, scope, (key, value) => {
    store.set(key, value);
    return { ok: true };
  });
}

export function hydrateMcpHubSecretsInMemory(
  config: McpHubConfig,
  store: Map<string, string>,
): McpHubConfig {
  return hydrateMcpHubSecrets(config, (key) => store.get(key) ?? null);
}
