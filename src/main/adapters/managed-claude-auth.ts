import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { writeFileAtomic } from '../util/atomic-write';
import {
  readManagedClaudeCredential,
  managedClaudeKeychainService,
  deleteManagedClaudeCredential,
  slimClaudeCredentialBlob,
  writeManagedClaudeCredential,
} from './claude-credential';
import { readNativeOAuthCredential } from './native-oauth-keychain';
import { removeTreeSync } from '../util/remove-tree';

/** Physically verified with Claude Code 2.1.278; independent from conversation HOME. */
export const CLAUDE_MANAGED_AUTH_ENV = 'CLAUDE_SECURESTORAGE_CONFIG_DIR';
/**
 * F-1401: sibling panes on the same account can rotate the credential between
 * profile verification and spawn preparation — the only prepare error worth
 * an automatic verify+prepare retry (`retryClaudeSpawnOnCredentialChange`).
 */
export const MANAGED_CLAUDE_CREDENTIAL_CHANGED_ERROR =
  'managed Claude credential changed after verified profile; retry spawn';
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

/**
 * O escopo desta conta contém MESMO uma credencial?
 *
 * `hasManagedClaudeAuth` responde "o diretório existe" — e o diretório passa a
 * existir só de validá-lo (`validateManagedClaudeAuthDirectory` cria o
 * caminho). Um diretório vazio NÃO é uma conta: rodar `claude` apontado para
 * ele faz o binário cair na credencial NATIVA e responder pela conta errada.
 * Foi assim que duas contas apareceram com o mesmo consumo (5h/semanal
 * idênticos) enquanto uma delas estava com a sessão morta.
 *
 * A sonda é de graça e nunca abre prompt: lê o arquivo do próprio escopo e,
 * no macOS, consulta apenas os ATRIBUTOS do item de keychain — metadado não
 * passa pela ACL do item, então enumerar não pede autorização (mesma regra
 * que `profileHasCredential` já usa para perfis de disco).
 */
export function managedClaudeAuthHasCredential(
  accountId: string,
  options: { home?: string; keychainProbe?: (service: string) => boolean } = {},
): boolean {
  const home = options.home ?? os.homedir();
  if (!hasManagedClaudeAuth(accountId, home)) return false;
  const directory = managedClaudeAuthDirectory(accountId, home);
  // Blob já lido nesta sessão (cache do read-back assíncrono) ou arquivo no
  // escopo: qualquer um dos dois prova que o escopo tem com que autenticar.
  try {
    if (freshestClaudeCredential(
      scopedCache.get(directory)?.blob ?? null,
      readFileCredential(directory),
    )) {
      return true;
    }
  } catch {
    // Arquivo hostil (link, tamanho) não prova nada — segue para o keychain.
  }
  const probe = options.keychainProbe ?? keychainItemExists;
  return probe(managedClaudeKeychainService(directory));
}

/**
 * F-1642: o store que a CLI do escopo usa foi lido de verdade? No macOS a CLI
 * lê o item de Keychain do escopo e ignora o arquivo-espelho; com o item
 * presente e a leitura negada ou travada, a CLI também diz "not logged in", e
 * isso não prova nada sobre a sessão da conta. Mesma régua da cota.
 */
export async function managedClaudeScopeKeychainReadable(accountId: string): Promise<boolean> {
  if (process.platform !== 'darwin' || !hasManagedClaudeAuth(accountId)) return true;
  const service = managedClaudeKeychainService(managedClaudeAuthDirectory(accountId));
  if (!keychainItemExists(service)) return true;
  try {
    return Boolean(await readNativeOAuthCredential(service, undefined, { bypassCache: true }));
  } catch {
    return false;
  }
}

/** Só atributos (`-s`, sem `-w`): confirma existência sem custar prompt. */
function keychainItemExists(service: string): boolean {
  if (process.platform !== 'darwin') return false;
  try {
    return spawnSync('security', ['find-generic-password', '-s', service], {
      stdio: ['ignore', 'ignore', 'ignore'],
      timeout: 3_000,
      killSignal: 'SIGKILL',
    }).status === 0;
  } catch {
    return false;
  }
}

export function readManagedClaudeAuth(accountId: string, options: { home?: string } = {}): string | null {
  const home = options.home ?? os.homedir();
  if (!hasManagedClaudeAuth(accountId, home)) return null;
  const directory = managedClaudeAuthDirectory(accountId, home);
  ensurePrivateDirectory(directory, home);
  return freshestClaudeCredential(scopedCache.get(directory)?.blob ?? null, readFileCredential(directory));
}

/**
 * Background read-back must not block Main while SecurityAgent is unavailable.
 * `fresh` skips the 60 s cache: right after a CLI run renewed the scope, the
 * cached Keychain blob is the token that run just replaced.
 */
