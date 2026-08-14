import { execFile } from 'node:child_process';
import { chmodSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import {
  classifySshBootstrapError,
  hashEndpoint,
  isSshAlias,
  redactSshEndpoint,
  requireSshAlias,
  sshBootstrapErrorMessage,
  type SshBootstrapErrorKind,
} from './ssh-alias';
import { holdSecret, wipeSecret } from './ssh-secret';
import {
  ensureNexusSshDirs,
  listKnownSshAliases,
  nexusSshHome,
  nexusSshKeyPath,
  readSshHostRegistry,
  removeSshHostRecord,
  unlinkIfExists,
  upsertSshHostRecord,
  userSshConfigPath,
  type SshHostView,
} from './ssh-host-registry';
import {
  importedHostToRecord,
  parseImportableSshHosts,
  removeManagedSshHost,
  writeManagedSshHost,
} from './ssh-config-sync';

const execFileAsync = promisify(execFile);

const SSH_ENV_KEYS = [
  'HOME',
  'HOMEDRIVE',
  'HOMEPATH',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LOGNAME',
  'PATH',
  'PATHEXT',
  'SystemRoot',
  'TEMP',
  'TMP',
  'TMPDIR',
  'USER',
  'USERPROFILE',
  'WINDIR',
] as const;

export type SshConnectRequest = {
  alias: string;
  host: string;
  user: string;
  password: string;
  port?: number;
};

export type SshConnectResult = {
  ok: boolean;
  alias?: string;
  error?: string;
  errorKind?: SshBootstrapErrorKind;
};

export type SshImportResult = {
  ok: boolean;
  imported: readonly SshHostView[];
  skipped: number;
  error?: string;
};

export type SshExecFile = (
  file: string,
  args: readonly string[],
  options: {
    timeout?: number;
    maxBuffer?: number;
    env?: NodeJS.ProcessEnv;
    input?: string;
  },
) => Promise<{ stdout: string; stderr: string }>;

export type SshBootstrapDeps = {
  home?: string;
  now?: () => string;
  exec?: SshExecFile;
};

const defaultExec: SshExecFile = async (file, args, options) => {
  const result = await execFileAsync(file, [...args], {
    timeout: options.timeout ?? 20_000,
    maxBuffer: options.maxBuffer ?? 512_000,
    env: options.env,
    ...(options.input !== undefined ? { input: options.input } : {}),
  });
  return { stdout: result.stdout, stderr: result.stderr };
};

function sanitizedEnv(
  source: NodeJS.ProcessEnv,
  extra: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of SSH_ENV_KEYS) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  env.PATH ||= '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';
  return { ...env, ...extra };
}

