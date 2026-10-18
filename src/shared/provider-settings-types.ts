import { z } from 'zod';
import { cliPtyAdapterSchema, type ModelInfoMap } from './adapter-types';

/**
 * Per-provider (CLI/API adapter) user configuration and secrets surface for
 * the settings hub. Config (enable/disable, binary path, default model, extra
 * args) is non-secret and lives in ~/.nexus/providers.json. API keys are
 * secret and live ONLY in the OS keychain via Electron safeStorage — never in
 * versioned JSON, never on any IPC snapshot (the UI sees masked state only).
 */

export const providerConfigPatchSchema = z.object({
  adapterId: z.string().min(1).max(64),
  enabled: z.boolean().optional(),
  binPath: z.string().max(4096).optional(),
  defaultModel: z.string().max(128).optional(),
  extraArgs: z.array(z.string().max(512)).max(64).optional(),
  /** Upstream routing (ai-launcher port): anthropic|glm|sakana|… */
  upstream: z.string().max(32).optional(),
  /**
   * F-1565: base URL explícita do provider (hoje só o Qwen usa: o endpoint
   * OpenAI-compatible que a chave configurada deve falar — ex.: a URL
   * exclusiva do Alibaba Token Plan). '' limpa. https sem credencial.
   */
  baseUrl: z.string().max(512).optional(),
  /** Permission mode key ('' = CLI default; 'yolo'|'bypass'|'auto'|'plan'…). */
  permissionMode: z.string().max(32).optional(),
  /** Reasoning effort level ('' = CLI default). */
  effort: z.string().max(32).optional(),
  verbose: z.boolean().optional(),
});
export type ProviderConfigPatch = z.infer<typeof providerConfigPatchSchema>;

export interface ProviderConfig {
  adapterId: string;
  enabled: boolean;
  binPath: string;
  defaultModel: string;
  extraArgs: string[];
  /** Which upstream this Claude-compatible CLI routes to (default anthropic). */
  upstream: string;
  /**
   * F-1565: base URL explícita do provider ('' = automática). Hoje só o Qwen
   * consome: com chave configurada, o pane injeta a chave contra ESTA URL
   * (a do Token Plan para chaves sk-sp-…, salvo escolha do operador).
   */
  baseUrl: string;
  /** Auto-operation flags (bypass/yolo/auto/plan), reasoning effort, verbose. */
  permissionMode: string;
  effort: string;
  verbose: boolean;
}

export interface UpstreamOption {
  id: string;
  label: string;
  requiresToken: boolean;
}

/**
 * F-724: escolha de provedor de um adapter com mais de uma origem (hoje só o
 * DeepSeek: API direta ou Alibaba Token Plan). Persistida como `upstream`.
 */
export interface ProviderChoiceInfo {
  /** Opção ativa (um dos `options[].id`). */
  value: string;
  options: Array<{ id: string; label: string; hint?: string }>;
  /** Vaga de chave que o provedor escolhido usa — o valor nunca sai do Main. */
  key: {
    /** Vaga do cofre que o bloco de chave grava/testa (`deepseek` ou `qwen`). */
    adapterId: string;
    label: string;
    envVar: string | null;
    hasKey: boolean;
    keyMasked: string | null;
    hint?: string;
  };
}

