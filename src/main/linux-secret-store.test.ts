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
    ['Hyprland (Omarchy)', { XDG_CURRENT_DESKTOP: 'Hyprland' }],
    ['sway', { XDG_CURRENT_DESKTOP: 'sway' }],
    ['niri', { XDG_CURRENT_DESKTOP: 'niri' }],
    // Chromium reconhece LXQt e mesmo assim escolhe basic_text.
    ['LXQt', { XDG_CURRENT_DESKTOP: 'LXQt' }],
    // Hyprland/sway abertos de um login KDE herdam KDE_FULL_SESSION=true: antes
    // isso desligava o override e o cofre caía em basic_text.
    ['Hyprland from a KDE login', { XDG_CURRENT_DESKTOP: 'Hyprland', KDE_FULL_SESSION: 'true' }],
    ['sway from a KDE login', { XDG_CURRENT_DESKTOP: 'sway', KDE_FULL_SESSION: 'true' }],
    ['only KDE_FULL_SESSION', { XDG_CURRENT_DESKTOP: '', KDE_FULL_SESSION: 'true' }],
    // O Chromium compara com caixa: "kde" minúsculo não é reconhecido.
    ['a lowercase kde value', { XDG_CURRENT_DESKTOP: 'plasma:kde' }],
    ['a session that does not name a desktop', {}],
  ])('selects libsecret on %s', (_name, env) => {
    expect(linuxPasswordStoreOverride(context({ env }))).toBe('gnome-libsecret');
  });

  it.each([
    ['XDG_CURRENT_DESKTOP=KDE', { XDG_CURRENT_DESKTOP: 'KDE' }],
    ['KDE 6', { XDG_CURRENT_DESKTOP: 'KDE', KDE_SESSION_VERSION: '6' }],
    ['GNOME (Chromium already picks libsecret)', { XDG_CURRENT_DESKTOP: 'GNOME' }],
    ['Ubuntu GNOME', { XDG_CURRENT_DESKTOP: 'ubuntu:GNOME' }],
  ])('leaves Chromium detection alone for %s', (_name, env) => {
    expect(linuxPasswordStoreOverride(context({ env }))).toBeNull();
  });

  it('honors an explicit KWallet generation chosen through NEXUS_LINUX_PASSWORD_STORE', () => {
    for (const store of ['kwallet', 'kwallet5', 'kwallet6', 'gnome-libsecret']) {
      expect(
        linuxPasswordStoreOverride(
          context({ env: { XDG_CURRENT_DESKTOP: 'KDE', NEXUS_LINUX_PASSWORD_STORE: ` ${store} ` } }),
        ),
      ).toBe(store);
    }
  });

  it('never lets the env preference pick basic_text', () => {
    expect(
      linuxPasswordStoreOverride(
        context({ env: { XDG_CURRENT_DESKTOP: 'Hyprland', NEXUS_LINUX_PASSWORD_STORE: 'basic' } }),
      ),
    ).toBe('gnome-libsecret');
    expect(
      linuxPasswordStoreOverride(
        context({ env: { XDG_CURRENT_DESKTOP: 'KDE', NEXUS_LINUX_PASSWORD_STORE: 'basic' } }),
      ),
    ).toBeNull();
  });

  it('never overrides an explicit --password-store from the operator', () => {
    expect(linuxPasswordStoreOverride(context({ hasExplicitStore: true }))).toBeNull();
    expect(
      linuxPasswordStoreOverride(
        context({
          hasExplicitStore: true,
          env: { XDG_CURRENT_DESKTOP: 'KDE', NEXUS_LINUX_PASSWORD_STORE: 'kwallet6' },
        }),
      ),
    ).toBeNull();
  });

  it('stays out of the packaged smoke and of other platforms', () => {
    expect(linuxPasswordStoreOverride(context({ automatedTest: true }))).toBeNull();
    expect(
      linuxPasswordStoreOverride(
        context({ automatedTest: true, env: { NEXUS_LINUX_PASSWORD_STORE: 'kwallet6' } }),
      ),
    ).toBeNull();
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
