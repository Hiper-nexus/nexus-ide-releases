import type { ProviderSettingsInfo } from '../../../shared/provider-settings-types';

/** Top-level Providers hub tabs (ADE libre hierarchy). */
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
 * CLIs with a real login path (OAuth/device/subscription or a declared
 * terminal command). API-key-only tools stay on CLIs / Remotos.
 */
export function isExternalLoginProvider(provider: ProviderSettingsInfo): boolean {
  if (!isLocalCliProvider(provider)) return false;
  if (provider.loginCommand) return true;
  if (
    provider.authMethod === 'oauth' ||
    provider.authMethod === 'device_code' ||
    provider.authMethod === 'subscription'
  ) {
    return true;
  }
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

/**
 * Conta com credencial morta (refresh falhou) num provider que se diz
 * conectado: a linha não pode continuar "conectado".
 */
export interface ProviderAccountHealth {
  readonly needsRelogin?: boolean;
}

export function providerStatusLabel(
  provider: ProviderSettingsInfo,
  health?: ProviderAccountHealth,
): {
  readonly label: string;
  readonly tone: 'ok' | 'warn' | 'muted' | 'danger';
} {
  if (!provider.installed && isLocalCliProvider(provider)) {
    return { label: 'não instalada', tone: 'warn' };
  }
  if (!provider.enabled) return { label: 'desligada', tone: 'muted' };
  if (provider.authStrategy === 'login-needed') {
    return { label: 'precisa login', tone: 'warn' };
  }
  if (health?.needsRelogin) {
    return { label: 'sessão expirada', tone: 'danger' };
  }
  return { label: 'conectado', tone: 'ok' };
}

export type ProviderRowCta =
  | { readonly kind: 'login'; readonly label: string }
  | { readonly kind: 'key'; readonly label: string }
  | { readonly kind: 'install'; readonly label: string };

/** One operator action per row — or none when there is nothing to do. */
export function providerRowCta(
  provider: ProviderSettingsInfo,
  health?: ProviderAccountHealth,
): ProviderRowCta | null {
  if (!provider.installed && isLocalCliProvider(provider)) {
    return provider.canAutoInstall
      ? { kind: 'install', label: 'Instalar' }
      : null;
  }
  if (!provider.enabled) return null;
  if (provider.authStrategy === 'login-needed') {
    if (provider.loginCommand) return { kind: 'login', label: 'Entrar' };
    if (provider.keyEnvVar) return { kind: 'key', label: 'Colar chave' };
  }
  // Linha "conectada" com sessão morta: o CTA some se depender só do
  // provider — a conta avisa que o re-login é pelo mesmo terminal de login.
  if (health?.needsRelogin && provider.loginCommand) {
    return { kind: 'login', label: 'Entrar novamente' };
  }
  if (
    !isLocalCliProvider(provider) &&
    provider.keyEnvVar &&
    !provider.hasKey
  ) {
    return { kind: 'key', label: 'Colar chave' };
  }
  return null;
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
