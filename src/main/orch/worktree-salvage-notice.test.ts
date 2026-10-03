import { describe, expect, it, vi } from 'vitest';

vi.mock('./idle-delivery', () => ({ onHandoffSubmitted: vi.fn() }));
vi.mock('./isolated-writer-worktree', () => ({ OPERATOR_HAND_WORKTREE_KEY: 'operator-hand' }));

import { submitWorktreeSalvageNotice } from './worktree-salvage-notice';
import { testProjectScope } from './__tests__/scope-fixture';
import type { WorktreeSalvageNotice } from './isolated-writer-salvage';

const scope = testProjectScope({ rootRealPath: '/repo/checkout' });

function notice(missionId = 'mission-a'): WorktreeSalvageNotice {
  return {
    scope,
    target: {
      worktreePath: '/repo/worktrees/a', branchRef: 'refs/heads/nexus/aaaa/bbbb', missionId,
      taskId: 'pane-1', reason: 'pane-exit', sessionId: 'session-w', agentLabel: 'Writer F-768',
    },
    result: {
      kind: 'saved', ref: 'refs/nexus-salvage/nexus/aaaa/bbbb/20261003T144400000Z',
      commit: 'c'.repeat(40), baseSha: 'b'.repeat(40),
      files: [{ status: 'M', path: 'src/main/memory/trusted-memory.ts' }], fileCount: 1,
      skipped: [], untrackedOmitted: 0,
    },
  };
}

function fakeStores(mission: unknown = { id: 'mission-a' }) {
  const submitted: Array<Record<string, unknown>> = [];
  return {
    submitted,
    deps: {
      getStores: () => ({
        missions: { get: () => mission },
        handoffs: {
          submit: (input: Record<string, unknown>) => {
            submitted.push(input);
            return { id: 'handoff-notice', ...input };
          },
        },
      }) as never,
      deliver: vi.fn(),
    },
  };
}

describe('aviso de salvaguarda ao orquestrador (F-794)', () => {
  it('grava um handoff sintético não terminal com a ref e o commit, e entrega ao orquestrador', () => {
    const { submitted, deps } = fakeStores();
    expect(submitWorktreeSalvageNotice(notice(), deps)).toBe('handoff-notice');
    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toMatchObject({
      missionId: 'mission-a',
      status: 'progress',
      fromAgent: 'nexus-worktree-salvage',
      artifacts: [expect.objectContaining({
        kind: 'nexus.worktree-salvage',
        payload: expect.objectContaining({
          ref: 'refs/nexus-salvage/nexus/aaaa/bbbb/20261003T144400000Z',
          commit: 'c'.repeat(40),
          sessionId: 'session-w',
        }),
      })],
    });
    // Autor sintético: o laço de cobrança de handoff não o confunde com relato real.
    expect(String(submitted[0].fromAgent).startsWith('nexus-')).toBe(true);
    expect(String(submitted[0].summary)).toContain('git cherry-pick cccccccccccc');
    expect(deps.deliver).toHaveBeenCalledWith(expect.objectContaining({ id: 'handoff-notice' }), scope);
  });

  it('writer da mão do operador e missão inexistente ficam só no trace', () => {
    const operator = fakeStores();
    expect(submitWorktreeSalvageNotice(notice('operator-hand'), operator.deps)).toBeNull();
    const missing = fakeStores(null);
    expect(submitWorktreeSalvageNotice(notice(), missing.deps)).toBeNull();
    expect(operator.submitted).toHaveLength(0);
    expect(missing.submitted).toHaveLength(0);
  });
});
