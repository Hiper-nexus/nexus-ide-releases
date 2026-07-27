import type { GovernedCliProfileOptions } from './governed-cli-profile';
import type { CodexNativeAuthority } from '../pty/codex-native-authority';

export interface CliMcpSessionOptions extends GovernedCliProfileOptions {
  home?: string;
  providerHome?: string;
  artifactRoot?: string;
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
}

export interface CliMcpSessionResult {
  env: Record<string, string>;
  extraArgs: string[];
  serverName: string;
  artifactDir: string | null;
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
