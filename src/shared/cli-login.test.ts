import { describe, expect, it } from 'vitest';
import {
  cliLoginLooksComplete,
  resolveCliLoginCommand,
  shouldFinishCliLoginWatch,
} from './cli-login';

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

describe('cliLoginLooksComplete', () => {
  it('recognizes Cursor Agent finishing inside a live shell', () => {
    expect(
      cliLoginLooksComplete(
        '✓ Logged in as admin@volarehost.com.br\nAuthentication tokens stored securely.\n%',
      ),
    ).toBe(true);
  });

  it('ignores a CLI merely talking about login', () => {
    expect(cliLoginLooksComplete('Select login method')).toBe(false);
    expect(cliLoginLooksComplete('waiting for authentication')).toBe(false);
    expect(cliLoginLooksComplete('cursor-agent login')).toBe(false);
  });
});

describe('shouldFinishCliLoginWatch', () => {
  const idle = {
    output: '',
    paneStillOpen: true,
    paneExited: false,
    authReady: false,
  };

  it('keeps watching a live shell that has not logged in yet', () => {
    expect(shouldFinishCliLoginWatch(idle)).toBe(false);
  });

  it('finishes when the CLI prints success, even if the shell stays open', () => {
    expect(
      shouldFinishCliLoginWatch({
        ...idle,
        output: 'Logged in as admin@volarehost.com.br',
      }),
    ).toBe(true);
  });

  it('finishes when the session probe flips to ready', () => {
    expect(shouldFinishCliLoginWatch({ ...idle, authReady: true })).toBe(true);
  });

  it('finishes when the pane dies or is closed', () => {
    expect(shouldFinishCliLoginWatch({ ...idle, paneExited: true })).toBe(true);
    expect(shouldFinishCliLoginWatch({ ...idle, paneStillOpen: false })).toBe(
      true,
    );
  });
});
