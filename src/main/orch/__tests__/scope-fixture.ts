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
