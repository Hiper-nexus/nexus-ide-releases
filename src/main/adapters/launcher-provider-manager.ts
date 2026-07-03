/**
 * Provider routing manager — a TypeScript port of the account/provider core of
 * the user's ~/ai-launcher dispatcher (Bash, v1.11.0). It reproduces, as data,
 * the launcher's canonical provider table and its Anthropic-compatible env
 * routing so a single Claude-compatible CLI can be pointed at GLM/Z.ai,
 * Sakana Fugu, DeepSeek, OpenRouter or a local endpoint by swapping
 * ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN (never API_KEY for third parties),
 * exactly as `provider_setup_env` does in the launcher.
 *
 * Source of truth: ~/ai-launcher `ai` — PROVIDER_URLS / PROVIDER_MODELS /
 * PROVIDER_EXTRA_ENV (lines ~87-125) and the env-setup case (~213-240).
 * Behavior ported, not reinvented. Secrets stay in the OS keychain
 * (secrets-store); this module only computes env from a supplied token.
 */

export interface UpstreamProvider {
  id: string;
  label: string;
  /** Anthropic-compatible base URL; '' means the native Anthropic endpoint. */
  baseUrl: string;
  /** Default model hint (may be empty — CLI decides). */
  defaultModel: string;
  /** Extra env pairs the launcher exports for this provider. */
  extraEnv: Record<string, string>;
  /** Whether this upstream needs a user-supplied token. */
  requiresToken: boolean;
  /** local endpoints (ollama/lmstudio/litellm) need no auth token. */
  local: boolean;
}

// Ported verbatim from the launcher's declare -A PROVIDER_* maps.
const GLM_EXTRA: Record<string, string> = {
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  API_TIMEOUT_MS: '600000',
  CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1000000',
  ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-4.5-air',
  ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-4.6',
  ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-4.6',
};

const THIRD_PARTY_EXTRA: Record<string, string> = {
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  API_TIMEOUT_MS: '600000',
};

export const UPSTREAM_PROVIDERS: Record<string, UpstreamProvider> = {
  anthropic: {
    id: 'anthropic',
    label: 'Anthropic (nativo)',
    baseUrl: '',
    defaultModel: '',
    extraEnv: {},
    requiresToken: false,
    local: false,
  },
  glm: {
    id: 'glm',
    label: 'GLM / Z.ai',
    baseUrl: 'https://api.z.ai/api/anthropic',
    defaultModel: '',
    extraEnv: GLM_EXTRA,
    requiresToken: true,
    local: false,
  },
  sakana: {
    id: 'sakana',
    label: 'Sakana Fugu',
    baseUrl: 'https://api.sakana.ai/v1',
    defaultModel: 'fugu',
    extraEnv: {},
    requiresToken: true,
    local: false,
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api',
    defaultModel: 'anthropic/claude-sonnet-4',
    extraEnv: {},
    requiresToken: true,
    local: false,
  },
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/anthropic',
    defaultModel: 'deepseek-chat',
    extraEnv: THIRD_PARTY_EXTRA,
    requiresToken: true,
    local: false,
  },
  ollama: {
    id: 'ollama',
    label: 'Ollama (local)',
    baseUrl: 'http://localhost:11434',
    defaultModel: 'qwen2.5-coder:32b',
    extraEnv: THIRD_PARTY_EXTRA,
    requiresToken: false,
    local: true,
  },
  lmstudio: {
    id: 'lmstudio',
    label: 'LM Studio (local)',
    baseUrl: 'http://localhost:1234',
    defaultModel: 'loaded-model',
    extraEnv: THIRD_PARTY_EXTRA,
    requiresToken: false,
    local: true,
  },
  litellm: {
    id: 'litellm',
    label: 'LiteLLM (local)',
    baseUrl: 'http://localhost:4000',
    defaultModel: 'gpt-4o',
    extraEnv: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
    requiresToken: false,
    local: true,
  },
};

export function listUpstreamProviders(): UpstreamProvider[] {
  return Object.values(UPSTREAM_PROVIDERS);
}

export function getUpstreamProvider(id: string): UpstreamProvider | null {
  return UPSTREAM_PROVIDERS[id] ?? null;
}

/**
 * Build the env a Claude-compatible CLI needs to talk to `providerId`,
 * mirroring the launcher's `provider_setup_env`:
 *  - native anthropic → no routing env (uses the CLI's own auth);
 *  - third party → ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN (NOT API_KEY),
 *    plus the provider's extra env; OpenRouter also gets OPENROUTER_API_KEY.
 * The caller supplies the token (from the keychain); a missing required token
 * yields an empty env so the spawn falls back to native auth rather than
 * routing to an unauthenticated endpoint.
 */
export function buildProviderRoutingEnv(
  providerId: string,
  token: string | null,
): Record<string, string> {
  const provider = getUpstreamProvider(providerId);
  if (!provider || provider.id === 'anthropic') return {};
  if (provider.requiresToken && !token) return {};

  const env: Record<string, string> = {
    ANTHROPIC_BASE_URL: provider.baseUrl,
  };
  const authToken = token ?? '';
  if (!provider.local || authToken) {
    env.ANTHROPIC_AUTH_TOKEN = authToken;
  }
  if (provider.id === 'openrouter' && authToken) {
    env.OPENROUTER_API_KEY = authToken;
  }
  for (const [key, value] of Object.entries(provider.extraEnv)) {
    env[key] = value;
  }
  return env;
}
