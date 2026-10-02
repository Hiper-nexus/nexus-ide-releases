import { describe, expect, it, vi } from 'vitest';
import {
  configureLinuxSecretStore,
  linuxPasswordStoreOverride,
  type LinuxSecretStoreContext,
} from './linux-secret-store';

function context(overrides: Partial<LinuxSecretStoreContext> = {}): LinuxSecretStoreContext {
  return {
    platform: 'linux',
    env: { XDG_CURRENT_DESKTOP: 'Hyprland' },
    hasExplicitStore: false,
    automatedTest: false,
    ...overrides,
  };
}

describe('linuxPasswordStoreOverride', () => {
  it.each([
    ['Hyprland (Omarchy)', 'Hyprland'],
    ['sway', 'sway'],
    ['niri', 'niri'],
    ['LXQt', 'LXQt'],
    ['GNOME (same choice Chromium makes on its own)', 'GNOME'],
    ['Ubuntu GNOME', 'ubuntu:GNOME'],
  ])('selects libsecret on %s', (_name, desktop) => {
    expect(linuxPasswordStoreOverride(context({ env: { XDG_CURRENT_DESKTOP: desktop } }))).toBe(
      'gnome-libsecret',
    );
  });

  it('selects libsecret when the session does not name a desktop at all', () => {
    expect(linuxPasswordStoreOverride(context({ env: {} }))).toBe('gnome-libsecret');
  });

  it.each([
    ['XDG_CURRENT_DESKTOP=KDE', { XDG_CURRENT_DESKTOP: 'KDE' }],
    ['a composite KDE value', { XDG_CURRENT_DESKTOP: 'plasma:kde' }],
    ['KDE_FULL_SESSION', { XDG_CURRENT_DESKTOP: '', KDE_FULL_SESSION: 'true' }],
  ])('leaves KWallet detection alone for %s', (_name, env) => {
    expect(linuxPasswordStoreOverride(context({ env }))).toBeNull();
  });

  it('never overrides an explicit --password-store from the operator', () => {
    expect(linuxPasswordStoreOverride(context({ hasExplicitStore: true }))).toBeNull();
  });

  it('stays out of the packaged smoke and of other platforms', () => {
    expect(linuxPasswordStoreOverride(context({ automatedTest: true }))).toBeNull();
    expect(linuxPasswordStoreOverride(context({ platform: 'darwin' }))).toBeNull();
    expect(linuxPasswordStoreOverride(context({ platform: 'win32' }))).toBeNull();
  });
});

describe('configureLinuxSecretStore', () => {
  const base = { platform: 'linux' as const, env: { XDG_CURRENT_DESKTOP: 'Hyprland' }, automatedTest: false };

  it('appends the switch once on a desktop Chromium would leave on basic_text', () => {
    const commandLine = { hasSwitch: vi.fn(() => false), appendSwitch: vi.fn() };
    expect(configureLinuxSecretStore(commandLine, base)).toBe('gnome-libsecret');
    expect(commandLine.appendSwitch).toHaveBeenCalledExactlyOnceWith(
      'password-store',
      'gnome-libsecret',
    );
  });

  it('does not touch the command line when the operator already chose', () => {
    const commandLine = { hasSwitch: vi.fn(() => true), appendSwitch: vi.fn() };
    expect(configureLinuxSecretStore(commandLine, base)).toBeNull();
    expect(commandLine.hasSwitch).toHaveBeenCalledWith('password-store');
    expect(commandLine.appendSwitch).not.toHaveBeenCalled();
  });
});
