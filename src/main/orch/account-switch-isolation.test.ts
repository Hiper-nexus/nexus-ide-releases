/**
 * F-1569: trocar a conta Claude de UM pane nunca toca o estado global nem a
 * credencial de outro pane. Incidente de 18/10: o Maestro, numa conta
 * gerenciada, caiu em "Login expired" e o operador rodou /login com OUTRA
 * conta dentro do pane. A suspeita era a troca escrever no item nativo
 * "Claude Code-credentials" do Keychain ou no ~/.claude.json real e derrubar
 * os demais panes ("signed-in account changed on this machine").
 *
 * Caminho físico da troca (o failover só decide; quem materializa é o spawn):
 * escopo gerenciado da conta nova (`materializeManagedClaudeAuth`), HOME
 * efêmero do pane novo (`prepareEphemeralHome`) e o fechamento do pane velho
 * (`cleanupSessionArtifacts`). HOME temporário e Keychain falso: o `security`
 * real nunca roda.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const keychain = vi.hoisted(() => ({
  items: new Map<string, string>(),
  writes: [] as string[],
  deletes: [] as string[],
}));

vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>();
  const absent = () => Object.assign(new Error('item not found'), { status: 44 });
  const unquote = (value: string) => value.replace(/\\(.)/g, '$1');
  const execFileSync = ((file: string, args: readonly string[] = [], options?: unknown) => {
    if (file !== 'security') return (original.execFileSync as (...a: unknown[]) => unknown)(file, args, options);
    const service = args[args.indexOf('-s') + 1] ?? '';
    if (args[0] === 'find-generic-password') {
      const blob = keychain.items.get(service);
      if (blob === undefined) throw absent();
      return args.includes('-w') ? `${blob}\n` : '';
    }
    if (args[0] === 'delete-generic-password') {
      keychain.deletes.push(service);
      keychain.items.delete(service);
      return '';
    }
    throw new Error(`security ${args[0]} fora do fake`);
  }) as typeof original.execFileSync;
  const spawnSync = ((file: string, args: readonly string[] = [], options?: { input?: string }) => {
    if (file !== 'security') return (original.spawnSync as (...a: unknown[]) => unknown)(file, args, options);
    if (args[0] === '-i') {
      const line = /^add-generic-password -U -s "((?:[^"\\]|\\.)*)" -a "(?:[^"\\]|\\.)*" -w "((?:[^"\\]|\\.)*)"\n$/
        .exec(String(options?.input ?? ''));
      if (!line) return { status: 1 };
      const service = unquote(line[1]!);
      keychain.writes.push(service);
      keychain.items.set(service, unquote(line[2]!));
      return { status: 0 };
    }
    if (args[0] === 'find-generic-password') {
      return { status: keychain.items.has(args[args.indexOf('-s') + 1] ?? '') ? 0 : 44 };
    }
    return { status: 1 };
  }) as typeof original.spawnSync;
  return { ...original, default: { ...original, execFileSync, spawnSync }, execFileSync, spawnSync };
});

import {
  CLAUDE_KEYCHAIN_SERVICE,
  invalidateClaudeCredentialCache,
  managedClaudeKeychainService,
} from '../adapters/claude-credential';
import { materializeManagedClaudeAuth } from '../adapters/managed-claude-auth';
import { cleanupSessionArtifacts, prepareEphemeralHome } from './hooks-gen';

const OLD_PANE = 'switch-old-a-maestro';
const NEW_PANE = 'switch-new-b-maestro';
const SIBLING_PANE = 'switch-sib-a-worker1';

const blob = (name: string, expiresAt: number) => JSON.stringify({
  claudeAiOauth: { accessToken: `fixture-${name}`, refreshToken: `fixture-refresh-${name}`, expiresAt },
});

let home: string;

function read(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-account-switch-'));
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  keychain.items.clear();
  keychain.writes.length = 0;
  keychain.deletes.length = 0;
  invalidateClaudeCredentialCache();
});

afterEach(() => {
  for (const token of [OLD_PANE, NEW_PANE, SIBLING_PANE]) cleanupSessionArtifacts(token);
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true });
});

describe('F-1569: troca de conta de um pane e o estado global', () => {
  it('a conta nova vai só para o escopo dela; nativo, Keychain global e a irmã ficam intactos', () => {
    // Estado global: login nativo (identidade em ~/.claude.json, segredo no
    // item nativo do Keychain e no arquivo) e a login keychain do usuário.
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(home, 'Library', 'Keychains'), { recursive: true });
    const realProfile = path.join(home, '.claude.json');
    const realCredentials = path.join(home, '.claude', '.credentials.json');
    const loginDb = path.join(home, 'Library', 'Keychains', 'login.keychain-db');
    fs.writeFileSync(realProfile, JSON.stringify({ oauthAccount: { emailAddress: 'native@example.test' }, userID: 'native' }));
    fs.writeFileSync(realCredentials, blob('native', 100));
    fs.writeFileSync(loginDb, 'login-db-fixture');
    keychain.items.set(CLAUDE_KEYCHAIN_SERVICE, blob('native', 100));

    // Maestro e um worker irmão na conta gerenciada A.
    const a = materializeManagedClaudeAuth('account-a', blob('a', 100));
    const sibling = prepareEphemeralHome(SIBLING_PANE, {}, {
      carryNativeClaudeAuth: true, managedClaudeAuthDir: a.directory, gateHooks: false,
    });
    const old = prepareEphemeralHome(OLD_PANE, {}, {
      carryNativeClaudeAuth: true, managedClaudeAuthDir: a.directory, gateHooks: false,
    });
    const serviceA = managedClaudeKeychainService(a.directory);
    // Escopo da conta B já existia com um token mais velho que o do cofre.
    const directoryB = path.join(home, '.nexus', 'managed-accounts', 'claude', 'account-b', 'auth');
    const serviceB = managedClaudeKeychainService(directoryB);
    keychain.items.set(serviceB, blob('b-old', 50));

    const before = {
      profile: read(realProfile),
      credentials: read(realCredentials),
      loginDb: read(loginDb),
      nativeItem: keychain.items.get(CLAUDE_KEYCHAIN_SERVICE),
      scopeAFile: read(path.join(a.directory, '.credentials.json')),
      scopeAItem: keychain.items.get(serviceA),
      siblingProfile: read(path.join(sibling.dir, '.claude.json')),
    };
    keychain.writes.length = 0;

    // A CLI do Maestro gravou OUTRA identidade no overlay dele (o /login manual
    // do incidente) — o fechamento não pode levá-la ao perfil real.
    fs.writeFileSync(path.join(old.dir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'other@example.test' } }));

    // A troca: escopo da conta B, HOME do pane novo, fechamento do velho.
    const b = materializeManagedClaudeAuth('account-b', blob('b', 200));
    const next = prepareEphemeralHome(NEW_PANE, {}, {
      carryNativeClaudeAuth: true, managedClaudeAuthDir: b.directory, gateHooks: false,
    });
    cleanupSessionArtifacts(OLD_PANE);

    expect(b.directory).toBe(directoryB);
    expect(b.env).toEqual({ CLAUDE_SECURESTORAGE_CONFIG_DIR: directoryB });
    // Keychain: nada no item nativo; só o escopo da conta B foi escrito.
    expect(keychain.writes).not.toContain(CLAUDE_KEYCHAIN_SERVICE);
    expect(keychain.deletes).toEqual([]);
    if (process.platform === 'darwin') expect(keychain.writes).toEqual([serviceB]);
    expect(keychain.items.get(CLAUDE_KEYCHAIN_SERVICE)).toBe(before.nativeItem);
    // Arquivos globais byte a byte.
    expect(read(realProfile)).toBe(before.profile);
    expect(read(realCredentials)).toBe(before.credentials);
    expect(read(loginDb)).toBe(before.loginDb);
    // A irmã na conta A segue com a mesma credencial e o mesmo HOME.
    expect(read(path.join(a.directory, '.credentials.json'))).toBe(before.scopeAFile);
    expect(keychain.items.get(serviceA)).toBe(before.scopeAItem);
    expect(read(path.join(sibling.dir, '.claude.json'))).toBe(before.siblingProfile);
    // O pane novo não herda a identidade nativa.
    expect(JSON.parse(read(path.join(next.dir, '.claude.json')) ?? '{}').oauthAccount).toBeUndefined();
    expect(fs.existsSync(old.dir)).toBe(false);
  });
});
