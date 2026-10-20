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
 * Behavior ported, not reinvented. Preferred secret store is the OS keychain
 * (secrets-store). As a runtime fallback we also read the launcher's
 * `providers.conf` (same file `ai glm` uses) so a key already configured in
 * the launcher works in Nexus without re-pasting.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ALIBABA_TOKEN_PLAN_ANTHROPIC_BASE_URL,
  DEEPSEEK_TOKEN_PLAN_FLASH_MODEL,
  DEEPSEEK_TOKEN_PLAN_MODEL,
  DEEPSEEK_TOKEN_PLAN_PROVIDER,
} from './deepseek-provider';

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
  /**
   * Rota que só existe para um adapter (F-724: o DeepSeek pelo Token Plan).
   * Fica fora do seletor genérico de roteamento e da conta de upstream.
   */
  scopedTo?: string;
}

// Ported verbatim from the launcher's declare -A PROVIDER_* maps.
// GLM Coding Plan mapping from Z.AI's latest-model guide (2026-08-14):
// https://docs.z.ai/devpack/latest-model — sonnet/opus use the 1M route.
// O launcher (GLM_MODEL/GLM_FLASH_MODEL) pina o slot haiku no Flash desde que
// o glm-5.3-flash virou o modelo barato do provider — o 4.7 saiu de linha.
const GLM_MODEL = 'glm-5.3[1m]';
const GLM_FLASH_MODEL = 'glm-5.3-flash[1m]';
const GLM_EXTRA: Record<string, string> = {
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  API_TIMEOUT_MS: '600000',
  CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1000000',
  ANTHROPIC_DEFAULT_HAIKU_MODEL: GLM_FLASH_MODEL,
  ANTHROPIC_DEFAULT_SONNET_MODEL: GLM_MODEL,
  ANTHROPIC_DEFAULT_OPUS_MODEL: GLM_MODEL,
};

/**
 * `glm_flash_setup_env` do launcher: provider_setup_env('glm') + TODOS os
 * slots de modelo no Flash (haiku/sonnet/opus/ANTHROPIC_MODEL). É uma rota
 * upstream própria, não só um --model: quem roteia qualquer CLI claude-family
 * via glm-flash recebe a sessão inteira no Flash.
 */
const GLM_FLASH_EXTRA: Record<string, string> = {
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  API_TIMEOUT_MS: '600000',
  CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1000000',
  ANTHROPIC_MODEL: GLM_FLASH_MODEL,
  ANTHROPIC_DEFAULT_HAIKU_MODEL: GLM_FLASH_MODEL,
  ANTHROPIC_DEFAULT_SONNET_MODEL: GLM_FLASH_MODEL,
  ANTHROPIC_DEFAULT_OPUS_MODEL: GLM_FLASH_MODEL,
};

