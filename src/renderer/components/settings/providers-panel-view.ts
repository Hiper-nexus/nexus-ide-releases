import type { ProviderSettingsInfo } from '../../../shared/provider-settings-types';

/** Top-level Providers hub tabs (Overclock-style hierarchy). */
export type ProvidersHubTab = 'clis' | 'login' | 'remote';

export const PROVIDERS_HUB_TABS: readonly ProvidersHubTab[] = [
  'clis',
  'login',
  'remote',
] as const;

export function isRemoteProvider(provider: ProviderSettingsInfo): boolean {
  return provider.kind === 'api-provider';
}

export function isLocalCliProvider(provider: ProviderSettingsInfo): boolean {
  return provider.kind === 'cli-pty';
}

/**
 * CLIs whose primary path is browser/OAuth subscription login — not every
 * local CLI (authMethod "cli" alone would make Login ≈ CLIs).
 */
export function isExternalLoginProvider(provider: ProviderSettingsInfo): boolean {
  if (!isLocalCliProvider(provider)) return false;
  if (provider.authMethod === 'oauth') return true;
  return (
    provider.authStrategy === 'subscription' ||
    provider.authStrategy === 'login-needed'
  );
}

export function countDetectedClis(
  providers: readonly ProviderSettingsInfo[],
): number {
  return providers.filter((p) => isLocalCliProvider(p) && p.installed).length;
}

/** Toolbar counter label for the active tab. */
export function tabDetectedLabel(
  tab: ProvidersHubTab,
  providers: readonly ProviderSettingsInfo[],
  visibleCount: number,
): string {
  if (tab === 'remote') {
    return `${visibleCount} remoto${visibleCount === 1 ? '' : 's'}`;
  }
  if (tab === 'login') {
    const n = providers.filter(
      (p) => isExternalLoginProvider(p) && p.installed,
    ).length;
    return `${n} com login detectado${n === 1 ? '' : 's'}`;
  }
  const n = countDetectedClis(providers);
  return `${n} detectado${n === 1 ? '' : 's'}`;
}

export function filterProvidersForTab(
  providers: readonly ProviderSettingsInfo[],
  tab: ProvidersHubTab,
  options: { readonly showAbsent: boolean } = { showAbsent: false },
): ProviderSettingsInfo[] {
  if (tab === 'remote') {
    return providers.filter(isRemoteProvider).sort(compareProvidersForDisplay);
  }
  if (tab === 'login') {
    return providers
      .filter(isExternalLoginProvider)
      .filter((p) => options.showAbsent || p.installed)
      .sort(compareProvidersForDisplay);
  }
  return providers
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
 * Model readiness chip: ready catalog entries vs listed models.
 * api-only / deprecated count as not ready for auto-routing.
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

/** Safe value for a <select> when models list is empty or stale. */
export function selectModelValue(provider: ProviderSettingsInfo): string {
  if (provider.models.includes(provider.defaultModel)) {
    return provider.defaultModel;
  }
  return provider.models[0] ?? '';
}
