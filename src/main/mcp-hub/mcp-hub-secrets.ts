import { createHash } from 'node:crypto';
import path from 'node:path';
import { isMaskedSecretValue, type McpHubConfig } from './mcp-hub-core';
import {
  CREDENTIAL_FLAG_RE,
  redactCommandLine,
} from '../../shared/secret-redaction';

/**
 * MCP Hub secret vault refs.
 *
 * Disk (`mcp-hub.json`) must not hold third-party tokens in plaintext. Secret
 * env/header values are stored in the OS-backed secrets vault and replaced on
 * disk by a reversible ref. The hub remains the source of truth for structure;
 * the vault is the only place real secret bytes live after migration.
 */

export const MCP_HUB_VAULT_PREFIX = '__nexus_vault__:';
export const MCP_HUB_VAULT_KEY_PREFIX = 'mcphub:';
const SECRET_FIELD = /(token|secret|password|api[_-]?key|authorization|credential)/i;

/**
 * Reserved vault names owned by app auth/session (license seal, session,
 * refresh). MCP Hub must never resolve these — a planted `__nexus_vault__:auth:*`
 * ref in `.nexus/mcp-hub.json` is a cross-store read. Local predicate on
 * purpose: the orchestrator unifies reserved names later.
 */
const RESERVED_VAULT_KEY_PREFIX = 'auth:';

export type McpHubSecretGet = (key: string) => string | null;
export type McpHubSecretPut = (
  key: string,
  value: string,
) => { ok: true } | { ok: false; error?: string };
export type McpHubSecretAvailable = () => boolean;

export function isSecretFieldName(name: string): boolean {
  return SECRET_FIELD.test(name);
}