/** Secret-free runtime view of a provider for the settings UI. */
export interface ProviderSettingsInfo {
  adapterId: string;
  label: string;
  icon: string;
  kind: 'cli-pty' | 'api-provider';
  enabled: boolean;
  installed: boolean;
  /** True quando há receita de instalação 1-clique para esta plataforma. */
  canAutoInstall: boolean;
  /** Comando de instalação sugerido ou declarado pelo adapter. */
  installCommand?: string;
  binPath: string;
  detectedBin: string;
  /** Duplicate versions and the selected version, without filesystem paths. */
  cliInstallationWarning?: string;
  /** F-992: versão quebrada conhecida ou anterior ao modelo padrão; não bloqueia. */
  cliCompatibilityWarning?: string;
  /** F-1395: última atualização automática desta CLI (antes→depois ou falha). */
  cliAutoUpdate?: CliAutoUpdateOutcome;
  defaultModel: string;
  models: string[];
  /**
   * F-990: ids do adapter/catálogo que a listagem da CLI não traz — não são
   * oferecidos nem roteados. Ausente = nenhum.
   */
  unverifiedModels?: string[];
  /** F-990: de onde veio `models` (listagem viva, última boa, cache, bundled). */
  modelListSource?: 'live' | 'last-good' | 'cache' | 'bundled';
  /**
   * Exact model ids whose provider-specific auth is ready in this snapshot.
   */
  authReadyModels?: string[];
  /** Latest credential-bound API probe; native subscription health is independent. */
  credentialReadiness?: 'present' | 'invalid-credential' | 'unknown' | 'no-credential';
  modelInfo?: ModelInfoMap;
  extraArgs: string[];
  /** Env var the key is injected as (e.g. ANTHROPIC_API_KEY). */
  keyEnvVar: string | null;
  /** Whether a key is stored in the keychain (value never leaves main). */
  hasKey: boolean;
  /** Masked preview like "sk-…4a2f", or null when unset. */
  keyMasked: string | null;
  authMethod: string;
  /** Observed login proof for display; unknown never means confirmed logout. */
  authState?: AuthState;
  loginHint?: string;
  /**
   * Comando que autentica esta CLI num terminal ("codex login", "qwen"…).
   * Ausente = não há fluxo de terminal; o caminho é a key. Ver cli-login.ts.
   */
  loginCommand?: string;
  /** True when safeStorage encryption is available on this machine. */
  secureStorageAvailable: boolean;
  /**
   * How this CLI will authenticate at spawn (subscription-first directive):
   * subscription = signed-in OAuth/plan session; api-key = keychain fallback;
   * login-needed = neither present, the CLI will prompt.
   */
  authStrategy:
    | 'credentialless'
    | 'subscription'
    | 'api-key'
    | 'login-needed';
  /** Active upstream routing (ai-launcher port). */
  upstream: string;
  /** F-1565: base URL explícita salva (Qwen; '' = automática). */
  baseUrl?: string;
  /** Whether this adapter is Claude-compatible and can be routed. */
  routable: boolean;
  /** Available upstreams to route to. */
  upstreams: UpstreamOption[];
  /** F-724: provedor escolhido (substitui o seletor genérico de upstream). */
  providerChoice?: ProviderChoiceInfo;
  /**
   * F-724: ids que o provedor escolhido serve com outro modelo (ex.: no
   * Token Plan o `deepseek-flash` sobe como `deepseek-v4-pro`). A rota usa o
   * modelo servido; ausente = nenhum id trocado.
   */
  modelAliases?: Record<string, string>;
  /** Current auto-operation settings + what this CLI supports. */
  permissionMode: string;
  permissionModes: string[];
  effort: string;
  efforts: string[];
  verbose: boolean;
  supportsVerbose: boolean;
  /** User-added custom models (removable in the UI). `models` already merges them. */
  customModels: string[];
  /** True when the active key comes from the plaintext launcher providers.conf
   * fallback (L4) — NOT from the encrypted vault. The UI should warn the user
   * that this key is stored in cleartext on disk. */
  plaintextKeyFallback?: boolean;
}

export const setKeySchema = z.object({
  adapterId: cliPtyAdapterSchema.shape.id,
  /** Empty string clears the stored key. */
  key: z.string().max(4096),
});
export type SetKeyRequest = z.infer<typeof setKeySchema>;

export interface TestConnectionResult {
  ok: boolean;
  detail: string;
}

export const addModelSchema = z.object({
  adapterId: z.string().min(1).max(64),
  model: z.string().min(1).max(128),
});
export type AddModelRequest = z.infer<typeof addModelSchema>;

/** Estado de login local de uma CLI (sonda sem navegador). */
export type AuthState = 'ok' | 'missing' | 'unknown';

export interface AdapterAuthStatus {
  adapterId: string;
  state: AuthState;
  detail: string;
  /**
   * Opaque, provider-scoped fingerprint of the CLI session currently on disk.
   * Equality is the only supported operation. It contains no token or raw
   * provider subject and lets login UIs detect account A -> B even when the
   * provider (for example Kimi/OpenCode) exposes no email claim.
   */
  sessionFingerprint?: string;
  /** Ephemeral credential revision; equality only, never display, log or persist. */
  sessionRevision?: string;
}

export const PROVIDER_CHANNELS = {
  list: 'provider:list',
  setConfig: 'provider:setConfig',
  setKey: 'provider:setKey',
  testKey: 'provider:testKey',
  addModel: 'provider:addModel',
  removeModel: 'provider:removeModel',
  changed: 'provider:changed',
  authStatus: 'provider:authStatus',
  installCli: 'provider:installCli',
  autoCliUpdates: 'provider:autoCliUpdates',
  vaultState: 'provider:vaultState',
  exportSecrets: 'provider:exportSecrets',
  importSecrets: 'provider:importSecrets',
} as const;

/** F-1395: resultado de uma atualização automática, sem caminhos. */
export interface CliAutoUpdateOutcome {
  at: number;
  /** F-1397: `up-to-date` = a checagem barata (npm view / brew outdated) não achou versão nova. */
  status: 'updated' | 'unchanged' | 'up-to-date' | 'failed';
  fromVersion?: string;
  toVersion?: string;
  /** Motivo curto da falha: install-failed, timeout, version-unreadable… */
  reason?: string;
}

export interface CliAutoUpdateStatus {
  enabled: boolean;
  deferredUntil: number | null;
  lastCheckedAt: number | null;
  error?: string;
}

export const exportSecretsSchema = z.object({
  passphrase: z.string().min(8).max(256),
});

export type ExportSecretsRequest = z.infer<typeof exportSecretsSchema>;

export const importSecretsSchema = z.object({
  bundle: z.string().min(2).max(2_000_000),
  passphrase: z.string().min(8).max(256),
});

export type ImportSecretsRequest = z.infer<typeof importSecretsSchema>;