export async function readManagedClaudeAuthAsync(
  accountId: string,
  options: { fresh?: boolean } = {},
): Promise<string | null> {
  if (!hasManagedClaudeAuth(accountId)) return null;
  const directory = managedClaudeAuthDirectory(accountId);
  ensurePrivateDirectory(directory, os.homedir());
  const cached = scopedCache.get(directory);
  if (!options.fresh && cached && Date.now() - cached.at < 60_000) {
    return freshestClaudeCredential(cached.blob, readFileCredential(directory));
  }
  let flight = options.fresh ? undefined : scopedFlights.get(directory);
  if (!flight) {
    flight = (process.platform === 'darwin'
      ? readNativeOAuthCredential(managedClaudeKeychainService(directory), undefined,
        { bypassCache: options.fresh === true }).catch(() => null)
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
  removeTreeSync(directory, { recursive: true, force: true });
}

/** CLI owns refreshing and its .oauth_refresh.lock; Nexus only seeds/read-backs this store. */
export function materializeManagedClaudeAuth(
  accountId: string,
  vaultBlob: string,
  options: { home?: string; replace?: boolean; expectedBlob?: string;
    keychainProbe?: (service: string) => boolean } = {},
): { directory: string; blob: string; env: Record<string, string> } {
  const home = options.home ?? os.homedir();
  const directory = managedClaudeAuthDirectory(accountId, home);
  const vault = slimClaudeCredentialBlob(vaultBlob);
  if (!vault) throw new Error('managed Claude account has no usable OAuth credential');
  ensurePrivateDirectory(directory, home);
  const file = readFileCredential(directory);
  const scoped = readManagedClaudeCredential(directory);
  if (!scoped && (options.keychainProbe ?? keychainItemExists)(managedClaudeKeychainService(directory))) {
    throw new Error('managed Claude Keychain credential is unreadable; unlock Keychain and retry');
  }
  const selected = options.replace ? vault : freshestClaudeCredential(scoped, file, vault)!;
  if (options.expectedBlob !== undefined && selected !== slimClaudeCredentialBlob(options.expectedBlob)) {
    throw new Error(MANAGED_CLAUDE_CREDENTIAL_CHANGED_ERROR);
  }
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
 * Windows npm installs `claude.cmd`, which ConPTY must spawn, but the marker
 * lives in the exe that shim launches. Scanning the 160-byte cmd reports the
 * CLI as too old and the pane dies before it starts. Only a relative payload
 * inside the shim's own directory counts — anything else keeps the shim, and
 * the check stays fail-closed.
 */
export function claudeCapabilityProbePath(binary: string): string {
  const ext = path.extname(binary).toLowerCase();
  if (ext !== '.cmd' && ext !== '.bat') return binary;
  let text: string;
  let root: string;
  try {
    const stat = fs.statSync(binary);
    if (!stat.isFile() || stat.size > 64 * 1024) return binary;
    text = fs.readFileSync(binary, 'utf8');
    root = fs.realpathSync(path.dirname(binary));
  } catch {
    return binary;
  }
  const resolved: string[] = [];
  for (const match of text.matchAll(/"%dp0%\\([^"]+)"/gi)) {
    const rel = match[1] ?? '';
    const parts = rel.split(/[\\/]/).filter(Boolean);
    if (parts.length === 0 || parts.some((part) => part === '.' || part === '..' || part.includes('%'))) {
      continue;
    }
    let real: string;
    try {
      real = fs.realpathSync(path.resolve(root, ...parts));
      const stay = path.relative(root, real);
      if (stay.startsWith('..') || path.isAbsolute(stay) || !fs.statSync(real).isFile()) continue;
    } catch {
      continue;
    }
    resolved.push(real);
  }
  return resolved.find((file) => !/^node(?:\.exe)?$/i.test(path.basename(file))) ?? binary;
}

/**
 * True when the CLI binary literally declares the marker (an env var name).
 * Quota probes gate env-scoped `claude /usage` runs on this: a CLI too old to
 * know the variable falls back to the native login and would paint that
 * account's usage on a different account's row — fabricated data.
 */
export function claudeCliDeclaresMarker(binary: string, marker: string): boolean {
  const probe = claudeCapabilityProbePath(binary);
  const stat = fs.statSync(probe);
  const signature = `${stat.size}:${stat.mtimeMs}`;
  const key = `${probe}${marker}`;
  let cached = capabilityCache.get(key);
  if (cached?.signature !== signature) {
    const needle = Buffer.from(marker);
    const chunk = Buffer.alloc(256 * 1024);
    const fd = fs.openSync(probe, 'r');
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
