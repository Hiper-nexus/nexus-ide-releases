import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeFileAtomic } from '../util/atomic-write';
import {
  readManagedClaudeCredential,
  managedClaudeKeychainService,
  deleteManagedClaudeCredential,
  slimClaudeCredentialBlob,
  writeManagedClaudeCredential,
} from './claude-credential';
import { readNativeOAuthCredential } from './native-oauth-keychain';

/** Physically verified with Claude Code 2.1.278; independent from conversation HOME. */
export const CLAUDE_MANAGED_AUTH_ENV = 'CLAUDE_SECURESTORAGE_CONFIG_DIR';
const CREDENTIAL_FILE = '.credentials.json';
const scopedCache = new Map<string, { blob: string | null; at: number }>();
const scopedFlights = new Map<string, Promise<string | null>>();

export function managedClaudeAuthDirectory(accountId: string, home = os.homedir()): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(accountId)) {
    throw new Error('invalid managed Claude account id');
  }
  return path.resolve(home, '.nexus', 'managed-accounts', 'claude', accountId, 'auth').normalize('NFC');
}

export function validateManagedClaudeAuthDirectory(directory: string, home = os.homedir()): string {
  const root = path.resolve(home, '.nexus', 'managed-accounts', 'claude').normalize('NFC');
  const parts = path.relative(root, directory).split(path.sep);
  if (parts.length !== 2 || parts[1] !== 'auth' ||
      managedClaudeAuthDirectory(parts[0]!, home) !== directory) {
    throw new Error('invalid managed Claude auth directory');
  }
  ensurePrivateDirectory(directory, home);
  return directory;
}

function ensurePrivateDirectory(directory: string, home: string): void {
  const root = path.resolve(home);
  let current = root;
  for (const part of path.relative(root, directory).split(path.sep)) {
    current = path.join(current, part);
    const existing = fs.lstatSync(current, { throwIfNoEntry: false });
    if (existing?.isSymbolicLink() || (existing && !existing.isDirectory())) {
      throw new Error('managed Claude auth path must not contain links');
    }
    if (!existing) fs.mkdirSync(current, { mode: 0o700 });
  }
}

function readFileCredential(directory: string): string | null {
  const file = path.join(directory, CREDENTIAL_FILE);
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat) return null;
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error('managed Claude credential must not be a link');
  }
  if (stat.size > 1_000_000) throw new Error('managed Claude credential exceeds size limit');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.size > 1_000_000 || opened.nlink > 1) {
      throw new Error('invalid managed Claude credential file');
    }
    return slimClaudeCredentialBlob(fs.readFileSync(fd, 'utf8'));
  }
  finally { fs.closeSync(fd); }
}

function expiresAt(blob: string): number {
  try {
    const value = JSON.parse(blob)?.claudeAiOauth?.expiresAt;
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
  } catch { return 0; }
}

/** Existing stores win ties; a stale vault must never undo a CLI token rotation. */
export function freshestClaudeCredential(...blobs: Array<string | null>): string | null {
  let best: string | null = null;
  for (const candidate of blobs) {
    const slim = candidate && slimClaudeCredentialBlob(candidate);
    if (slim && (!best || expiresAt(slim) > expiresAt(best))) best = slim;
  }
  return best;
}

export function hasManagedClaudeAuth(accountId: string, home = os.homedir()): boolean {
  const stat = fs.lstatSync(managedClaudeAuthDirectory(accountId, home), { throwIfNoEntry: false });
  return Boolean(stat?.isDirectory() && !stat.isSymbolicLink());
}

export function readManagedClaudeAuth(accountId: string, options: { home?: string } = {}): string | null {
  const home = options.home ?? os.homedir();
  if (!hasManagedClaudeAuth(accountId, home)) return null;
  const directory = managedClaudeAuthDirectory(accountId, home);
  ensurePrivateDirectory(directory, home);
  return freshestClaudeCredential(scopedCache.get(directory)?.blob ?? null, readFileCredential(directory));
}

