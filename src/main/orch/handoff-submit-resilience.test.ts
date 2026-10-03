import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentGateContext } from './gate';
import type { McpToolDef } from './mcp-protocol';
import { testProjectScope } from './__tests__/scope-fixture';

const h = vi.hoisted(() => ({
  schedule: vi.fn(async () => null),
  records: [] as Array<Record<string, unknown>>,
}));
vi.mock('./isolated-writer-salvage', () => ({ scheduleWorktreeSalvage: h.schedule }));
vi.mock('./isolated-writer-worktree', () => ({ OPERATOR_HAND_WORKTREE_KEY: 'operator-hand' }));
vi.mock('../runtime/worktree-runtime-registry', () => ({
  requireWorktreeRuntimeRegistry: () => ({
    listMission: (_scope: unknown, key: string) => h.records.filter((record) => record.missionId === key),
  }),
}));

import { withHandoffSubmitResilience } from './handoff-submit-resilience';

const coordination = testProjectScope({ rootRealPath: '/repo/checkout' });
const worktreePath = '/repo/worktrees/task-a';

function ctx(overrides: Partial<AgentGateContext> = {}): AgentGateContext {
  return {
    token: 't', label: 'Codex', agentName: 'Writer F-764', role: 'worker', sessionId: 'session-w',
    missionId: 'mission-a', scope: coordination,
    executionScope: { ...coordination, rootRealPath: worktreePath },
    allowedTools: [], allowedSkills: null, stopAttempts: 0, handoffSubmitted: false,
    ...overrides,
  };
}

function submitTool(handler: McpToolDef['handler']): McpToolDef {
  return { name: 'nexus_handoff_submit', description: 'x', inputSchema: { type: 'object' }, handler };
}

beforeEach(() => {
  h.schedule.mockClear();
  h.records = [{
    missionId: 'mission-a', ownerKind: 'pane', worktreePath, taskId: 'pane-1',
    branchRef: 'refs/heads/nexus/aaaa/bbbb', status: 'ready',
  }];
});

describe('envoltório do nexus_handoff_submit', () => {
  it('handler que recusa (retry do contrato/Jev) não agenda salvaguarda', async () => {
    const tool = withHandoffSubmitResilience(submitTool(async () => {
      throw new Error('summary inválido');
    }));
    await expect(tool.handler({}, ctx())).rejects.toThrow('summary inválido');
    expect(h.schedule).not.toHaveBeenCalled();
  });

  it('agenda a salvaguarda da worktree registrada do writer isolado depois do handoff (F-794)', async () => {
    const tool = withHandoffSubmitResilience(submitTool(async () => ({ ok: true, handoffId: 'handoff-7' })));
    await expect(tool.handler({}, ctx())).resolves.toMatchObject({ handoffId: 'handoff-7' });
    expect(h.schedule).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreePath, branchRef: 'refs/heads/nexus/aaaa/bbbb', missionId: 'mission-a', taskId: 'pane-1',
        reason: 'handoff', handoffId: 'handoff-7', sessionId: 'session-w', agentLabel: 'Writer F-764',
      }),
      { scope: coordination, notify: true },
    );
  });

  it('não agenda para worker no checkout de coordenação, read-only ou sem registro', async () => {
    const tool = withHandoffSubmitResilience(submitTool(async () => ({ ok: true, handoffId: 'h' })));
    await tool.handler({}, ctx({ executionScope: coordination }));
    await tool.handler({}, ctx({ readOnly: true }));
    h.records = [];
    await tool.handler({}, ctx());
    expect(h.schedule).not.toHaveBeenCalled();
  });

  it('salvaguarda quebrada nunca derruba o handoff entregue', async () => {
    h.schedule.mockImplementationOnce(() => {
      throw new Error('registry sumiu');
    });
    const tool = withHandoffSubmitResilience(submitTool(async () => ({ ok: true, handoffId: 'h' })));
    await expect(tool.handler({}, ctx())).resolves.toMatchObject({ ok: true, handoffId: 'h' });
  });
});
