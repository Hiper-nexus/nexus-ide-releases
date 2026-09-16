import type { GovernedCliProfileOptions } from './governed-cli-profile';
import type { CodexNativeAuthority } from '../pty/codex-native-authority';
import type { McpHubSpawnServer } from '../mcp-hub/mcp-hub-spawn';

export interface CliMcpSessionOptions extends GovernedCliProfileOptions {
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
}

export interface CliMcpSessionResult {
  env: Record<string, string>;
  extraArgs: string[];
  serverName: string;
  artifactDir: string | null;
  /**
   * Real provider home the overlay symlinks auth/profile state INTO the
   * ephemeral artifactDir from (e.g. ~/.kimi-code, ~/.grok). The advisory
   * Seatbelt profile must grant read+write here: the CLI refreshes credentials
   * through those symlinks, which the kernel resolves to the real path. Absent
   * for self-contained overlays (OpenCode) that never symlink a real home.
   */
  providerStateHome?: string;
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
