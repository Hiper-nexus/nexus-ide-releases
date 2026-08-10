import { describe, expect, it } from 'vitest';
import { resolveCliLoginCommand } from './cli-login';

describe('resolveCliLoginCommand', () => {
  it('uses the command declared by the adapter, whatever the auth method is', () => {
    expect(
      resolveCliLoginCommand({
        loginCommand: 'codex login',
        authMethod: 'api_key',
        interactive: ['codex'],
      }),
    ).toBe('codex login');
  });

  it('falls back to the interactive binary when the CLI logs in on first run', () => {
    for (const method of ['oauth', 'subscription', 'device_code']) {
      expect(
        resolveCliLoginCommand({
          authMethod: method,
          interactive: ['qwen', '--model', '{{MODEL}}'],
        }),
      ).toBe('qwen');
    }
  });

  it('offers no terminal login for key-only CLIs — there the path is the key', () => {
    expect(
      resolveCliLoginCommand({
        authMethod: 'api_key',
        interactive: ['claude', '--model', '{{MODEL}}'],
      }),
    ).toBeNull();
    expect(
      resolveCliLoginCommand({ authMethod: 'none', interactive: ['aider'] }),
    ).toBeNull();
  });

  it('returns null when there is nothing to run', () => {
    expect(resolveCliLoginCommand({ authMethod: 'oauth' })).toBeNull();
    expect(
      resolveCliLoginCommand({ authMethod: 'oauth', interactive: [] }),
    ).toBeNull();
    expect(
      resolveCliLoginCommand({ authMethod: 'oauth', interactive: ['   '] }),
    ).toBeNull();
  });

  it('refuses a declared command that would run more than one line', () => {
    expect(
      resolveCliLoginCommand({ loginCommand: 'codex login\nrm -rf /' }),
    ).toBeNull();
    expect(
      resolveCliLoginCommand({ loginCommand: 'codex login\r\nwhoami' }),
    ).toBeNull();
  });

  it('refuses a command carrying an unresolved template placeholder', () => {
    expect(
      resolveCliLoginCommand({ loginCommand: 'glm --model {{MODEL}} login' }),
    ).toBeNull();
  });

  it('refuses an absurdly long command', () => {
    expect(
      resolveCliLoginCommand({ loginCommand: `login ${'x'.repeat(300)}` }),
    ).toBeNull();
  });
});