function quoteSh(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function validateConnectInput(req: SshConnectRequest): {
  alias: string;
  host: string;
  user: string;
  port: number;
} {
  const alias = requireSshAlias(req.alias);
  const host = req.host.trim();
  const user = req.user.trim();
  const port = req.port ?? 22;
  if (!host || host.startsWith('-') || /[\s@]/.test(host)) {
    throw Object.assign(new Error('invalid ssh host'), { kind: 'invalid' as const });
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(user) || user.startsWith('-')) {
    throw Object.assign(new Error('invalid ssh user'), { kind: 'invalid' as const });
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw Object.assign(new Error('invalid ssh port'), { kind: 'invalid' as const });
  }
  if (!req.password) {
    throw Object.assign(new Error('password required'), { kind: 'invalid' as const });
  }
  return { alias, host, user, port };
}

function installAuthorizedKeysScript(publicKey: string): string {
  return [
    'set -e',
    'umask 077',
    'AK="$HOME/.ssh/authorized_keys"',
    'mkdir -p "$HOME/.ssh"',
    'chmod 700 "$HOME/.ssh"',
    'touch "$AK"',
    'chmod 600 "$AK"',
    `KEY=${quoteSh(publicKey.trim())}`,
    'if ! grep -qxF "$KEY" "$AK"; then',
    '  printf "%s\\n" "$KEY" >> "$AK"',
    'fi',
    'printf NEXUS_SSH_KEY_INSTALLED\\n',
  ].join('\n');
}

function writeAskpassScript(home: string): string {
  const path = `${nexusSshHome(home)}/askpass.sh`;
  writeFileSync(
    path,
    '#!/bin/sh\nprintf \'%s\\n\' "${NEXUS_SSH_ASKPASS-}"\n',
    { encoding: 'utf8', mode: 0o700 },
  );
  chmodSync(path, 0o700);
  return path;
}

function failResult(
  error: unknown,
  extraHosts: readonly string[] = [],
): SshConnectResult {
  const raw = error instanceof Error ? error.message : String(error);
  const kind =
    error && typeof error === 'object' && 'kind' in error
      ? ((error as { kind?: SshBootstrapErrorKind }).kind ?? classifySshBootstrapError(raw))
      : classifySshBootstrapError(raw);
  return {
    ok: false,
    error: redactSshEndpoint(sshBootstrapErrorMessage(kind), extraHosts),
    errorKind: kind,
  };
}

export async function connectSshServer(
  request: SshConnectRequest,
  deps: SshBootstrapDeps = {},
): Promise<SshConnectResult> {
  const home = deps.home ?? homedir();
  const exec = deps.exec ?? defaultExec;
  const now = deps.now ?? (() => new Date().toISOString());
  const password = holdSecret(request.password);
  request.password = '';
  let host = '';
  let alias = '';
  try {
    const input = validateConnectInput({ ...request, password: password.value });
    alias = input.alias;
    host = input.host;
    const existing = await listKnownSshAliases(home);
    if (existing.includes(alias)) {
      return {
        ok: false,
        alias,
        error: 'Já existe um servidor com este apelido.',
        errorKind: 'invalid',
      };
    }

    await ensureNexusSshDirs(home);
    const keyPath = nexusSshKeyPath(alias, home);
    await unlinkIfExists(keyPath);
    await unlinkIfExists(`${keyPath}.pub`);
    await exec(
      'ssh-keygen',
      ['-t', 'ed25519', '-N', '', '-C', `nexus-ide:${alias}`, '-f', keyPath],
      { timeout: 15_000, env: sanitizedEnv(process.env) },
    );
    chmodSync(keyPath, 0o600);
    chmodSync(`${keyPath}.pub`, 0o644);
    const publicKey = (await readFile(`${keyPath}.pub`, 'utf8')).trim();
    if (!publicKey.startsWith('ssh-ed25519 ')) {
      throw new Error('generated key is not ed25519');
    }

    const askpass = writeAskpassScript(home);
    const passwordEnv = sanitizedEnv(process.env, {
      SSH_ASKPASS: askpass,
      SSH_ASKPASS_REQUIRE: 'force',
      DISPLAY: process.env.DISPLAY || ':0',
      NEXUS_SSH_ASKPASS: password.value,
    });
    wipeSecret(password);

    const install = await exec(
      'ssh',
      [
        '-o',
        'PreferredAuthentications=password,keyboard-interactive',
        '-o',
        'NumberOfPasswordPrompts=1',
        '-o',
        'IdentitiesOnly=yes',
        '-o',
        'StrictHostKeyChecking=accept-new',
        '-o',
        'ConnectTimeout=12',
        '-p',
        String(input.port),
        '-l',
        input.user,
        '--',
        input.host,
        'sh',
        '-lc',
        installAuthorizedKeysScript(publicKey),
      ],
      { timeout: 25_000, env: passwordEnv },
    );
    if (passwordEnv.NEXUS_SSH_ASKPASS) passwordEnv.NEXUS_SSH_ASKPASS = '';
    if (!install.stdout.includes('NEXUS_SSH_KEY_INSTALLED')) {
      throw new Error('key install acknowledgement is invalid');
    }

    await writeManagedSshHost({
      alias,
      hostname: input.host,
      user: input.user,
      port: input.port,
      identityFile: keyPath,
      home,
    });

    const verified = await exec(
      'ssh',
      [
        '-o',
        'BatchMode=yes',
        '-o',
        'IdentitiesOnly=yes',
        '-o',
        `IdentityFile=${keyPath}`,
        '-o',
        'ConnectTimeout=12',
        '--',
        alias,
        'sh',
        '-lc',
        'printf NEXUS_SSH_KEY_OK\\n',
      ],
      { timeout: 20_000, env: sanitizedEnv(process.env) },
    );
    if (!verified.stdout.includes('NEXUS_SSH_KEY_OK')) {
      throw new Error('key verification failed');
    }

    await upsertSshHostRecord(
      {
        alias,
        source: 'nexus',
        user: input.user,
        port: input.port === 22 ? undefined : input.port,
        identityFile: keyPath,
        createdAt: now(),
        lastOkAt: now(),
      },
      home,
    );
    return { ok: true, alias };
  } catch (error) {
    wipeSecret(password);
    if (alias) {
      try {
        await removeManagedSshHost(alias, home);
        await removeSshHostRecord(alias, home);
        await unlinkIfExists(nexusSshKeyPath(alias, home));
        await unlinkIfExists(`${nexusSshKeyPath(alias, home)}.pub`);
      } catch {
        // Cleanup is best-effort; the operator still gets an honest failure.
      }
    }
    if (process.env.NEXUS_SSH_DEBUG === '1' && host) {
      // Debug only: hash, never the address.
      console.debug(`[nexus-ssh] bootstrap failed host=${hashEndpoint(host)}`);
    }
    return failResult(error, host ? [host] : []);
  } finally {
    wipeSecret(password);
  }
}

export async function importSshConfigHosts(
  deps: SshBootstrapDeps = {},
): Promise<SshImportResult> {
  const home = deps.home ?? homedir();
  const now = deps.now ?? (() => new Date().toISOString());
  try {
    const raw = await readFile(userSshConfigPath(home), 'utf8');
    const found = parseImportableSshHosts(raw, { home });
    const current = await readSshHostRegistry(home);
    const known = new Set(current.hosts.map((host) => host.alias));
    let skipped = 0;
    const imported: SshHostView[] = [];
    for (const host of found) {
      if (known.has(host.alias)) {
        skipped += 1;
        continue;
      }
      const record = importedHostToRecord(host, now());
      await upsertSshHostRecord(record, home);
      known.add(host.alias);
      imported.push({
        alias: record.alias,
        source: 'imported',
        user: record.user,
        port: record.port,
        ready: true,
        hasNexusKey: false,
      });
    }
    return { ok: true, imported, skipped };
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ok: true, imported: [], skipped: 0 };
    }
    return { ok: false, imported: [], skipped: 0, error: redactSshEndpoint(raw) };
  }
}

