import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  hasManagedClaudeAuth,
  managedClaudeAuthDirectory,
  managedClaudeAuthHasCredential,
  validateManagedClaudeAuthDirectory,
} from './managed-claude-auth';

/**
 * Regressão de campo (21/09): duas contas Claude exibindo o MESMO consumo
 * (5h 3% · semanal 73% · Fable 48%), uma delas com a sessão comprovadamente
 * morta.
 *
 * Medido na máquina: `claude /usage` apontado por
 * `CLAUDE_SECURESTORAGE_CONFIG_DIR` para um diretório VAZIO não falha — ele
 * cai na credencial nativa. A sessão nativa respondia exatamente 3/73/48, os
 * números que apareceram nas duas linhas.
 *
 * `hasManagedClaudeAuth` só afirma que o diretório existe, e o diretório passa
 * a existir só de validá-lo. Portanto ele NÃO pode autorizar uma leitura
 * atribuída a uma conta.
 */

const HOMES: string[] = [];

function tempHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-claude-scope-'));
  HOMES.push(home);
  return home;
}

afterEach(() => {
  while (HOMES.length > 0) {
    const home = HOMES.pop();
    if (home) fs.rmSync(home, { recursive: true, force: true });
  }
});

function credentialBlob(expiresAt: number): string {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: 'sk-ant-oat-example',
      refreshToken: 'sk-ant-ort-example',
      expiresAt,
    },
  });
}

const NEVER = () => false;

describe('managed Claude scope must prove it holds a credential', () => {
  it('an empty scope is not an account, even though the directory exists', () => {
    const home = tempHome();
    const directory = managedClaudeAuthDirectory('acct-empty', home);
    validateManagedClaudeAuthDirectory(directory, home);

    // O contrato antigo dizia "sim" e liberava a sonda para cair na nativa.
    expect(hasManagedClaudeAuth('acct-empty', home)).toBe(true);
    expect(
      managedClaudeAuthHasCredential('acct-empty', { home, keychainProbe: NEVER }),
    ).toBe(false);
  });

  it('a scope holding a usable credential file is an account', () => {
    const home = tempHome();
    const directory = managedClaudeAuthDirectory('acct-real', home);
    validateManagedClaudeAuthDirectory(directory, home);
    fs.writeFileSync(
      path.join(directory, '.credentials.json'),
      credentialBlob(Date.now() + 3_600_000),
      { mode: 0o600 },
    );
    expect(
      managedClaudeAuthHasCredential('acct-real', { home, keychainProbe: NEVER }),
    ).toBe(true);
  });

  it('a scoped keychain item counts even with no file on disk', () => {
    const home = tempHome();
    validateManagedClaudeAuthDirectory(
      managedClaudeAuthDirectory('acct-keychain', home),
      home,
    );
    expect(
      managedClaudeAuthHasCredential('acct-keychain', {
        home,
        keychainProbe: () => true,
      }),
    ).toBe(true);
  });

  it('a missing scope is not an account', () => {
    const home = tempHome();
    expect(
      managedClaudeAuthHasCredential('acct-absent', { home, keychainProbe: NEVER }),
    ).toBe(false);
  });

  it('a credential file with no usable access token does not count', () => {
    const home = tempHome();
    const directory = managedClaudeAuthDirectory('acct-shell', home);
    validateManagedClaudeAuthDirectory(directory, home);
    // Casca que sobrevive ao logout: presença não é sessão.
    fs.writeFileSync(
      path.join(directory, '.credentials.json'),
      JSON.stringify({ claudeAiOauth: {} }),
      { mode: 0o600 },
    );
    expect(
      managedClaudeAuthHasCredential('acct-shell', { home, keychainProbe: NEVER }),
    ).toBe(false);
  });

  it('never throws on a hostile scope (symlinked credential)', () => {
    const home = tempHome();
    const directory = managedClaudeAuthDirectory('acct-link', home);
    validateManagedClaudeAuthDirectory(directory, home);
    const elsewhere = path.join(home, 'stolen.json');
    fs.writeFileSync(elsewhere, credentialBlob(Date.now() + 3_600_000));
    fs.symlinkSync(elsewhere, path.join(directory, '.credentials.json'));
    expect(() =>
      managedClaudeAuthHasCredential('acct-link', { home, keychainProbe: NEVER }),
    ).not.toThrow();
    expect(
      managedClaudeAuthHasCredential('acct-link', { home, keychainProbe: NEVER }),
    ).toBe(false);
  });
});
