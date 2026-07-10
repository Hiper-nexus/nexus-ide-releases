import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentGateContext } from './gate';
import {
  configureSyncRuntime,
  disposeSyncRuntime,
} from '../context/sync-runtime';
import { buildSyncTools } from './tools-sync';
import { effectPolicyForTool } from './mcp-effect-policy';
import { buildToolset } from './tools';

function context(projectId: string): AgentGateContext {
  return {
    token: `token-${projectId}`,
    label: 'sync-reader',
    role: 'worker',
    scope: {
      version: 1,
      installationId: 'installation-a',
      projectId,
      checkoutId: `checkout-${projectId}`,
      rootRealPath: `/private/${projectId}`,
      identitySource: 'manifest',
    },
    allowedTools: null,
    allowedSkills: null,
    stopAttempts: 0,
    handoffSubmitted: false,
  };
}

afterEach(() => {
  disposeSyncRuntime();
});

describe('nexus_sync_status', () => {
  it('is a no-input read-only projection scoped only by ctx.scope.projectId', async () => {
    const read = vi.fn(async () => ({
      revision: 3,
      entities: [
        {
          entityType: 'mission-metadata' as const,
          entityId: 'mission-a',
          entityVersion: 1,
          baseVersion: 0,
          payload: { title: 'private payload' },
        },
      ],
    }));
    configureSyncRuntime({
      backend: { read, compareAndSwap: vi.fn() as never },
    });
    const [tool] = buildSyncTools();

    const result = await tool.handler(
      { projectId: 'attacker-selected-project' },
      context('project-authorized'),
    );

    expect(tool.name).toBe('nexus_sync_status');
    expect(effectPolicyForTool(tool.name)).toBe('read-only');
    expect(tool.inputSchema).toEqual({ type: 'object', properties: {} });
    expect(read).toHaveBeenCalledWith('project-authorized');
    expect(JSON.stringify(result)).not.toContain('private payload');
    expect(JSON.stringify(result)).not.toContain('/private/project-authorized');
  });

  it('reports unavailable without exposing a publish or CAS tool', async () => {
    configureSyncRuntime({ backend: null });
    const tools = buildSyncTools();

    await expect(tools[0].handler({}, context('project-a'))).resolves.toMatchObject({
      available: false,
      serverStatus: 'unconfigured',
    });
    expect(tools.map((tool) => tool.name)).toEqual(['nexus_sync_status']);
    expect(buildToolset().map((tool) => tool.name)).toContain(
      'nexus_sync_status',
    );
    expect(buildToolset().map((tool) => tool.name)).not.toEqual(
      expect.arrayContaining(['nexus_sync_publish', 'nexus_sync_cas']),
    );
  });
});
