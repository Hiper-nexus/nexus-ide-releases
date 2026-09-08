import { describe, expect, it } from 'vitest';
import { adapterSchema } from '../../shared/adapter-types';
import { accountLoginCommandFor } from '../../shared/account-login-commands';
import { resolveCliLoginCommand } from '../../shared/cli-login';
import { BUILTIN_ADAPTERS } from './index';

const SESSION_LOGIN_IDS = [
  'agy',
  'claude',
  'codex',
  'grok',
  'kimi',
  'muse',
  'opencode',
  'openclaude',
] as const;

const KEY_ONLY_IDS = ['aider', 'glm', 'longcat'] as const;

describe('builtin CLI login commands', () => {
  const adapters = BUILTIN_ADAPTERS.map((raw) => adapterSchema.parse(raw));

  it('parses every builtin adapter', () => {
    // Login commands são conceito de CLI local; os api-providers (deepseek,
    // qwen) existem para gestão de key na aba Remotos e ficam fora desta lista.
    const cliIds = adapters
      .filter((a) => a.kind === 'cli-pty')
      .map((a) => a.id)
      .sort();
    expect(cliIds).toEqual([...SESSION_LOGIN_IDS, ...KEY_ONLY_IDS].sort());
  });

  it('api-providers remotos declaram endpoint e auth de key', () => {
    const remotes = adapters.filter((a) => a.kind === 'api-provider');
    expect(remotes.map((a) => a.id).sort()).toEqual(['deepseek', 'qwen']);
    for (const adapter of remotes) {
      if (adapter.kind !== 'api-provider') continue;
      expect(adapter.endpoint.startsWith('https://')).toBe(true);
      expect(adapter.auth.method).toBe('api_key');
      expect(adapter.auth.keychainKey).toBe(adapter.id);
    }
  });

  it('session CLIs resolve a safe terminal login command', () => {
    for (const id of SESSION_LOGIN_IDS) {
      const adapter = adapters.find((item) => item.id === id);
      expect(adapter?.kind).toBe('cli-pty');
      if (adapter?.kind !== 'cli-pty') continue;
      const command = resolveCliLoginCommand({
        loginCommand: adapter.auth.loginCommand,
        authMethod: adapter.auth.method,
        interactive: adapter.spawn.interactive,
      });
      expect(command, id).toBeTruthy();
      expect(command, id).toBe(accountLoginCommandFor(id));
    }
  });

  it('key-only CLIs do not pretend to have a terminal login', () => {
    for (const id of KEY_ONLY_IDS) {
      const adapter = adapters.find((item) => item.id === id);
      expect(adapter?.kind).toBe('cli-pty');
      if (adapter?.kind !== 'cli-pty') continue;
      expect(
        resolveCliLoginCommand({
          loginCommand: adapter.auth.loginCommand,
          authMethod: adapter.auth.method,
          interactive: adapter.spawn.interactive,
        }),
        id,
      ).toBeNull();
      expect(accountLoginCommandFor(id)).toBeNull();
    }
  });

  it('Claude uses the dedicated auth subcommand, not a slash prompt', () => {
    expect(accountLoginCommandFor('claude')).toBe('claude auth login');
  });

  it('OpenClaude logs in with its own binary, not claude auth login', () => {
    expect(accountLoginCommandFor('openclaude')).toBe('openclaude auth login');
  });
});