/** Background read-back must not block Main while SecurityAgent is unavailable. */
export async function readManagedClaudeAuthAsync(accountId: string): Promise<string | null> {
  if (!hasManagedClaudeAuth(accountId)) return null;
  const directory = managedClaudeAuthDirectory(accountId);
  ensurePrivateDirectory(directory, os.homedir());
  const cached = scopedCache.get(directory);
  if (cached && Date.now() - cached.at < 60_000) {
    return freshestClaudeCredential(cached.blob, readFileCredential(directory));
  }
  let flight = scopedFlights.get(directory);
  if (!flight) {
    flight = (process.platform === 'darwin'
      ? readNativeOAuthCredential(managedClaudeKeychainService(directory)).catch(() => null)
      : Promise.resolve(null))
      .then((blob) => {
        if (hasManagedClaudeAuth(accountId)) scopedCache.set(directory, { blob, at: Date.now() });
        return blob;
      }).finally(() => scopedFlights.delete(directory));
    scopedFlights.set(directory, flight);
  }
  const scoped = await flight;
  return freshestClaudeCredential(scoped, readFileCredential(directory));
}

export function removeManagedClaudeAuth(accountId: string, options: { home?: string } = {}): void {
  const home = options.home ?? os.homedir();
  const directory = managedClaudeAuthDirectory(accountId, home);
  validateManagedClaudeAuthDirectory(directory, home);
  deleteManagedClaudeCredential(directory);
  scopedCache.delete(directory);
  fs.rmSync(directory, { recursive: true, force: true });
}

/** CLI owns refreshing and its .oauth_refresh.lock; Nexus only seeds/read-backs this store. */
export function materializeManagedClaudeAuth(
  accountId: string,
  vaultBlob: string,
  options: { home?: string; replace?: boolean } = {},
): { directory: string; blob: string; env: Record<string, string> } {
  const home = options.home ?? os.homedir();
  const directory = managedClaudeAuthDirectory(accountId, home);
  const vault = slimClaudeCredentialBlob(vaultBlob);
  if (!vault) throw new Error('managed Claude account has no usable OAuth credential');
  ensurePrivateDirectory(directory, home);
  const file = readFileCredential(directory);
  const scoped = readManagedClaudeCredential(directory);
  const selected = options.replace ? vault : freshestClaudeCredential(scoped, file, vault)!;
  if (scoped && slimClaudeCredentialBlob(scoped) !== selected &&
      !writeManagedClaudeCredential(directory, selected)) {
    throw new Error('não foi possível atualizar o Keychain isolado desta conta Claude');
  }
  if (file !== selected) writeFileAtomic(path.join(directory, CREDENTIAL_FILE), selected);
  scopedCache.set(directory, { blob: selected, at: Date.now() });
  return { directory, blob: selected, env: { [CLAUDE_MANAGED_AUTH_ENV]: directory } };
}

const capabilityCache = new Map<string, { signature: string; supported: boolean }>();

/**
 * True when the CLI binary literally declares the marker (an env var name).
 * Quota probes gate env-scoped `claude /usage` runs on this: a CLI too old to
 * know the variable falls back to the native login and would paint that
 * account's usage on a different account's row — fabricated data.
 */
export function claudeCliDeclaresMarker(binary: string, marker: string): boolean {
  const stat = fs.statSync(binary);
  const signature = `${stat.size}:${stat.mtimeMs}`;
  const key = `${binary}${marker}`;
  let cached = capabilityCache.get(key);
  if (cached?.signature !== signature) {
    const needle = Buffer.from(marker);
    const chunk = Buffer.alloc(256 * 1024);
    const fd = fs.openSync(binary, 'r');
    let supported = false;
    let tail = Buffer.alloc(0);
    try {
      let count: number;
      while ((count = fs.readSync(fd, chunk, 0, chunk.length, null)) > 0) {
        const window = Buffer.concat([tail, chunk.subarray(0, count)]);
        if (window.includes(needle)) { supported = true; break; }
        tail = Buffer.from(window.subarray(Math.max(0, window.length - needle.length + 1)));
      }
    } finally { fs.closeSync(fd); }
    cached = { signature, supported };
    capabilityCache.set(key, cached);
  }
  return cached.supported;
}

/** Fail closed on older/wrapped CLIs instead of silently using the native account. */
export function assertManagedClaudeAuthSupported(binary: string): void {
  if (!claudeCliDeclaresMarker(binary, CLAUDE_MANAGED_AUTH_ENV)) {
    throw new Error('Atualize o Claude Code: esta CLI não declara CLAUDE_SECURESTORAGE_CONFIG_DIR para contas isoladas');
  }
}