// Id da API Anthropic compatível da MiniMax (platform.minimax.io, conferido em
// 19/10/2026). O `mcode` (0.6.12) só lista o Preview do Flash: esse id não vai
// no argv dele. Sem o sufixo `[1m]`, o Claude Code 2.1.303 mede a janela em
// 200000 mesmo com CLAUDE_CODE_AUTO_COMPACT_WINDOW=1000000. A doc diz que o
// modelo sempre pensa e recusa thinking.type=disabled (400); este env não
// define chave de thinking.
const MINIMAX_MODEL = 'MiniMax-M3.1-Flash';

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
  // Mesma credencial e base URL do glm — `ai glm-flash`/`gf` no launcher.
  'glm-flash': {
    id: 'glm-flash',
    label: 'GLM Flash / Z.ai',
    baseUrl: 'https://api.z.ai/api/anthropic',
    defaultModel: GLM_FLASH_MODEL,
    extraEnv: GLM_FLASH_EXTRA,
    requiresToken: true,
    local: false,
  },
  mimo: {
    id: 'mimo',
    label: 'MIMO / Xiaomi',
    baseUrl: 'https://api.xiaomimimo.com/anthropic',
    defaultModel: 'mimo-v2.6-pro',
    extraEnv: {
      ...THIRD_PARTY_EXTRA,
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'mimo-v2.6-pro',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'mimo-v2.6-pro',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'mimo-v2.6-flash',
    },
    requiresToken: true,
    local: false,
  },
  // Token Plan da MiniMax no Claude Code — valores da doc oficial
  // (platform.minimax.io/docs/token-plan/claude-code, conferida em 2026-09-27).
  // O domínio antigo api.minimax.chat e o modelo minimax-m1 saíram de linha.
  // A CLI própria da MiniMax é outro adapter: `minimax-code` (`mcode`).
  minimax: {
    id: 'minimax',
    label: 'MiniMax',
    baseUrl: 'https://api.minimax.io/anthropic',
    defaultModel: MINIMAX_MODEL,
    extraEnv: {
      ...THIRD_PARTY_EXTRA,
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1000000',
      ANTHROPIC_MODEL: MINIMAX_MODEL,
      ANTHROPIC_DEFAULT_SONNET_MODEL: MINIMAX_MODEL,
      ANTHROPIC_DEFAULT_OPUS_MODEL: MINIMAX_MODEL,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: MINIMAX_MODEL,
    },
    requiresToken: true,
    local: false,
  },
  qwen: {
    id: 'qwen',
    label: 'Qwen / Alibaba',
    baseUrl: 'https://dashscope.aliyuncs.com/api/anthropic',
    defaultModel: 'qwen3-coder',
    extraEnv: THIRD_PARTY_EXTRA,
    requiresToken: true,
    local: false,
  },
  moonshot: {
    id: 'moonshot',
    label: 'Kimi / Moonshot',
    baseUrl: 'https://api.moonshot.ai/anthropic',
    defaultModel: 'kimi-k2',
    extraEnv: THIRD_PARTY_EXTRA,
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
    // IDs da API /models do DeepSeek, 01/10/2026 (v4-pro default, flash barato).
    defaultModel: 'deepseek-v4-pro',
    extraEnv: {
      ...THIRD_PARTY_EXTRA,
      CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT: '1',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-flash',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-v4-pro',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'deepseek-v4-pro',
    },
    requiresToken: true,
    local: false,
  },
  // F-724: o mesmo DeepSeek pelo Alibaba Model Studio Token Plan (endpoint
  // Anthropic-compatible do plano). Só o adapter `deepseek` escolhe esta rota
  // e a chave é a do Token Plan (a do Qwen Code), nunca a da DeepSeek. O
  // plano serve o v4-pro e, desde 20/10/2026, o v4.1-flash-1017: o slot barato
  // (haiku) fica no flash e sonnet/opus no v4-pro, como na API direta.
  [DEEPSEEK_TOKEN_PLAN_PROVIDER]: {
    id: DEEPSEEK_TOKEN_PLAN_PROVIDER,
    label: 'DeepSeek via Alibaba Token Plan',
    baseUrl: ALIBABA_TOKEN_PLAN_ANTHROPIC_BASE_URL,
    defaultModel: DEEPSEEK_TOKEN_PLAN_MODEL,
    extraEnv: {
      ...THIRD_PARTY_EXTRA,
      CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT: '1',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: DEEPSEEK_TOKEN_PLAN_FLASH_MODEL,
      ANTHROPIC_DEFAULT_SONNET_MODEL: DEEPSEEK_TOKEN_PLAN_MODEL,
      ANTHROPIC_DEFAULT_OPUS_MODEL: DEEPSEEK_TOKEN_PLAN_MODEL,
    },
    requiresToken: true,
    local: false,
    scopedTo: 'deepseek',
  },
  // F-1338: SEMPRE sem ENABLE_TOOL_SEARCH. Medido no Claude Code 2.1.296:
  // `true` adia todo MCP atrás do ToolSearch, mas o host terceiro não
  // negocia o beta de tool-search — as ferramentas somem do request e o
  // modelo nunca as alcança. O padrão (ausente) já entrega o MCP inline.
  'muse-claude': {
    id: 'muse-claude',
    label: 'Muse Spark (via Claude)',
    baseUrl: 'https://api.meta.ai',
    defaultModel: 'muse-spark-1.3',
    extraEnv: {
      ...THIRD_PARTY_EXTRA,
      ANTHROPIC_MODEL: 'muse-spark-1.3',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'muse-spark-1.3',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'muse-spark-1.3',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'muse-spark-1.3',
      CLAUDE_CODE_SUBAGENT_MODEL: 'muse-spark-1.3',
    },
    requiresToken: true,
    local: false,
  },
  longcat: {
    id: 'longcat',
    label: 'LongCat (Meituan)',
    baseUrl: 'https://api.longcat.chat/anthropic',
    defaultModel: 'LongCat-2.0',
    extraEnv: {
      ...THIRD_PARTY_EXTRA,
      // Official Claude Code mapping (longcat.chat/platform/docs/ClaudeCode.html)
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'LongCat-2.0',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'LongCat-2.0',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'LongCat-2.0',
    },
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

/** Upstreams do seletor genérico de roteamento (sem as rotas de um adapter só). */
export function listUpstreamProviders(): UpstreamProvider[] {
  return Object.values(UPSTREAM_PROVIDERS).filter((p) => !p.scopedTo);
}

/**
 * Pode `adapterId` rotear para `upstreamId`? Rota com dono só serve ao dono;
 * id desconhecido segue o comportamento histórico (o spawn não monta env).
 */
export function upstreamAllowedForAdapter(
  adapterId: string,
  upstreamId: string,
): boolean {
  const scopedTo = UPSTREAM_PROVIDERS[upstreamId]?.scopedTo;
  return !scopedTo || scopedTo === adapterId;
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

// ---------------------------------------------------------------------------
// Launcher providers.conf — same store `ai glm` / `provider_load_key` uses.
// Path: ~/.local/share/ai-launcher/providers.conf  (lines `provider=key`)
// ---------------------------------------------------------------------------

/** Default path of the ai-launcher credential file (mode 600). */
export function defaultLauncherProvidersFile(): string {
  return path.join(os.homedir(), '.local', 'share', 'ai-launcher', 'providers.conf');
}

const PROVIDER_NAME_RE = /^[a-z0-9_-]+$/;

/** Aliases the launcher accepts for the same credential slot. */
const LAUNCHER_KEY_ALIASES: Record<string, string[]> = {
  glm: ['glm', 'zai', 'z.ai'],
  // `ai gf` não tem slot próprio no providers.conf — lê a chave `glm`.
  'glm-flash': ['glm-flash', 'glm', 'zai', 'z.ai'],
  sakana: ['sakana', 'fugu'],
  // F-238: a chave do Token Plan/Bailian também pode estar gravada como
  // `dashscope=` no providers.conf legado.
  qwen: ['qwen', 'dashscope', 'bailian'],
};

let launcherKeyCache: {
  file: string;
  mtimeMs: number;
  map: Map<string, string>;
} | null = null;

/** Test hook: force a providers.conf path (or null to restore default). */
let launcherProvidersFileOverride: string | null = null;

export function setLauncherProvidersFileForTests(file: string | null): void {
  launcherProvidersFileOverride = file;
  launcherKeyCache = null;
}

function parseProvidersConf(raw: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const name = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1);
    if (!PROVIDER_NAME_RE.test(name) || !value) continue;
    map.set(name, value);
  }
  return map;
}

