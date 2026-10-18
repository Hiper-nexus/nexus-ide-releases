import { describe, expect, it } from 'vitest';
import type { PaneModel } from '../../shared/types';
import type { Mission } from '../../shared/orch-types';
import { closingPaneEndsMission } from './mission-last-pane-notify';

const pane = (id: string, missionId?: string): PaneModel => ({ id, kind: 'cli-agent', title: id, missionId });
const mission = (over: Partial<Mission> = {}): Mission =>
  ({ id: 'm', title: 'M', description: '', status: 'running', milestones: [], learnings: '', createdAt: 1, updatedAt: 1, ...over }) as Mission;

describe('closingPaneEndsMission', () => {
  it('é verdadeiro só para o último pane de uma missão running', () => {
    expect(closingPaneEndsMission(pane('a', 'm'), [], [mission()], {})).toBe(true);
    expect(closingPaneEndsMission(pane('a', 'm'), [pane('b', 'm')], [mission()], {})).toBe(false);
    expect(closingPaneEndsMission(pane('a'), [], [mission()], {})).toBe(false);
    expect(closingPaneEndsMission(pane('a', 'm'), [], [mission({ status: 'done' })], {})).toBe(false);
  });

  it('enxerga o vínculo transitório pane→missão e ignora panes de outra missão', () => {
    expect(closingPaneEndsMission(pane('a'), [pane('x', 'other')], [mission()], { a: 'm' })).toBe(true);
    expect(closingPaneEndsMission(pane('a'), [pane('b')], [mission()], { a: 'm', b: 'm' })).toBe(false);
  });

  it('não promete encerrar quando a missão ainda espera o humano', () => {
    const waiting = mission({ status: 'blocked', intentState: 'blocked_user' });
    expect(closingPaneEndsMission(pane('a', 'm'), [], [waiting], {})).toBe(false);
  });
});
