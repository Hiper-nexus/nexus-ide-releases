import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const fixture = vi.hoisted(() => ({ home: '' }));
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  const homedir = () => fixture.home;
  return { ...actual, homedir, default: { ...actual.default, homedir } };
});

/**
 * Regressão de campo (21/09): "fica pedindo o tempo inteiro permissão para o
 * Keychain e nunca loga".
 *
 * `find-generic-password -w` devolve o SEGREDO, então passa pela ACL do item e
 * pode abrir o diálogo de autorização do macOS. A leitura não tinha cache e
 * roda em caminhos quentes (snapshot de cota, preparo de spawn, sondas). Uma
 * negação virava `null` = "não logado", que dispara login, que lê de novo:
 * laço de prompts que nunca conclui.
 */

const execFileSync = vi.fn();

vi.mock('node:child_process', () => ({
  execFileSync: (...args: unknown[]) => execFileSync(...args),
  spawnSync: vi.fn(() => ({ status: 0 })),
}));

const BLOB = JSON.stringify({
  claudeAiOauth: { accessToken: 'sk-ant-oat-1', expiresAt: 2_000_000_000_000 },
});

function denied(): Error & { status: number } {
  return Object.assign(new Error('User interaction is not allowed.'), { status: 51 });
}

function absent(): Error & { status: number } {
  return Object.assign(new Error('could not be found'), { status: 44 });
}

let credential: typeof import('./claude-credential');

beforeEach(async () => {
  // Keychain denial falls back to ~/.claude/.credentials.json. A real HOME
  // makes the assertions machine-dependent and can print a real login blob.
  fixture.home = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-keychain-cache-'));
  vi.resetModules();
  execFileSync.mockReset();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-21T12:00:00Z'));
  credential = await import('./claude-credential');
  credential.invalidateClaudeCredentialCache();
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(fixture.home, { recursive: true, force: true });
});

const onMac = process.platform === 'darwin';
const onlyMac = onMac ? it : it.skip;

describe('Claude keychain reads are memoized (prompt storm)', () => {
  onlyMac('reads the item once for a burst of callers', () => {
    execFileSync.mockReturnValue(BLOB);
    for (let i = 0; i < 20; i += 1) {
      expect(credential.readActiveClaudeCredential()).toBe(BLOB);
    }
    expect(execFileSync).toHaveBeenCalledTimes(1);
  });

  onlyMac('does not reopen the dialog on every call after a denial', () => {
    execFileSync.mockImplementation(() => {
      throw denied();
    });
    for (let i = 0; i < 25; i += 1) {
      expect(credential.readActiveClaudeCredential()).toBeNull();
    }
    // Uma tentativa, não vinte e cinco: é o que interrompe a enxurrada.
    expect(execFileSync).toHaveBeenCalledTimes(1);

    // O recuo é longo, mas não permanente.
    vi.advanceTimersByTime(5 * 60_000 + 1);
    credential.readActiveClaudeCredential();
    expect(execFileSync).toHaveBeenCalledTimes(2);
  });

  onlyMac('retries an absent item on the short window, not the long backoff', () => {
    execFileSync.mockImplementation(() => {
      throw absent();
    });
    expect(credential.readActiveClaudeCredential()).toBeNull();
    expect(execFileSync).toHaveBeenCalledTimes(1);

    // Item ausente não custa diálogo: reconsultar cedo é barato e permite
    // que um login recém-feito apareça rápido.
    vi.advanceTimersByTime(15_001);
    execFileSync.mockReturnValue(BLOB);
    expect(credential.readActiveClaudeCredential()).toBe(BLOB);
  });

  onlyMac('a fresh read is served for a short window only', () => {
    execFileSync.mockReturnValue(BLOB);
    credential.readActiveClaudeCredential();
    vi.advanceTimersByTime(15_001);
    credential.readActiveClaudeCredential();
    expect(execFileSync).toHaveBeenCalledTimes(2);
  });

  onlyMac('never serves the previous account after a write', () => {
    execFileSync.mockReturnValue(BLOB);
    expect(credential.readActiveClaudeCredential()).toBe(BLOB);

    const next = JSON.stringify({
      claudeAiOauth: { accessToken: 'sk-ant-oat-2', expiresAt: 2_000_000_000_000 },
    });
    execFileSync.mockReturnValue(next);
    credential.writeActiveClaudeCredential(next);

    // Sem invalidação, a troca de conta continuaria servindo o blob anterior.
    expect(credential.readActiveClaudeCredential()).toBe(next);
  });

  onlyMac('keeps managed scopes on separate cache entries', () => {
    const dir = '/Users/example/.nexus/managed-accounts/claude/acct-1/auth';
    execFileSync.mockReturnValue(BLOB);
    credential.readActiveClaudeCredential();
    credential.readManagedClaudeCredential(dir);
    // Serviços diferentes = duas leituras; um escopo não responde pelo outro.
    expect(execFileSync).toHaveBeenCalledTimes(2);
  });
});
