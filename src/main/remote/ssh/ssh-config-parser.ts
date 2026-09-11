// Adapted from stablyai/orca @ f352b6b08d9028ba8b577d6ac8a8247c2a6c9c92
// Copyright (c) 2026 Lovecast Inc. — MIT License
// See third_party/licenses/orca-MIT.txt. Nexus changes: lean Host block parser;
// no Include expansion / full OpenSSH parity (follow-up). Resynced
// 2026-09-11: brought OpenSSH's first-value-wins semantics for single-valued
// keys (below); gssapiAuthentication and parseSshConfigAliasClaims stayed
// upstream — Nexus has no GSSAPI auth path and nothing consumes alias-claim
// detection yet.

import { resolveSshConfigHomePath } from './ssh-config-path-expansion';

export type SshHostConfig = {
  readonly hostPatterns: readonly string[];
  readonly hostname?: string;
  readonly user?: string;
  readonly port?: number;
  readonly identityFiles: readonly string[];
  readonly proxyJump?: string;
};

/**
 * Minimal SSH config parser for Host blocks. Sufficient for unit MVP and
 * identity path expansion; not a full OpenSSH reimplementation.
 */
export function parseSshConfig(
  content: string,
  options?: { home?: string },
): SshHostConfig[] {
  const home = options?.home;
  const hosts: SshHostConfig[] = [];
  let current: {
    hostPatterns: string[];
    hostname?: string;
    user?: string;
    port?: number;
    identityFiles: string[];
    proxyJump?: string;
  } | null = null;

  const flush = () => {
    if (!current) return;
    hosts.push({
      hostPatterns: current.hostPatterns,
      hostname: current.hostname,
      user: current.user,
      port: current.port,
      identityFiles: current.identityFiles,
      proxyJump: current.proxyJump,
    });
    current = null;
  };

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const match = line.match(/^(\S+)\s+(.+)$/);
    if (!match) continue;
    const key = match[1]!.toLowerCase();
    const value = match[2]!.trim();
    if (key === 'host') {
      flush();
      current = {
        hostPatterns: value.split(/\s+/).filter(Boolean),
        identityFiles: [],
      };
      continue;
    }
    if (!current) continue;
    // Why: OpenSSH uses the first obtained value for single-valued parameters,
    // so a repeated directive inside one Host block must not clobber it.
    switch (key) {
      case 'hostname':
        current.hostname ??= value;
        break;
      case 'user':
        current.user ??= value;
        break;
      case 'port': {
        const n = Number(value);
        if (Number.isInteger(n) && n > 0 && n <= 65535) current.port ??= n;
        break;
      }
      case 'identityfile':
        current.identityFiles.push(
          home ? resolveSshConfigHomePath(value, home) : resolveSshConfigHomePath(value),
        );
        break;
      case 'proxyjump':
        current.proxyJump ??= value;
        break;
      default:
        break;
    }
  }
  flush();
  return hosts;
}

/** True if alias matches a Host pattern (supports leading/trailing single `*`). */
export function sshHostPatternMatches(pattern: string, alias: string): boolean {
  if (pattern === '*') return true;
  if (pattern.startsWith('*') && pattern.endsWith('*') && pattern.length > 1) {
    return alias.includes(pattern.slice(1, -1));
  }
  if (pattern.startsWith('*')) {
    return alias.endsWith(pattern.slice(1));
  }
  if (pattern.endsWith('*')) {
    return alias.startsWith(pattern.slice(0, -1));
  }
  return pattern === alias;
}

export function resolveSshHostConfig(
  configs: readonly SshHostConfig[],
  alias: string,
): SshHostConfig | null {
  for (const cfg of configs) {
    if (cfg.hostPatterns.some((p) => sshHostPatternMatches(p, alias))) {
      return cfg;
    }
  }
  return null;
}
