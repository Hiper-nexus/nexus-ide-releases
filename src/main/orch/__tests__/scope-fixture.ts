// Domain fixtures represent a signed-in Pro operator. License-denial suites override this policy explicitly.
import { vi } from 'vitest';
vi.mock('../../license-access', async () => (await import('../../__tests__/licensed-access')).licensedAccessMock);

import type { ProjectExecutionScope } from '../../../shared/types';

export function testProjectScope(
  overrides: Partial<ProjectExecutionScope> = {},
): ProjectExecutionScope {
  return {
    version: 1,
    installationId: 'installation-test',
    projectId: 'project-test',
    checkoutId: 'checkout-test',
    rootRealPath: '/workspace',
    identitySource: 'manifest',
    ...overrides,
  };
}
