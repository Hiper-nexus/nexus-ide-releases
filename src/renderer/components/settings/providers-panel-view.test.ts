import { describe, expect, it } from 'vitest';
import type { ProviderSettingsInfo } from '../../../shared/provider-settings-types';
import {
  countDetectedClis,
  filterProvidersForTab,
  isExternalLoginProvider,
  modelCountLabel,
  pickDefaultSelection,
  providerStatusLabel,
  selectModelValue,
  tabDetectedLabel,
} from './providers-panel-view';

function provider(
  partial: Partial<ProviderSettingsInfo> &
    Pick<ProviderSettingsInfo, 'adapterId' | 'label' | 'kind'>,
): ProviderSettingsInfo {
  return {
    icon: '◆',
    enabled: true,
    installed: true,
    binPath: '',
    detectedBin: partial.adapterId,
    defaultModel: `${partial.adapterId}-default`,
    models: [`${partial.adapterId}-default`],
    extraArgs: [],
    keyEnvVar: null,
    hasKey: false,
    keyMasked: null,
    authMethod: 'cli',
    secureStorageAvailable: true,
    authStrategy: 'subscription',
    upstream: 'anthropic',
    routable: false,
    upstreams: [],
    permissionMode: '',
    permissionModes: [],
    effort: '',
    efforts: [],
    verbose: false,
    supportsVerbose: false,
    customModels: [],
    ...partial,
  };
}

describe('providers-panel-view', () => {
  const claude = provider({
    adapterId: 'claude',
    label: 'Claude',
    kind: 'cli-pty',
    installed: true,
    models: ['a', 'b', 'c'],
    authStrategy: 'subscription',
  });
  const shellLike = provider({
    adapterId: 'shell',
    label: 'Shell',
    kind: 'cli-pty',
    installed: true,
    authStrategy: 'api-key',
    authMethod: 'cli',
  });
  const missing = provider({
    adapterId: 'kimi',
    label: 'Kimi',
    kind: 'cli-pty',
    installed: false,
    authStrategy: 'login-needed',
  });
  const glm = provider({
    adapterId: 'glm',
    label: 'GLM',
    kind: 'api-provider',
    installed: true,
  });

  it('counts only installed local CLIs', () => {
    expect(countDetectedClis([claude, missing, glm, shellLike])).toBe(2);
  });

  it('does not treat every local CLI as external-login', () => {
    expect(isExternalLoginProvider(claude)).toBe(true);
    expect(isExternalLoginProvider(shellLike)).toBe(false);
    expect(isExternalLoginProvider(glm)).toBe(false);
  });

  it('hides absent CLIs by default and shows them when asked', () => {
    const hidden = filterProvidersForTab([claude, missing, glm], 'clis', {
      showAbsent: false,
    });
    expect(hidden.map((p) => p.adapterId)).toEqual(['claude']);

    const shown = filterProvidersForTab([claude, missing, glm], 'clis', {
      showAbsent: true,
    });
    expect(shown.map((p) => p.adapterId)).toEqual(['claude', 'kimi']);
  });

  it('isolates remote/API providers on their own tab', () => {
    const remotes = filterProvidersForTab([claude, missing, glm], 'remote');
    expect(remotes.map((p) => p.adapterId)).toEqual(['glm']);
  });

  it('login tab only lists subscription/oauth/login-needed CLIs', () => {
    const login = filterProvidersForTab(
      [claude, shellLike, missing, glm],
      'login',
      { showAbsent: true },
    );
    expect(login.map((p) => p.adapterId).sort()).toEqual(['claude', 'kimi']);
  });

  it('formats model readiness, status chips and select value', () => {
    expect(modelCountLabel(claude)).toBe('3/3');
    expect(providerStatusLabel(claude)).toEqual({ label: 'ativo', tone: 'ok' });
    expect(providerStatusLabel(missing)).toEqual({
      label: 'ausente',
      tone: 'warn',
    });
    // defaultModel "claude-default" is not in models ['a','b','c'] → first model
    expect(selectModelValue(claude)).toBe('a');
    expect(
      selectModelValue({
        ...claude,
        defaultModel: 'b',
        models: ['a', 'b'],
      }),
    ).toBe('b');
    expect(selectModelValue({ ...claude, models: [], defaultModel: 'x' })).toBe(
      '',
    );
  });

  it('labels detected counts per tab context', () => {
    const all = [claude, shellLike, missing, glm];
    expect(tabDetectedLabel('clis', all, 2)).toBe('2 detectados');
    expect(tabDetectedLabel('login', all, 1)).toBe('1 com login detectado');
    expect(tabDetectedLabel('remote', all, 1)).toBe('1 remoto');
  });

  it('picks a stable default selection preferring installed providers', () => {
    expect(pickDefaultSelection([missing, claude], null)).toBe('claude');
    expect(pickDefaultSelection([missing, claude], 'kimi')).toBe('kimi');
  });
});
