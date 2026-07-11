import { describe, expect, it } from 'vitest';
import type { ProjectExecutionScope } from '../../shared/types';
import {
  createRemoteHostCapability,
  remoteCapabilityGrantsAgentForce,
  scopeKeyFromExecutionScope,
} from './remote-capability';

const scope: ProjectExecutionScope = {
  version: 1,
  installationId: 'inst',
  projectId: '11111111-1111-4111-8111-111111111111',
  checkoutId: 'co',
  rootRealPath: '/tmp/proj',
  identitySource: 'manifest',
};

describe('remote-capability', () => {
  it('binds host capability to local execution scope key', () => {
    const cap = createRemoteHostCapability({
      kind: 'ssh',
      hostId: 'user@host',
      displayName: 'dev box',
      scope,
    });
    expect(cap.scopeKey).toBe(scopeKeyFromExecutionScope(scope));
    expect(cap.encryptedTransportRequired).toBe(true);
    expect(remoteCapabilityGrantsAgentForce(cap)).toBe(false);
  });
});
