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
  'opencode',
] as const;

const KEY_ONLY_IDS = ['aider', 'glm', 'longcat'] as const;

describe('builtin CLI login commands', () => {
  const adapters = BUILTIN_ADAPTERS.map((raw) => adapterSchema.parse(raw));

  it('parses every builtin adapter', () => {
    expect(adapters.map((a) => a.id).sort()).toEqual(
      [...SESSION_LOGIN_IDS, ...KEY_ONLY_IDS].sort(),
    );
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
});
