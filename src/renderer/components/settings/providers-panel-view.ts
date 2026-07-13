import type { ProviderSettingsInfo } from '../../../shared/provider-settings-types';

/** Top-level Providers hub tabs (Overclock-style hierarchy). */
export type ProvidersHubTab = 'clis' | 'login' | 'remote';

export function isRemoteProvider(provider: ProviderSettingsInfo): boolean {
  return provider.kind === 'api-provider';
}

export function isLocalCliProvider(provider: ProviderSettingsInfo): boolean {
  return provider.kind === 'cli-pty';
}

/** CLIs where external browser/OAuth login is the primary path. */
export function isExternalLoginProvider(provider: ProviderSettingsInfo): boolean {
  if (!isLocalCliProvider(provider)) return false;
  return (
    provider.authStrategy === 'subscription' ||
    provider.authStrategy === 'login-needed' ||
    provider.authMethod === 'oauth' ||
    provider.authMethod === 'cli'
  );
}

export function countDetectedClis(
  providers: readonly ProviderSettingsInfo[],
): number {
  return providers.filter((p) => isLocalCliProvider(p) && p.installed).length;
}

export function filterProvidersForTab(
  providers: readonly ProviderSettingsInfo[],
  tab: ProvidersHubTab,
  options: { readonly showAbsent: boolean } = { showAbsent: false },
): ProviderSettingsInfo[] {
  const list = [...providers];
  if (tab === 'remote') {
    return list.filter(isRemoteProvider);
  }
  if (tab === 'login') {
    return list
      .filter(isExternalLoginProvider)
      .filter((p) => options.showAbsent || p.installed)
      .sort(compareProvidersForDisplay);
  }
  // CLIs: prefer installed; hide absent unless toggled.
  return list
    .filter(isLocalCliProvider)
    .filter((p) => options.showAbsent || p.installed)
    .sort(compareProvidersForDisplay);
}

function compareProvidersForDisplay(
  a: ProviderSettingsInfo,
  b: ProviderSettingsInfo,
): number {
  if (a.installed !== b.installed) return a.installed ? -1 : 1;
  if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
  return a.label.localeCompare(b.label, 'pt');
}

/**
 * Model readiness chip: available catalog size vs listed models.
 * When catalog metadata is incomplete, fall back to N/N (all listed).
 */
export function modelCountLabel(provider: ProviderSettingsInfo): string {
  const total = Math.max(0, provider.models.length);
  if (total === 0) return '0/0';
  const blocked = provider.models.filter((model) => {
    const availability = provider.modelInfo?.[model]?.availability;
    return availability === 'api-only' || availability === 'deprecated';
  }).length;
  const ready = Math.max(0, total - blocked);
  return `${ready}/${total}`;
}

export function providerStatusLabel(provider: ProviderSettingsInfo): {
  readonly label: string;
  readonly tone: 'ok' | 'warn' | 'muted';
} {
  if (!provider.installed && isLocalCliProvider(provider)) {
    return { label: 'ausente', tone: 'warn' };
  }
  if (!provider.enabled) return { label: 'off', tone: 'muted' };
  if (provider.authStrategy === 'login-needed') {
    return { label: 'login', tone: 'warn' };
  }
  return { label: 'ativo', tone: 'ok' };
}

export function pickDefaultSelection(
  providers: readonly ProviderSettingsInfo[],
  preferredId: string | null,
): string | null {
  if (preferredId && providers.some((p) => p.adapterId === preferredId)) {
    return preferredId;
  }
  const firstInstalled = providers.find((p) => p.installed);
  return firstInstalled?.adapterId ?? providers[0]?.adapterId ?? null;
}
