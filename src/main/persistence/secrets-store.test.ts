import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import Database from 'better-sqlite3';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const secretDeps = vi.hoisted(() => ({
  home: `/tmp/nexus-secrets-store-${process.pid}`,
  encrypted: new Map<string, string>(),
  sequence: 0,
  isAvailable: true,
  backend: 'unknown',
}));

vi.mock('node:os', () => ({
  default: { homedir: () => secretDeps.home },
  homedir: () => secretDeps.home,
}));

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => secretDeps.isAvailable,
    getSelectedStorageBackend: () => secretDeps.backend,
    encryptString: (plain: string) => {
      const opaque = `opaque-${++secretDeps.sequence}`;
      secretDeps.encrypted.set(opaque, plain);
      return Buffer.from(opaque);
    },
    decryptString: (blob: Buffer) => {
      const value = secretDeps.encrypted.get(blob.toString());
      if (value === undefined) throw new Error('undecryptable');
      return value;
    },
  },
}));

import {
  deleteSecret,
  getSecret,
  isSecureStorageBackendAllowed,
  resetSecretsCacheForTests,
  setSecret,
} from './secrets-store';

const secretsFile = path.join(secretDeps.home, '.nexus', 'secrets.enc');
const secretsLockFile = `${secretsFile}.lock.sqlite`;

function expectVaultDirectoryClean(): void {
  expect(fs.readdirSync(path.dirname(secretsFile)).sort()).toEqual([
    'secrets.enc',
    'secrets.enc.lock.sqlite',
  ]);
}

function sanitizedChildEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  delete environment.GITHUB_PERSONAL_ACCESS_TOKEN;
  return environment;
}

