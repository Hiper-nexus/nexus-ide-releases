import { describe, expect, it } from 'vitest';
import type { ProjectExecutionScope } from '../../shared/types';
import type { AgentGateContext } from './gate';
import { effectPolicyForTool } from './mcp-effect-policy';
import { buildPaneTools } from './tools-panes';

const scope: ProjectExecutionScope = Object.freeze({
  version: 1,
  installationId: 'install-1',
  projectId: 'project-1',
  checkoutId: 'checkout-1',
  rootRealPath: '/workspace',
  identitySource: 'provisional',
});

function context(): AgentGateContext {
  return {
    token: 'secret-bearer-token',
    label: 'Frontend worker',
    role: 'worker',
    sessionId: 'session-1',
    missionId: 'mission-1',
    contextRevision: 'ctx-1',
    agentName: 'Frontend',
    providerId: 'codex',
    scope,
    executionScope: Object.freeze({ ...scope, rootRealPath: '/workspace/.worktrees/task-1' }),
    allowedTools: ['nexus_file_read'],
    allowedSkills: ['react-best-practices'],
    stopAttempts: 0,
    handoffSubmitted: false,
  };
}

describe('nexus_pane_whoami', () => {
  it('returns effective self authority without leaking the bearer token', async () => {
    const tool = buildPaneTools().find((candidate) => candidate.name === 'nexus_pane_whoami');
    expect(tool).toBeDefined();
    const result = await tool!.handler({}, context());
    expect(result).toMatchObject({
      role: 'worker',
      missionId: 'mission-1',
      agentName: 'Frontend',
      providerId: 'codex',
      executionRoot: '/workspace/.worktrees/task-1',
      allowedTools: ['nexus_file_read'],
    });
    expect(JSON.stringify(result)).not.toContain('secret-bearer-token');
    expect(effectPolicyForTool(tool!.name)).toBe('read-only');
  });
});
