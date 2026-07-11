// Nexus remote host capability — authority remains local ProjectExecutionScope.
// Adapted patterns inspired by stablyai/orca remote transport @ 143c36e
// Copyright (c) 2026 Lovecast Inc. — MIT License (ORCA ideas); Nexus-authored API.
// See third_party/licenses/orca-MIT.txt for ORCA license text.

import type { ProjectExecutionScope } from '../../shared/types';

export type RemoteHostKind = 'ssh' | 'wsl' | 'relay';

/**
 * A remote execution host is an explicit capability attached to a local scope.
 * It never replaces project identity or checkout authority.
 */
export type RemoteHostCapability = {
  readonly kind: RemoteHostKind;
  readonly hostId: string;
  readonly displayName: string;
  /** Local scope that authorizes using this host. */
  readonly scopeKey: string;
  /**
   * Requires a confidential (TLS) transport before use. NOT a claim of
   * end-to-end encryption — device identity is proved separately by
   * device-pairing.ts, which is not an encrypted channel.
   */
  readonly encryptedTransportRequired: boolean;
  readonly paired: boolean;
};

export function scopeKeyFromExecutionScope(scope: ProjectExecutionScope): string {
  return `${scope.installationId}:${scope.projectId}:${scope.checkoutId}`;
}

export function createRemoteHostCapability(input: {
  kind: RemoteHostKind;
  hostId: string;
  displayName: string;
  scope: ProjectExecutionScope;
  encryptedTransportRequired?: boolean;
  paired?: boolean;
}): RemoteHostCapability {
  return Object.freeze({
    kind: input.kind,
    hostId: input.hostId,
    displayName: input.displayName,
    scopeKey: scopeKeyFromExecutionScope(input.scope),
    encryptedTransportRequired: input.encryptedTransportRequired ?? true,
    paired: input.paired ?? false,
  });
}

/** Agent-accessible force is never granted via remote capability. */
export function remoteCapabilityGrantsAgentForce(
  _capability: RemoteHostCapability,
): false {
  return false;
}
