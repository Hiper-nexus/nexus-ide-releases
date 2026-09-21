import { expect, it } from 'vitest';
import { codexDeviceLoginCommand } from './codex-login-command';

it('opens the built-in Codex login by device code inside the existing pane', () => {
  expect(codexDeviceLoginCommand('codex login', 'codex')).toBe('codex login --device-auth');
  expect(codexDeviceLoginCommand('  codex login  ', 'codex')).toBe('codex login --device-auth');
});

it('keeps an explicit login method and other adapters unchanged', () => {
  expect(codexDeviceLoginCommand('codex login --device-auth', 'codex')).toBe('codex login --device-auth');
  expect(codexDeviceLoginCommand('codex login --with-api-key', 'codex')).toBe('codex login --with-api-key');
  expect(codexDeviceLoginCommand('claude auth login', 'claude')).toBe('claude auth login');
  expect(codexDeviceLoginCommand('codex login', 'custom')).toBe('codex login');
});
