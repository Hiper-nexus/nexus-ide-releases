import { afterEach, describe, expect, it } from 'vitest';
import {
  applyAgentStatusHooksEnabled,
  clearManagedAgentHookServices,
  getManagedAgentHookStatuses,
  isAgentStatusHooksEnabled,
  registerManagedAgentHookService,
} from './managed-agent-hook-controls';
import type { AgentHookInstallStatus } from '../../shared/agent-hook-types';

afterEach(() => {
  clearManagedAgentHookServices();
});

describe('managed-agent-hook-controls (Nexus registry)', () => {
  it('defaults hooks enabled unless explicitly false', () => {
    expect(isAgentStatusHooksEnabled(undefined)).toBe(true);
    expect(isAgentStatusHooksEnabled({})).toBe(true);
    expect(isAgentStatusHooksEnabled({ agentStatusHooksEnabled: false })).toBe(false);
  });

  it('installs and reports via registered services only', () => {
    let installed = false;
    const status = (): AgentHookInstallStatus => ({
      agent: 'claude',
      state: installed ? 'installed' : 'not_installed',
      configPath: '/tmp/hooks',
      managedHooksPresent: installed,
      detail: null,
    });
    registerManagedAgentHookService('claude', {
      install: () => {
        installed = true;
      },
      remove: () => {
        installed = false;
        return status();
      },
      getStatus: status,
    });
    expect(getManagedAgentHookStatuses()).toEqual([
      expect.objectContaining({ state: 'not_installed' }),
    ]);
    expect(applyAgentStatusHooksEnabled(true)).toEqual([
      expect.objectContaining({ state: 'installed', managedHooksPresent: true }),
    ]);
    expect(applyAgentStatusHooksEnabled(false)).toEqual([
      expect.objectContaining({ state: 'not_installed' }),
    ]);
  });
});
