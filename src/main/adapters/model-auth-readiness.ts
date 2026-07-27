/**
 * Models served by OpenCode itself that are explicitly known to work without
 * a provider credential.
 *
 * This is intentionally an exact, release-pinned allowlist. Do not infer
 * credentialless access from the `opencode/` namespace or a `-free` suffix:
 * either shortcut could silently authorize a future paid/external route.
 * Verified against OpenCode 1.18.0's first-party catalog on 2026-07-25.
 */
export const CREDENTIALLESS_OPENCODE_MODEL_IDS = Object.freeze([
  "opencode/big-pickle",
  "opencode/deepseek-v4-flash-free",
  "opencode/laguna-s-2.1-free",
  "opencode/ling-3.0-flash-free",
  "opencode/mimo-v2.5-free",
  "opencode/nemotron-3-ultra-free",
  "opencode/north-mini-code-free",
] as const);

const credentiallessOpenCodeModels = new Set<string>(
  CREDENTIALLESS_OPENCODE_MODEL_IDS,
);

/**
 * OMP provider/auth aliases verified against the release-pinned OMP 17.0.4
 * broker/catalog. This table is intentionally closed: a new provider prefix
 * is not authentication evidence until a Nexus release reviews its broker
 * identity and (when applicable) the exact launcher env variable it accepts.
 */
export const OMP_MODEL_AUTH_ROUTES_17_0_4 = Object.freeze({
  anthropic: Object.freeze({
    brokerProviderIds: Object.freeze(["anthropic"]),
    launcherProviderId: "anthropic",
    envNames: Object.freeze(["ANTHROPIC_API_KEY"]),
  }),
  openai: Object.freeze({
    brokerProviderIds: Object.freeze([]),
    launcherProviderId: "openai",
    envNames: Object.freeze(["OPENAI_API_KEY"]),
  }),
  "openai-codex": Object.freeze({
    brokerProviderIds: Object.freeze([
      "openai-codex",
      "openai-codex-device",
    ]),
    launcherProviderId: null,
    envNames: Object.freeze([]),
  }),
  zai: Object.freeze({
    brokerProviderIds: Object.freeze(["zai"]),
    launcherProviderId: "glm",
    envNames: Object.freeze(["ZAI_API_KEY"]),
  }),
  "zhipu-coding-plan": Object.freeze({
    brokerProviderIds: Object.freeze(["zhipu-coding-plan"]),
    launcherProviderId: "zhipu-coding-plan",
    envNames: Object.freeze(["ZHIPU_API_KEY"]),
  }),
  xai: Object.freeze({
    // OMP 17.0.4 exposes OAuth as the distinct `xai-oauth` selector. A
    // credential stored there must never authorize the API-key `xai` route.
    brokerProviderIds: Object.freeze([]),
    launcherProviderId: "xai",
    envNames: Object.freeze(["XAI_API_KEY"]),
  }),
  "xai-oauth": Object.freeze({
    brokerProviderIds: Object.freeze(["xai-oauth"]),
    launcherProviderId: null,
    envNames: Object.freeze([]),
  }),
  deepseek: Object.freeze({
    brokerProviderIds: Object.freeze(["deepseek"]),
    launcherProviderId: "deepseek",
    envNames: Object.freeze(["DEEPSEEK_API_KEY"]),
  }),
  "kimi-code": Object.freeze({
    brokerProviderIds: Object.freeze(["kimi-code"]),
    launcherProviderId: null,
    envNames: Object.freeze([]),
  }),
  moonshot: Object.freeze({
    brokerProviderIds: Object.freeze(["moonshot"]),
    launcherProviderId: "moonshot",
    envNames: Object.freeze(["MOONSHOT_API_KEY"]),
  }),
  openrouter: Object.freeze({
    brokerProviderIds: Object.freeze(["openrouter"]),
    launcherProviderId: "openrouter",
    envNames: Object.freeze(["OPENROUTER_API_KEY"]),
  }),
  google: Object.freeze({
    brokerProviderIds: Object.freeze([]),
    launcherProviderId: "gemini",
    envNames: Object.freeze(["GEMINI_API_KEY"]),
  }),
  "google-gemini-cli": Object.freeze({
    brokerProviderIds: Object.freeze(["google-gemini-cli"]),
    launcherProviderId: null,
    envNames: Object.freeze([]),
  }),
  "google-antigravity": Object.freeze({
    brokerProviderIds: Object.freeze(["google-antigravity"]),
    launcherProviderId: null,
    envNames: Object.freeze([]),
  }),
  "qwen-portal": Object.freeze({
    brokerProviderIds: Object.freeze(["qwen-portal"]),
    launcherProviderId: "qwen-portal",
    envNames: Object.freeze(["QWEN_PORTAL_API_KEY"]),
  }),
  "alibaba-coding-plan": Object.freeze({
    brokerProviderIds: Object.freeze(["alibaba-coding-plan"]),
    launcherProviderId: "alibaba-coding-plan",
    envNames: Object.freeze(["ALIBABA_CODING_PLAN_API_KEY"]),
  }),
  minimax: Object.freeze({
    brokerProviderIds: Object.freeze([]),
    launcherProviderId: "minimax",
    envNames: Object.freeze(["MINIMAX_API_KEY"]),
  }),
  "minimax-code": Object.freeze({
    brokerProviderIds: Object.freeze(["minimax-code"]),
    launcherProviderId: "minimax-code",
    envNames: Object.freeze(["MINIMAX_CODE_API_KEY"]),
  }),
  "minimax-code-cn": Object.freeze({
    brokerProviderIds: Object.freeze(["minimax-code-cn"]),
    launcherProviderId: "minimax-code-cn",
    envNames: Object.freeze(["MINIMAX_CODE_CN_API_KEY"]),
  }),
  cerebras: Object.freeze({
    brokerProviderIds: Object.freeze(["cerebras"]),
    launcherProviderId: "cerebras",
    envNames: Object.freeze(["CEREBRAS_API_KEY"]),
  }),
  groq: Object.freeze({
    brokerProviderIds: Object.freeze([]),
    launcherProviderId: "groq",
    envNames: Object.freeze(["GROQ_API_KEY"]),
  }),
  mistral: Object.freeze({
    brokerProviderIds: Object.freeze([]),
    launcherProviderId: "mistral",
    envNames: Object.freeze(["MISTRAL_API_KEY"]),
  }),
  ollama: Object.freeze({
    brokerProviderIds: Object.freeze([]),
    launcherProviderId: null,
    envNames: Object.freeze([]),
    credentialless: true,
  }),
  "lm-studio": Object.freeze({
    brokerProviderIds: Object.freeze([]),
    launcherProviderId: null,
    envNames: Object.freeze([]),
    credentialless: true,
  }),
  "llama.cpp": Object.freeze({
    brokerProviderIds: Object.freeze([]),
    launcherProviderId: null,
    envNames: Object.freeze([]),
    credentialless: true,
  }),
  vllm: Object.freeze({
    brokerProviderIds: Object.freeze([]),
    launcherProviderId: null,
    envNames: Object.freeze([]),
    credentialless: true,
  }),
} as const);

