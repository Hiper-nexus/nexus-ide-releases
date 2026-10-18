import type { GovernedCliProfileOptions } from './governed-cli-profile';
import type { CodexNativeAuthority } from '../pty/codex-native-authority';
import type { McpHubSpawnServer } from '../mcp-hub/mcp-hub-spawn';

export interface CliMcpSessionOptions extends GovernedCliProfileOptions {
  /** Exact Main-selected scheduling keys; never the complete provider env. */
  heavyCommandEnv?: Readonly<Record<string, string>>;
  home?: string;
  providerHome?: string;
  artifactRoot?: string;
  /** Main-owned durable storage and checkout identity for provider conversations. */
  userDataPath?: string;
  checkoutId?: string;
  /**
   * Servidores declarados pelo operador no hub do workspace
   * (`.nexus/mcp-hub.json`), já saneados. Materializados no config por sessão
   * junto do `nexus` — o isolamento do perfil ambiente continua intacto.
   */
  hubServers?: readonly McpHubSpawnServer[];
  /** Trusted main-owned working directory (used to suppress project add-ons). */
  cwd?: string;
  /** Trusted checkout root bounding project discovery suppression. */
  workspaceRoot?: string;
  /** Codex native authority compiled into the private permission profile. */
  codexNativeAuthority?: CodexNativeAuthority;
  /**
   * Exact provider thread selected by main for a persisted Codex resume.
   * Governed preparation never discovers or falls back to a "latest" thread.
   */
  codexResumeSessionId?: string;
  /** Test seam for the machine-admin Codex skill tier. */
  codexAdminSkillsRoot?: string;
  /**
   * Exact model sealed by main for this spawn (`--model` flag). Pre-written
   * into the immutable private config so the TUI does not try to persist
   * default-model / migration prefs (and red-error on protectedWritePaths).
   */
  model?: string;
  /** Main resolved a Xiaomi API-key account into XIAOMI_API_KEY for this spawn. */
  mimoApiKeySelected?: boolean;
  /** Main's active loopback status listener. Never persisted in the hook source. */
  mimoHookEndpoint?: { port: number; token: string };
  mimoCustomConfigDir?: string;
  /**
   * F-1567: o Nexus injetou a chave do Qwen neste spawn — o overlay grava um
   * settings.json MESCLADO (o do operador + entradas `modelProviders` com
   * `envKey` aleatório por spawn e esta base URL) em vez de ligar o
   * arquivo real. Sem segredo: a entrada só referencia a variável de ambiente.
   */
  qwenSettingsInjection?: {
    readonly baseUrl: string;
    readonly models: readonly string[];
    readonly tokenPlanKey: boolean;
    readonly envKey: string;
  };
}

export interface CliMcpSessionResult {
  /** Private accountless MiMo identity, used only for Main resume ownership. */
  mimoNativeOwnerKey?: string;
  env: Record<string, string>;
  extraArgs: string[];
  serverName: string;
  artifactDir: string | null;
  /**
   * Real provider-state path (or exact credential file, e.g. OpenCode's
   * auth.json) the overlay symlinks auth/profile state INTO the ephemeral
   * artifactDir from. The advisory Seatbelt profile must grant read+write
   * here: the CLI refreshes credentials through those symlinks, which the
   * kernel resolves to the real path.
   */
  providerStateHome?: string;
  /**
   * Exact real paths a governed session may read/write auth material from
   * (F-569: never the whole provider home — only the auth files/dirs the
   * overlay actually symlinks). Additive to providerStateHome.
   */
  providerStateReadPaths?: readonly string[];
  /** Exact real paths a governed session may write auth material to (F-569). */
  providerStateWritePaths?: readonly string[];
  /** Durable checkout conversation state, also granted to governed CLIs. */
  providerSessionHome?: string;
  /** Present only for a Codex session whose private profile was compiled. */
  codexPermissionProfile?: string;
  /**
   * Main-owned outer sandbox descriptor for the complete Codex process.
   * The PTY layer applies it only after the executable and argv are sealed.
   */
  codexProcessSandbox?: CodexGovernedProcessSandbox;
}

export interface CodexGovernedProcessSandbox {
  readonly sandboxDir: string;
  readonly processHome: string;
  readonly processTmp: string;
  readonly providerStatePaths: readonly string[];
  readonly protectedWritePaths: readonly string[];
}

export interface CliMcpPurgeOptions {
  home?: string;
  artifactRoot?: string;
}
