import { describe, expect, it } from 'vitest';
import type { MissionSummarySnapshot } from '../../../shared/mission-engine-contract';
import { projectRailWorkspaces } from './rail-workspaces';

function summary(
  id: string,
  state: MissionSummarySnapshot['state'],
): MissionSummarySnapshot {
  return {
    id,
    title: `Missão ${id}`,
    state,
    progress: { total: 1, completed: 0 },
    needsAttention: false,
    updatedAt: 1,
  };
}

describe('projectRailWorkspaces', () => {
  const current = { path: '/ws/atual', name: 'atual' };
  const recents = [
    { path: '/ws/atual', name: 'atual' },
    { path: '/ws/alpha', name: 'alpha' },
    { path: '/ws/beta', name: 'beta' },
  ];

  it('workspace corrente mantém TODAS as suas missões (comportamento atual)', () => {
    const result = projectRailWorkspaces({
      current,
      recents,
      currentSummaries: [summary('a', 'running'), summary('b', 'completed')],
      crossWorkspaceSummaries: {},
    });
    expect(result.activeWorkspaces).toHaveLength(1);
    expect(result.activeWorkspaces[0]!.missions.map((m) => m.id)).toEqual([
      'a',
      'b',
    ]);
  });

  it('workspace vizinho com missão ATIVA aparece em Em andamento — o caso das duas missões invisíveis', () => {
    const result = projectRailWorkspaces({
      current,
      recents,
      currentSummaries: [summary('a', 'running')],
      crossWorkspaceSummaries: {
        '/ws/alpha': [summary('x1', 'running'), summary('x2', 'completed')],
      },
    });
    expect(result.activeWorkspaces.map((w) => w.id)).toEqual([
      '/ws/atual',
      '/ws/alpha',
    ]);
    // Só as missões ATIVAS do vizinho entram; concluída não polui o rail.
    expect(
      result.activeWorkspaces[1]!.missions.map((m) => m.id),
    ).toEqual(['x1']);
  });

  it('vizinho sem missão ativa NÃO entra em Em andamento e segue só em Recentes', () => {
    const result = projectRailWorkspaces({
      current,
      recents,
      currentSummaries: [],
      crossWorkspaceSummaries: {
        '/ws/beta': [summary('só-concluída', 'completed')],
      },
    });
    expect(result.activeWorkspaces.map((w) => w.id)).toEqual(['/ws/atual']);
    expect(result.recentWorkspaces.map((w) => w.id)).toEqual([
      '/ws/alpha',
      '/ws/beta',
    ]);
    expect(result.recentWorkspaces.every((w) => w.missions.length === 0)).toBe(
      true,
    );
  });

  it('missão bloqueada também conta como ativa (precisa do operador)', () => {
    const result = projectRailWorkspaces({
      current,
      recents,
      currentSummaries: [],
      crossWorkspaceSummaries: {
        '/ws/alpha': [summary('blk', 'blocked_technical')],
      },
    });
    expect(result.activeWorkspaces.map((w) => w.id)).toEqual([
      '/ws/atual',
      '/ws/alpha',
    ]);
  });
});
