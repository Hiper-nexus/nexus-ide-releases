import type { ProviderConfig } from '../../shared/provider-settings-types';

export const PROVIDER_CONFIG_FORMAT_VERSION = 2;

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
  const source = isCurrent ? value.providers as Record<string, unknown> : value;
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
    // v1 was written while yolo/bypass was the implicit product default. It
    // cannot prove user consent, so migrate only dangerous modes to safe.
    if (!isCurrent && isDangerousPermissionMode(config.permissionMode)) {
      config.permissionMode = '';
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
