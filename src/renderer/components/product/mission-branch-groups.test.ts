import { describe, expect, it } from 'vitest';
import {
  flattenMissionBranchGroups,
  primaryMissionWorktree,
  worktreeStatusLabel,
} from './mission-branch-groups';

const m = (id: string, worktrees?: Array<{ branch: string; status: 'reserved' | 'ready' | 'queued' | 'integrated' | 'failed' | 'abandoned' }>) =>
  ({ id, worktrees });

describe('flattenMissionBranchGroups', () => {
  it('põe a branch como nó e a missão embaixo; missão sem worktree fica solta no projeto', () => {
    const rows = flattenMissionBranchGroups([
      m('solta'),
      m('a', [{ branch: 'feat/mf-103-operacao-furos', status: 'ready' }]),
      m('b', [{ branch: 'feat/mf-103-operacao-furos', status: 'ready' }]),
      m('c', [{ branch: 'fix/mf-74-migration', status: 'queued' }]),
    ]);
    expect(rows.map((r) => (r.kind === 'branch' ? `#${r.branch}` : r.mission.id))).toEqual([
      'solta',
      '#feat/mf-103-operacao-furos',
      'a',
      'b',
      '#fix/mf-74-migration',
      'c',
    ]);
  });

  it('com vários worktrees, o nó é o do worktree ATIVO', () => {
    const primary = primaryMissionWorktree([
      { branch: 'old/integrated', status: 'integrated' },
      { branch: 'feat/live', status: 'ready' },
    ]);
    expect(primary?.branch).toBe('feat/live');
  });

  it('sem worktree ativo, vale o primeiro — melhor mostrar o histórico do que sumir', () => {
    expect(primaryMissionWorktree([{ branch: 'x', status: 'failed' }])?.branch).toBe('x');
    expect(primaryMissionWorktree([])).toBeNull();
    expect(primaryMissionWorktree(undefined)).toBeNull();
  });

  it('mantém a ordem de primeira aparição para a lista não pular no refresh', () => {
    const rows = flattenMissionBranchGroups([
      m('1', [{ branch: 'b', status: 'ready' }]),
      m('2', [{ branch: 'a', status: 'ready' }]),
      m('3', [{ branch: 'b', status: 'ready' }]),
    ]);
    expect(rows.filter((r) => r.kind === 'branch').map((r) => r.kind === 'branch' && r.branch)).toEqual(['b', 'a']);
  });

  it('rotula o estado em uma palavra e cala quando é só ready', () => {
    expect(worktreeStatusLabel('ready')).toBeNull();
    expect(worktreeStatusLabel('queued')).toBe('na fila');
    expect(worktreeStatusLabel('failed')).toBe('falhou');
  });
});
