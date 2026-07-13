import { describe, expect, it } from 'vitest';
import type { ProviderSettingsInfo } from '../../../shared/provider-settings-types';
import {
  countDetectedClis,
  filterProvidersForTab,
  modelCountLabel,
  pickDefaultSelection,
  providerStatusLabel,
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
  });
  const missing = provider({
    adapterId: 'kimi',
    label: 'Kimi',
    kind: 'cli-pty',
    installed: false,
  });
  const glm = provider({
    adapterId: 'glm',
    label: 'GLM',
    kind: 'api-provider',
    installed: true,
  });

  it('counts only installed local CLIs', () => {
    expect(countDetectedClis([claude, missing, glm])).toBe(1);
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

  it('formats model readiness and status chips', () => {
    expect(modelCountLabel(claude)).toBe('3/3');
    expect(providerStatusLabel(claude)).toEqual({ label: 'ativo', tone: 'ok' });
    expect(providerStatusLabel(missing)).toEqual({
      label: 'ausente',
      tone: 'warn',
    });
  });

  it('picks a stable default selection preferring installed providers', () => {
    expect(pickDefaultSelection([missing, claude], null)).toBe('claude');
    expect(pickDefaultSelection([missing, claude], 'kimi')).toBe('kimi');
  });
});