export function isReservedVaultKey(key: string): boolean {
  return key.startsWith(RESERVED_VAULT_KEY_PREFIX);
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

export type McpHubSecretKind = 'env' | 'headers' | 'args';

export function mcpHubSecretKey(
  scope: string,
  serverId: string,
  kind: McpHubSecretKind,
  name: string,
): string {
  // Keep keys short and path-safe for the vault index.
  return `mcphub:${scope}:${serverId}:${kind}:${name}`;
}

/**
 * Fail-closed gate before any vault read. A ref is only legitimate when it is
 * exactly the key this workspace/server/field would have produced at seal time
 * and is not a reserved `auth:*` name. Stable error: never log the ref or the
 * secret. Exported so seal and hydrate share one rule.
 */
export function assertMcpHubVaultKey(
  key: string,
  scope: string,
  serverId: string,
  kind: McpHubSecretKind,
  name: string,
  label: string,
): void {
  if (
    isReservedVaultKey(key) ||
    !key.startsWith(MCP_HUB_VAULT_KEY_PREFIX) ||
    key !== mcpHubSecretKey(scope, serverId, kind, name)
  ) {
    throw new Error(`mcp hub vault ref rejected for ${label}.${name}`);
  }
}

function sealRecord(
  record: Record<string, string> | undefined,
  scope: string,
  serverId: string,
  kind: McpHubSecretKind,
  put: McpHubSecretPut,
): Record<string, string> | undefined {
  if (!record) return record;
  const next: Record<string, string> = {};
  for (const [name, value] of Object.entries(record)) {
    if (isVaultRef(value)) {
      // An existing ref must already be the key this field would own.
      // Rejects planted `auth:*` / foreign-namespace refs before they stick.
      const key = vaultKeyFromRef(value);
      if (key === null) {
        throw new Error(
          `mcp hub vault ref rejected for ${serverId}.${kind}.${name}`,
        );
      }
      assertMcpHubVaultKey(key, scope, serverId, kind, name, `${serverId}.${kind}`);
      next[name] = value;
      continue;
    }
    if (!isSecretFieldName(name) || value.length === 0) {
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
  scope: string,
  serverId: string,
  kind: McpHubSecretKind,
  label: string,
): Record<string, string> | undefined {
  if (!record) return record;
  return Object.fromEntries(
    Object.entries(record).map(([name, value]) => {
      const key = vaultKeyFromRef(value);
      if (!key) return [name, value];
      // Validate BEFORE the vault read — a planted auth:* ref must never
      // reach getSecret (no decrypt, no side channel via miss timing).
      assertMcpHubVaultKey(key, scope, serverId, kind, name, label);
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

/**
 * F-1383: an argv item is secret-shaped when the shared secret patterns
 * (`redactCommandLine` — known token prefixes, `--flag=value`, `NAME=value`)
 * hit it, or when it is the value right after a credential flag
 * (`--token VALOR`). The vault entry stores the WHOLE arg, so hydration is an
 * exact positional restore.
 */
function argIsSecretShaped(arg: string, afterCredentialFlag: boolean): boolean {
  if (arg.length === 0) return false;
  if (afterCredentialFlag) return true;
  return redactCommandLine(arg, { denylist: [] }).secretHits > 0;
}

function sealArgs(
  args: readonly string[] | undefined,
  scope: string,
  serverId: string,
  put: McpHubSecretPut,
): string[] | undefined {
  if (!args) return undefined;
  const next: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    const name = String(index);
    if (isVaultRef(arg)) {
      // Existing ref: must be exactly the key this position would own.
      const key = vaultKeyFromRef(arg);
      if (key === null) {
        throw new Error(`mcp hub vault ref rejected for ${serverId}.args.${name}`);
      }
      assertMcpHubVaultKey(key, scope, serverId, 'args', name, `${serverId}.args`);
      next.push(arg);
      continue;
    }
    const afterCredentialFlag =
      next.length > 0 && CREDENTIAL_FLAG_RE.test(next[next.length - 1]!);
    if (!argIsSecretShaped(arg, afterCredentialFlag)) {
      next.push(arg);
      continue;
    }
    if (isMaskedSecretValue(arg)) {
      throw new Error(
        `mcp hub refuses to vault masked placeholder for ${serverId}.args.${name} — re-enter the real secret before saving`,
      );
    }
    const key = mcpHubSecretKey(scope, serverId, 'args', name);
    const result = put(key, arg);
    if (!result.ok) {
      throw new Error(
        `mcp hub vault write failed for ${serverId}.args.${name}: ${result.error ?? 'unknown'}`,
      );
    }
    next.push(vaultRefOf(key));
  }
  return next;
}

function hydrateArgs(
  args: readonly string[] | undefined,
  get: McpHubSecretGet,
  scope: string,
  serverId: string,
  label: string,
): string[] | undefined {
  if (!args) return undefined;
  return args.map((arg, index) => {
    const key = vaultKeyFromRef(arg);
    if (!key) return arg;
    const name = String(index);
    // Validate BEFORE the vault read — a planted auth:* ref must never
    // reach getSecret (no decrypt, no side channel via miss timing).
    assertMcpHubVaultKey(key, scope, serverId, 'args', name, label);
    const plain = get(key);
    if (plain === null || plain === '') {
      throw new Error(
        `mcp hub vault miss for ${label}.${name} (key present on disk, secret missing in vault)`,
      );
    }
    return plain;
  });
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
      const args = sealArgs(server.args, scope, server.id, put);
      return {
        ...server,
        ...(env !== undefined ? { env } : {}),
        ...(headers !== undefined ? { headers } : {}),
        ...(args !== undefined ? { args } : {}),
      };
    }),
  };
}

/**
 * Resolve vault refs back to plaintext for runtime use (server processes).
 * Every ref is checked against the expected key for its workspace/server/field
 * before the vault is consulted. Renderer paths must not use this result
 * unmasked — see maskServerForUi (value-origin mask).
 */
export function hydrateMcpHubSecrets(
  config: McpHubConfig,
  get: McpHubSecretGet,
  scope: string,
): McpHubConfig {
  return {
    ...config,
    servers: config.servers.map((server) => {
      const env = hydrateRecord(
        server.env,
        get,
        scope,
        server.id,
        'env',
        `${server.id}.env`,
      );
      const headers = hydrateRecord(
        server.headers,
        get,
        scope,
        server.id,
        'headers',
        `${server.id}.headers`,
      );
      const args = hydrateArgs(
        server.args,
        get,
        scope,
        server.id,
        `${server.id}.args`,
      );
      return {
        ...server,
        ...(env !== undefined ? { env } : {}),
        ...(headers !== undefined ? { headers } : {}),
        ...(args !== undefined ? { args } : {}),
      };
    }),
  };
}

/**
 * Args-only hydration for the spawn path (`loadMcpHubServersForSpawn`): env
 * and header secrets deliberately never reach generated configs, but an argv
 * flag has no other channel — without the real value the spawned server loses
 * its credential. Same fail-closed key validation as the full hydrate.
 */
export function hydrateMcpHubArgs(
  config: McpHubConfig,
  get: McpHubSecretGet,
  scope: string,
): McpHubConfig {
  return {
    ...config,
    servers: config.servers.map((server) => {
      const args = hydrateArgs(
        server.args,
        get,
        scope,
        server.id,
        `${server.id}.args`,
      );
      return args !== undefined ? { ...server, args } : server;
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
    const args = server.args ?? [];
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index]!;
      if (isVaultRef(arg) || isMaskedSecretValue(arg)) continue;
      const afterCredentialFlag =
        index > 0 && CREDENTIAL_FLAG_RE.test(args[index - 1]!);
      if (argIsSecretShaped(arg, afterCredentialFlag)) return true;
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
    for (const value of server.args ?? []) {
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
  scope: string,
): McpHubConfig {
  return hydrateMcpHubSecrets(config, (key) => store.get(key) ?? null, scope);
}
