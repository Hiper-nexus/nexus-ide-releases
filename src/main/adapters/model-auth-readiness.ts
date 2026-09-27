/**
 * Models served by OpenCode itself that are explicitly known to work without
 * a provider credential.
 *
 * This is intentionally an exact, release-pinned allowlist. Do not infer
 * credentialless access from the `opencode/` namespace or a `-free` suffix.
 * Verified against OpenCode 1.18.0's first-party catalog on 2026-07-25;
 * ids ausentes de `opencode models` em 2026-09-27 foram removidos (só
 * estreita — ids novos exigem prova de uso sem credencial).
 */
export const CREDENTIALLESS_OPENCODE_MODEL_IDS = Object.freeze([
  "opencode/big-pickle",
  "opencode/nemotron-3-ultra-free",
] as const);

const credentiallessOpenCodeModels = new Set<string>(
  CREDENTIALLESS_OPENCODE_MODEL_IDS,
);

export function isCredentiallessOpenCodeModel(
  adapterId: string,
  model: string | null | undefined,
): boolean {
  if (adapterId !== "opencode" || typeof model !== "string") return false;
  return credentiallessOpenCodeModels.has(model.trim());
}

/**
 * Model-aware replacement for the old global `authStrategy !== login-needed`
 * check. Explicit model readiness remains provider-agnostic; unauthenticated
 * OpenCode is the only credentialless exception.
 */
export function isProviderAuthReadyForModel(
  provider: {
    readonly adapterId: string;
    readonly authStrategy: string;
    readonly authReadyModels?: readonly string[];
  },
  model: string | null | undefined,
): boolean {
  if (Array.isArray(provider.authReadyModels)) {
    return (
      typeof model === "string" &&
      provider.authReadyModels.includes(model.trim())
    );
  }
  return (
    provider.authStrategy !== "login-needed" ||
    isCredentiallessOpenCodeModel(provider.adapterId, model)
  );
}

export function authReadyModelsForProvider(
  provider: {
    readonly adapterId: string;
    readonly authStrategy: string;
    readonly authReadyModels?: readonly string[];
  },
  models: readonly string[],
): readonly string[] {
  if (Array.isArray(provider.authReadyModels)) {
    const ready = new Set(provider.authReadyModels);
    return Object.freeze(models.filter((model) => ready.has(model)));
  }
  if (provider.authStrategy !== "login-needed") return models;
  if (provider.adapterId !== "opencode") return Object.freeze([]);
  return Object.freeze(
    models.filter((model) =>
      isCredentiallessOpenCodeModel(provider.adapterId, model),
    ),
  );
}
