import type { ProviderConfig } from '../../shared/provider-settings-types';

export const PROVIDER_CONFIG_FORMAT_VERSION = 3;

const DANGEROUS_PERMISSION_MODES = new Set(['yolo', 'bypass', 'auto']);

export interface DecodedProviderConfigFile {
  providers: Record<string, Partial<ProviderConfig>>;
  migrated: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function isDangerousPermissionMode(mode: string | undefined): boolean {
  return DANGEROUS_PERMISSION_MODES.has(mode?.trim().toLowerCase() ?? '');
}

export function decodeProviderConfigFile(value: unknown): DecodedProviderConfigFile {
  if (!isRecord(value)) return { providers: {}, migrated: false };
  const isCurrent =
    value.version === PROVIDER_CONFIG_FORMAT_VERSION && isRecord(value.providers);
  const isVersioned = typeof value.version === 'number' && isRecord(value.providers);
  const source = isVersioned ? value.providers as Record<string, unknown> : value;
  const providers: Record<string, Partial<ProviderConfig>> = {};
  for (const [adapterId, rawConfig] of Object.entries(source)) {
    // A malicious/corrupt providers.json key of __proto__/constructor/prototype
    // would otherwise reach the prototype of the result object.
    if (
      adapterId === '__proto__' ||
      adapterId === 'constructor' ||
      adapterId === 'prototype'
    ) {
      continue;
    }
    if (!isRecord(rawConfig)) continue;
    const config = { ...rawConfig } as Partial<ProviderConfig>;
    // v3 changes the product default to provider-native full-auto. An empty or
    // absent value in older files represented the former implicit safe default,
    // so drop it and let the adapter choose yolo/bypass/auto. Once written as
    // v3, an explicit empty value continues to mean the user selected Safe.
    if (!isCurrent && !config.permissionMode) {
      delete config.permissionMode;
    }
    providers[adapterId] = config;
  }
  return { providers, migrated: !isCurrent };
}

export function encodeProviderConfigFile(
  providers: Record<string, ProviderConfig>,
): { version: number; providers: Record<string, ProviderConfig> } {
  return { version: PROVIDER_CONFIG_FORMAT_VERSION, providers };
}
