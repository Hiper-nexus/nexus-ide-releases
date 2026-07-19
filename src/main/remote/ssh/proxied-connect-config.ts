// Nexus-authored glue between the vendored emdash proxy transports and ssh2.
//
// SECURITY DIVERGENCE FROM UPSTREAM: emdash's resolveSshConnectConfig set
// ConnectConfig.sock from these transports but never set a hostVerifier, so
// ssh2 auto-accepted ANY host key (confirmed upstream gap — unlike the OpenSSH
// CLI, ssh2 reads no known_hosts). Here the host key verifier is a REQUIRED
// parameter: a proxied connect fragment cannot be built without it, and the
// returned fragment carries the verifier next to the socket so the caller
// cannot "forget" to wire it. Production callers inject the known-hosts TOFU
// verifier from src/main/remote/ssh/known-hosts.ts (see
// src/main/integrations/ssh2-transport.ts); the audit-approved fail-closed
// semantics are unchanged for proxied connections.

import type { Duplex } from 'node:stream';
import {
  spawnProxyCommand,
  spawnProxyJump,
  type ProxyTokens,
  type SpawnProcess,
  type TransportResult,
} from '../../../vendor/emdash/ssh/transports';

/** How the SSH connection should reach the destination network namespace. */
export type SshProxySpec =
  | { readonly kind: 'jump'; readonly jumpSpec: string }
  | { readonly kind: 'command'; readonly command: string };

/** ssh2 hostVerifier callback shape (hashed-key, callback form). */
export type SshHostVerifier = (key: Buffer, verify: (ok: boolean) => void) => void;

export type ProxiedConnectFragment = {
  /** Duplex to assign to ssh2 ConnectConfig.sock. */
  readonly sock: Duplex;
  /** Terminates the proxy child (SIGTERM, then SIGKILL after a grace period). */
  readonly cleanup: () => void;
  /** Bounded stderr lines captured from the proxy process. */
  readonly debugLogs: readonly string[];
  /** The verifier that MUST be assigned to ssh2 ConnectConfig.hostVerifier. */
  readonly hostVerifier: SshHostVerifier;
};

/**
 * Build the ssh2 connect-config fragment for a proxied connection.
 *
 * `destination` is the FINAL SSH endpoint (host/port/username after any config
 * resolution), not the jump host: the known-hosts vault pins the destination's
 * key, and the spawned system ssh verifies the jump host itself via the user's
 * own known_hosts.
 *
 * Throws (fail closed) when `hostVerifier` is missing or when the proxy spec
 * contains characters outside the vendored allowlists.
 */
export function buildProxiedConnectFragment(
  proxy: SshProxySpec,
  destination: ProxyTokens,
  hostVerifier: SshHostVerifier,
  spawnProcess?: SpawnProcess,
): ProxiedConnectFragment {
  if (typeof hostVerifier !== 'function') {
    throw new Error(
      'proxied-connect-config: hostVerifier is required (fail closed) — ' +
        'upstream emdash connected through proxy transports without verifying host keys',
    );
  }
  const transport: TransportResult =
    proxy.kind === 'jump'
      ? spawnProxyJump(proxy.jumpSpec, destination.host, destination.port, spawnProcess)
      : spawnProxyCommand(proxy.command, destination, spawnProcess);
  return {
    sock: transport.sock,
    cleanup: transport.cleanup,
    debugLogs: transport.debugLogs,
    hostVerifier,
  };
}
