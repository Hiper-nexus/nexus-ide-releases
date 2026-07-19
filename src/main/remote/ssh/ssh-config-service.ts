// Nexus-authored internal service over the vendored emdash SSH config modules
// (src/vendor/emdash/ssh/). Exposes ~/.ssh/config aliases and canonical
// `ssh -G` resolution to the rest of the main process (e.g. the SSH session
// flow) without re-implementing OpenSSH semantics locally.
//
// Design rules:
//  - Best-effort and fail-SOFT for resolution: a missing ssh binary, unreadable
//    config or a `ssh -G` failure never breaks an explicit user-provided host.
//  - Fail-CLOSED for identity: only an EXACT alias match from the parser
//    listing triggers resolution — an arbitrary host string is never rewritten
//    by config lookup (no surprise host substitution).
//  - Host key verification is out of scope here and stays mandatory at the
//    transport layer (known-hosts TOFU), regardless of where host/port came
//    from.

import {
  parseSshConfigFile,
  parseSshConfigFileAt,
} from '../../../vendor/emdash/ssh/ssh-config-parser';
import type { SshConfigHost } from '../../../vendor/emdash/ssh/ssh-config-host';
import {
  resolveSshConfig,
  type ResolvedSshConfig,
  type SshConfigRunner,
} from '../../../vendor/emdash/ssh/resolve-ssh-config';

/** Effective connection settings for a ~/.ssh/config alias. */
export type SshConnectDefaults = {
  /** The alias as written in ~/.ssh/config. */
  readonly alias: string;
  /** Effective hostname (falls back to the alias itself when unset). */
  readonly host: string;
  /** Effective port; undefined when it is the OpenSSH default (22). */
  readonly port?: number;
  /** Effective user, when the config sets one. */
  readonly username?: string;
  readonly proxyJump?: string;
  readonly proxyCommand?: string;
  readonly identityFiles?: readonly string[];
};

export type SshConfigServiceDeps = {
  /** Alias listing source; defaults to parsing ~/.ssh/config. */
  readonly listHosts?: () => Promise<readonly SshConfigHost[]>;
  /** `ssh -G` runner; defaults to execFile of the system ssh. */
  readonly runner?: SshConfigRunner;
};

/** List concrete aliases from ~/.ssh/config (empty on any read/parse failure). */
export async function listSshConfigHosts(configPath?: string): Promise<readonly SshConfigHost[]> {
  try {
    return configPath ? await parseSshConfigFileAt(configPath) : await parseSshConfigFile();
  } catch {
    return [];
  }
}

/**
 * Resolve `hostOrAlias` to effective OpenSSH settings when — and only when —
 * it exactly matches a Host alias declared in ~/.ssh/config. Returns null for
 * non-alias input so callers keep their explicit values untouched.
 *
 * Canonical values come from `ssh -G` (handles Match blocks, wildcards and
 * inheritance); when the ssh binary is unavailable the parser's preview fields
 * are used as a fallback so ProxyJump/HostName still work.
 */
export async function resolveSshConnectDefaults(
  hostOrAlias: string,
  deps: SshConfigServiceDeps = {},
): Promise<SshConnectDefaults | null> {
  const alias = hostOrAlias.trim();
  if (!alias) return null;

  const listHosts = deps.listHosts ?? (() => listSshConfigHosts());
  let hosts: readonly SshConfigHost[];
  try {
    hosts = await listHosts();
  } catch {
    return null;
  }
  const preview = hosts.find((entry) => entry.host === alias);
  if (!preview) return null;

  let resolved: ResolvedSshConfig | null = null;
  try {
    resolved = await resolveSshConfig(alias, { runner: deps.runner });
  } catch {
    resolved = null; // No usable ssh binary: fall back to the parser preview.
  }

  if (!resolved) {
    return {
      alias,
      host: preview.hostname ?? alias,
      port: preview.port,
      username: preview.user,
      proxyJump: preview.proxyJump,
      proxyCommand: preview.proxyCommand,
      identityFiles: preview.identityFile ? [preview.identityFile] : undefined,
    };
  }

  return {
    alias,
    host: resolved.hostname || preview.hostname || alias,
    port: resolved.port === 22 ? (preview.port ?? undefined) : resolved.port,
    username: resolved.user || preview.user,
    proxyJump: resolved.proxyJump ?? preview.proxyJump,
    proxyCommand: resolved.proxyCommand ?? preview.proxyCommand,
    identityFiles:
      resolved.identityFile.length > 0
        ? resolved.identityFile
        : preview.identityFile
          ? [preview.identityFile]
          : undefined,
  };
}