function readLauncherProvidersMap(file: string): Map<string, string> {
  try {
    const stat = fs.statSync(file);
    if (
      launcherKeyCache &&
      launcherKeyCache.file === file &&
      launcherKeyCache.mtimeMs === stat.mtimeMs
    ) {
      return launcherKeyCache.map;
    }
    const map = parseProvidersConf(fs.readFileSync(file, 'utf8'));
    launcherKeyCache = { file, mtimeMs: stat.mtimeMs, map };
    return map;
  } catch {
    launcherKeyCache = null;
    return new Map();
  }
}

/**
 * Read a provider token the same way the launcher's `provider_load_key` does.
 * Returns null when missing/invalid. Never logs the value.
 */
export function loadLauncherProviderKey(
  providerId: string,
  file = launcherProvidersFileOverride ?? defaultLauncherProvidersFile(),
): string | null {
  if (!providerId || !PROVIDER_NAME_RE.test(providerId)) return null;
  const map = readLauncherProvidersMap(file);
  const candidates = LAUNCHER_KEY_ALIASES[providerId] ?? [providerId];
  for (const name of candidates) {
    const value = map.get(name);
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

/**
 * Endpoint que o launcher associa ao slot (`deepseek-base-url=…`): quando
 * existe, a chave do mesmo slot é credencial DESSE host, não do provider
 * nativo. F-724: o `deepseek=` do launcher do operador guarda a chave do
 * Token Plan com `deepseek-base-url` na Alibaba — enviá-la para
 * api.deepseek.com vazava a chave e dava 401. Só leitura; nunca loga.
 */
export function loadLauncherProviderBaseUrl(
  providerId: string,
  file = launcherProvidersFileOverride ?? defaultLauncherProvidersFile(),
): string | null {
  if (!providerId || !PROVIDER_NAME_RE.test(providerId)) return null;
  const value = readLauncherProvidersMap(file).get(`${providerId}-base-url`);
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : null;
}
