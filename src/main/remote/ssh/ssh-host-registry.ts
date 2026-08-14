import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chmodSync } from 'node:fs';
import { isSshAlias, requireSshAlias } from './ssh-alias';

export const SSH_REGISTRY_VERSION = 1 as const;

export type SshHostSource = 'nexus' | 'imported';

/** Registro em disco: sem senha, sem hostname/IP. */
export type SshHostRecord = {
  readonly alias: string;
  readonly source: SshHostSource;
  readonly user?: string;
  readonly port?: number;
  readonly identityFile?: string;
  readonly createdAt: string;
  readonly lastOkAt?: string;
};

export type SshHostRegistry = {
  readonly version: typeof SSH_REGISTRY_VERSION;
  readonly hosts: readonly SshHostRecord[];
};

export type SshHostView = {
  readonly alias: string;
  readonly source: SshHostSource;
  readonly user?: string;
  readonly port?: number;
  readonly ready: boolean;
  readonly hasNexusKey: boolean;
};

const FORBIDDEN_KEYS = [
  'password',
  'senha',
  'passphrase',
  'secret',
  'hostname',
  'host',
  'ip',
] as const;

export function nexusSshHome(home = homedir()): string {
  return join(home, '.nexus-ide', 'ssh');
}

export function nexusSshKeysDir(home = homedir()): string {
  return join(nexusSshHome(home), 'keys');
}

export function nexusSshConfigPath(home = homedir()): string {
  return join(nexusSshHome(home), 'config');
}

export function nexusSshRegistryPath(home = homedir()): string {
  return join(nexusSshHome(home), 'hosts.json');
}

export function nexusSshKeyPath(alias: string, home = homedir()): string {
  return join(nexusSshKeysDir(home), requireSshAlias(alias));
}

export function userSshConfigPath(home = homedir()): string {
  return join(home, '.ssh', 'config');
}

export async function ensureNexusSshDirs(home = homedir()): Promise<void> {
  const root = nexusSshHome(home);
  const keys = nexusSshKeysDir(home);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await mkdir(keys, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  chmodSync(keys, 0o700);
}

function assertNoSecrets(value: unknown, path = 'registry'): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSecrets(item, `${path}[${index}]`));
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const lower = key.toLowerCase();
    if (FORBIDDEN_KEYS.includes(lower as (typeof FORBIDDEN_KEYS)[number])) {
      throw new Error(`ssh host registry must not persist ${key}`);
    }
    assertNoSecrets(child, `${path}.${key}`);
  }
}

function sanitizeRecord(raw: unknown): SshHostRecord | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  if (typeof row.alias !== 'string' || !isSshAlias(row.alias)) return null;
  if (row.source !== 'nexus' && row.source !== 'imported') return null;
  if (typeof row.createdAt !== 'string') return null;
  const port =
    typeof row.port === 'number' && Number.isInteger(row.port) && row.port > 0 && row.port <= 65535
      ? row.port
      : undefined;
  return {
    alias: row.alias,
    source: row.source,
    user: typeof row.user === 'string' && row.user.trim() ? row.user.trim() : undefined,
    port,
    identityFile:
      typeof row.identityFile === 'string' && row.identityFile.trim()
        ? row.identityFile.trim()
        : undefined,
    createdAt: row.createdAt,
    lastOkAt: typeof row.lastOkAt === 'string' ? row.lastOkAt : undefined,
  };
}

export function parseSshHostRegistry(raw: string): SshHostRegistry {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { version: SSH_REGISTRY_VERSION, hosts: [] };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { version: SSH_REGISTRY_VERSION, hosts: [] };
  }
  const body = parsed as Record<string, unknown>;
  const hosts = Array.isArray(body.hosts)
    ? body.hosts.map(sanitizeRecord).filter((row): row is SshHostRecord => row !== null)
    : [];
  return { version: SSH_REGISTRY_VERSION, hosts };
}

export function serializeSshHostRegistry(registry: SshHostRegistry): string {
  const payload: SshHostRegistry = {
    version: SSH_REGISTRY_VERSION,
    hosts: registry.hosts.map((host) => ({
      alias: host.alias,
      source: host.source,
      ...(host.user ? { user: host.user } : {}),
      ...(host.port && host.port !== 22 ? { port: host.port } : {}),
      ...(host.identityFile ? { identityFile: host.identityFile } : {}),
      createdAt: host.createdAt,
      ...(host.lastOkAt ? { lastOkAt: host.lastOkAt } : {}),
    })),
  };
  assertNoSecrets(payload);
  return `${JSON.stringify(payload, null, 2)}\n`;
}

export async function readSshHostRegistry(home = homedir()): Promise<SshHostRegistry> {
  try {
    const raw = await readFile(nexusSshRegistryPath(home), 'utf8');
    return parseSshHostRegistry(raw);
  } catch {
    return { version: SSH_REGISTRY_VERSION, hosts: [] };
  }
}

export async function writeSshHostRegistry(
  registry: SshHostRegistry,
  home = homedir(),
): Promise<void> {
  await ensureNexusSshDirs(home);
  const target = nexusSshRegistryPath(home);
  const temporary = `${target}.tmp-${process.pid}`;
  const body = serializeSshHostRegistry(registry);
  await writeFile(temporary, body, { encoding: 'utf8', mode: 0o600 });
  chmodSync(temporary, 0o600);
  await rename(temporary, target);
  chmodSync(target, 0o600);
}

export async function upsertSshHostRecord(
  record: SshHostRecord,
  home = homedir(),
): Promise<SshHostRegistry> {
  requireSshAlias(record.alias);
  const current = await readSshHostRegistry(home);
  const hosts = [
    ...current.hosts.filter((host) => host.alias !== record.alias),
    record,
  ].sort((a, b) => a.alias.localeCompare(b.alias));
  const next = { version: SSH_REGISTRY_VERSION, hosts };
  await writeSshHostRegistry(next, home);
  return next;
}

export async function removeSshHostRecord(
  alias: string,
  home = homedir(),
): Promise<SshHostRegistry> {
  const clean = requireSshAlias(alias);
  const current = await readSshHostRegistry(home);
  const next = {
    version: SSH_REGISTRY_VERSION,
    hosts: current.hosts.filter((host) => host.alias !== clean),
  };
  await writeSshHostRegistry(next, home);
  return next;
}

export function toSshHostView(record: SshHostRecord): SshHostView {
  return {
    alias: record.alias,
    source: record.source,
    user: record.user,
    port: record.port,
    ready: record.source === 'imported' || Boolean(record.lastOkAt),
    hasNexusKey: record.source === 'nexus' && Boolean(record.identityFile),
  };
}

export async function listSshHostViews(home = homedir()): Promise<readonly SshHostView[]> {
  const registry = await readSshHostRegistry(home);
  return registry.hosts.map(toSshHostView);
}

export async function listKnownSshAliases(home = homedir()): Promise<readonly string[]> {
  const registry = await readSshHostRegistry(home);
  return registry.hosts.map((host) => host.alias);
}

export async function unlinkIfExists(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    // Best-effort cleanup.
  }
}