export async function forgetSshServer(
  aliasRaw: string,
  deps: SshBootstrapDeps = {},
): Promise<{ ok: boolean; alias?: string; error?: string }> {
  try {
    const home = deps.home ?? homedir();
    const alias = requireSshAlias(aliasRaw);
    const registry = await readSshHostRegistry(home);
    const record = registry.hosts.find((host) => host.alias === alias);
    if (!record) return { ok: false, error: 'apelido desconhecido' };
    if (record.source === 'nexus') {
      await removeManagedSshHost(alias, home);
      if (record.identityFile?.includes('.nexus-ide/ssh/keys/')) {
        await unlinkIfExists(record.identityFile);
        await unlinkIfExists(`${record.identityFile}.pub`);
      }
    }
    await removeSshHostRecord(alias, home);
    return { ok: true, alias };
  } catch (error) {
    return {
      ok: false,
      error: redactSshEndpoint(error instanceof Error ? error.message : String(error)),
    };
  }
}

export function assertKnownSpawnAlias(
  target: string,
  knownAliases: readonly string[],
): string {
  const alias = requireSshAlias(target);
  if (!knownAliases.includes(alias)) {
    throw new Error('unknown ssh alias');
  }
  return alias;
}

export function isRegisteredAliasName(value: string): boolean {
  return isSshAlias(value);
}
