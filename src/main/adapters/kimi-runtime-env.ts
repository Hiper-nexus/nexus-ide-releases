/**
 * Environment variables understood by Kimi Code's explicit transient-model
 * channel. Ordinary KIMI_API_KEY/MOONSHOT_API_KEY shell variables are not
 * provider credentials in current Kimi Code releases.
 *
 * Keep this list complete so an OAuth-backed pane cannot be redirected to a
 * transient API-key provider inherited from the Nexus process.
 */
export const KIMI_TRANSIENT_MODEL_ENV_KEYS = [
  'KIMI_MODEL_NAME',
  'KIMI_MODEL_API_KEY',
  'KIMI_MODEL_PROVIDER_TYPE',
  'KIMI_MODEL_BASE_URL',
  'KIMI_MODEL_MAX_CONTEXT_SIZE',
  'KIMI_MODEL_CAPABILITIES',
  'KIMI_MODEL_DISPLAY_NAME',
  'KIMI_MODEL_MAX_OUTPUT_SIZE',
  'KIMI_MODEL_REASONING_KEY',
  'KIMI_MODEL_THINKING_EFFORT',
  'KIMI_MODEL_ADAPTIVE_THINKING',
  'KIMI_MODEL_MAX_COMPLETION_TOKENS',
  'KIMI_MODEL_TEMPERATURE',
  'KIMI_MODEL_TOP_P',
  'KIMI_MODEL_THINKING_KEEP',
] as const;

function directApiModelName(model: string): string {
  const normalized = model.trim();
  if (!normalized) {
    throw new Error('Kimi API-key fallback requires a model name');
  }
  return normalized.startsWith('kimi-code/')
    ? normalized.slice('kimi-code/'.length)
    : normalized;
}

/**
 * Build the process-only credentials supported by current Kimi Code. The key
 * stays in the child environment; neither providers.json nor Kimi config.toml
 * is rewritten.
 */
export function buildKimiApiKeyRuntimeEnv(
  key: string,
  model: string,
): Record<string, string> {
  if (!key.trim()) {
    throw new Error('Kimi API-key fallback requires a non-empty key');
  }
  return {
    KIMI_MODEL_API_KEY: key,
    KIMI_MODEL_NAME: directApiModelName(model),
  };
}