export type OmpModelAuthProvider =
  keyof typeof OMP_MODEL_AUTH_ROUTES_17_0_4;

export interface OmpModelAuthRoute {
  readonly modelProvider: OmpModelAuthProvider;
  readonly brokerProviderIds: readonly string[];
  readonly launcherProviderId: string | null;
  readonly envNames: readonly string[];
  readonly credentialless: boolean;
}

export function ompModelProviderFromRef(
  model: string | null | undefined,
): string | null {
  if (typeof model !== "string") return null;
  const trimmed = model.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) return null;
  // A second slash belongs to the model id and is valid (OpenRouter routes).
  return trimmed.slice(0, slash);
}

export function ompModelAuthRoute(
  model: string | null | undefined,
): OmpModelAuthRoute | null {
  const provider = ompModelProviderFromRef(model);
  if (
    !provider ||
    !Object.prototype.hasOwnProperty.call(
      OMP_MODEL_AUTH_ROUTES_17_0_4,
      provider,
    )
  ) {
    return null;
  }
  const route =
    OMP_MODEL_AUTH_ROUTES_17_0_4[
      provider as OmpModelAuthProvider
    ];
  return Object.freeze({
    modelProvider: provider as OmpModelAuthProvider,
    brokerProviderIds: route.brokerProviderIds,
    launcherProviderId: route.launcherProviderId,
    envNames: route.envNames,
    credentialless:
      "credentialless" in route && route.credentialless === true,
  });
}

export function isCredentiallessOpenCodeModel(
  adapterId: string,
  model: string | null | undefined,
): boolean {
  if (adapterId !== "opencode" || typeof model !== "string") return false;
  return credentiallessOpenCodeModels.has(model.trim());
}

/**
 * Model-aware replacement for the old global `authStrategy !== login-needed`
 * check. Authenticated providers keep their normal catalog. An unauthenticated
 * OpenCode route is ready only for one exact first-party free model.
 */
export function isProviderAuthReadyForModel(
  provider: {
    readonly adapterId: string;
    readonly authStrategy: string;
    readonly authReadyModels?: readonly string[];
  },
  model: string | null | undefined,
): boolean {
  if (
    provider.adapterId === "omp" ||
    provider.adapterId === "omp-rpc"
  ) {
    if (typeof model !== "string" || !ompModelAuthRoute(model)) return false;
    // OMP auth is provider/model scoped. Never expand one broker credential
    // into permission for the whole catalog.
    return (
      Array.isArray(provider.authReadyModels) &&
      provider.authReadyModels.includes(model.trim())
    );
  }
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
  if (
    provider.adapterId === "omp" ||
    provider.adapterId === "omp-rpc"
  ) {
    if (!Array.isArray(provider.authReadyModels)) {
      return Object.freeze([]);
    }
    const ready = new Set(provider.authReadyModels);
    return Object.freeze(
      models.filter(
        (model) => ompModelAuthRoute(model) !== null && ready.has(model),
      ),
    );
  }
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