describe('durable secret persistence', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(secretDeps.home, { recursive: true, force: true });
    secretDeps.encrypted.clear();
    secretDeps.sequence = 0;
    secretDeps.isAvailable = true;
    secretDeps.backend = 'unknown';
    resetSecretsCacheForTests();
  });

  afterAll(() => {
    fs.rmSync(secretDeps.home, { recursive: true, force: true });
  });

  it('publishes encrypted bytes durably before updating the cache', () => {
    const result = setSecret('provider', 'super-secret-value');

    expect(result).toEqual({ ok: true });
    expect(getSecret('provider')).toBe('super-secret-value');
    const bytes = fs.readFileSync(secretsFile, 'utf8');
    expect(bytes).not.toContain('super-secret-value');
    expect(fs.statSync(secretsFile).mode & 0o777).toBe(0o600);
    expectVaultDirectoryClean();
    expect(fs.statSync(secretsLockFile).mode & 0o777).toBe(0o600);
  });

  it.each([
    ['mkdir', 'mkdirSync'],
    ['open', 'openSync'],
    ['write', 'writeFileSync'],
    ['file fsync', 'fsyncSync'],
    ['chmod', 'fchmodSync'],
    ['rename', 'renameSync'],
  ] as const)('keeps the previous value when %s fails', (_label, method) => {
    expect(setSecret('provider', 'previous')).toEqual({ ok: true });
    vi.spyOn(fs, method).mockImplementationOnce(() => {
      throw new Error(`failure containing next-secret`);
    });

    const result = setSecret('provider', 'next-secret');

    expect(result.ok).toBe(false);
    expect(result.error).not.toContain('next-secret');
    expect(getSecret('provider')).toBe('previous');
    expectVaultDirectoryClean();
    resetSecretsCacheForTests();
    expect(getSecret('provider')).toBe('previous');
  });

  it('fails closed when encryption fails without exposing or replacing the value', async () => {
    expect(setSecret('provider', 'previous')).toEqual({ ok: true });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { safeStorage } = await import('electron');
    vi.spyOn(safeStorage, 'encryptString').mockImplementationOnce(() => {
      throw new Error('encrypt failed with next-secret');
    });

    const result = setSecret('provider', 'next-secret');

    expect(result.ok).toBe(false);
    expect(result.error).not.toContain('next-secret');
    expect(getSecret('provider')).toBe('previous');
    expect(warn).not.toHaveBeenCalled();
  });

  it('keeps cache unchanged and leaves no temp file when directory fsync fails', () => {
    expect(setSecret('provider', 'previous')).toEqual({ ok: true });
    const actualFsync = fs.fsyncSync.bind(fs);
    let failedDirectorySync = false;
    vi.spyOn(fs, 'fsyncSync').mockImplementation((fd) => {
      if (!failedDirectorySync && fs.fstatSync(fd).isDirectory()) {
        failedDirectorySync = true;
        throw new Error('directory sync failed with next-secret');
      }
      return actualFsync(fd);
    });

    const result = setSecret('provider', 'next-secret');

    expect(result.ok).toBe(false);
    expect(result.error).not.toContain('next-secret');
    expect(getSecret('provider')).toBe('previous');
    expectVaultDirectoryClean();
    resetSecretsCacheForTests();
    expect(getSecret('provider')).toBe('previous');
  });

  it('does not report a deletion or mutate cache when durable publication fails', () => {
    expect(setSecret('provider', 'previous')).toEqual({ ok: true });
    vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw new Error('rename failed');
    });

    const result = deleteSecret('provider');

    expect(result.ok).toBe(false);
    expect(getSecret('provider')).toBe('previous');
    expectVaultDirectoryClean();
  });

  it('refuses deletion when secure storage is unavailable', () => {
    expect(setSecret('provider', 'previous')).toEqual({ ok: true });
    secretDeps.isAvailable = false;

    expect(deleteSecret('provider').ok).toBe(false);
    expect(getSecret('provider')).toBe('previous');
  });

  it('rejects the Linux basic_text backend instead of trusting weak ciphertext', () => {
    expect(isSecureStorageBackendAllowed('linux', () => 'basic_text')).toBe(false);
    expect(isSecureStorageBackendAllowed('linux', () => 'kwallet6')).toBe(true);
  });

  it('does not query the Linux-only backend on macOS', () => {
    const readBackend = vi.fn(() => {
      throw new Error('getSelectedStorageBackend is Linux-only');
    });

    expect(isSecureStorageBackendAllowed('darwin', readBackend)).toBe(true);
    expect(readBackend).not.toHaveBeenCalled();
  });

  it('fails closed without replacing a vault locked by another process', async () => {
    expect(setSecret('provider', 'previous')).toEqual({ ok: true });
    const competingProcess = spawn(
      process.execPath,
      [
        '-e',
        [
          "const Database = require('better-sqlite3')",
          'const lock = new Database(process.argv[1])',
          "lock.exec('BEGIN EXCLUSIVE')",
          "process.stdout.write('locked')",
          'const keepAlive = setInterval(() => undefined, 1_000)',
        ].join(';'),
        secretsLockFile,
      ],
      {
        cwd: process.cwd(),
        env: sanitizedChildEnvironment(),
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    await once(competingProcess.stdout, 'data');

    const result = setSecret('provider', 'next-secret');
    competingProcess.kill('SIGKILL');
    await once(competingProcess, 'exit');
    const retry = setSecret('second-provider', 'second-secret');

    expect(result.ok).toBe(false);
    expect(result.error).not.toContain('next-secret');
    expect(retry).toEqual({ ok: true });
    expect(fs.existsSync(secretsLockFile)).toBe(true);
    resetSecretsCacheForTests();
    expect(getSecret('provider')).toBe('previous');
    expect(getSecret('second-provider')).toBe('second-secret');
  });

  it('continues after an abandoned process lock is released by SQLite', () => {
    expect(setSecret('first-provider', 'first-secret')).toEqual({ ok: true });
    const abandonedProcess = new Database(secretsLockFile);
    abandonedProcess.exec('BEGIN EXCLUSIVE');
    abandonedProcess.close();

    const result = setSecret('second-provider', 'second-secret');

    expect(result).toEqual({ ok: true });
    resetSecretsCacheForTests();
    expect(getSecret('first-provider')).toBe('first-secret');
    expect(getSecret('second-provider')).toBe('second-secret');
    expect(fs.existsSync(secretsLockFile)).toBe(true);
    expectVaultDirectoryClean();
  });

  it('fails closed when the lock database is corrupt', () => {
    fs.mkdirSync(path.dirname(secretsLockFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(secretsLockFile, 'not-a-sqlite-database', { mode: 0o600 });

    const result = setSecret('provider', 'must-not-reach-disk');

    expect(result.ok).toBe(false);
    expect(fs.existsSync(secretsFile)).toBe(false);
    expect(fs.existsSync(secretsLockFile)).toBe(true);
    expect(getSecret('provider')).toBeNull();
  });
});
