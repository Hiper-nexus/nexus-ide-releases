import { describe, expect, it } from 'vitest';
import type { MissionPaneSpec } from '../../shared/orch-types';
import {
  paneActivityDisplay,
  resolvePaneActivity,
} from './pane-activity-display';

function spec(
  paneId: string | undefined,
  activity: MissionPaneSpec['activity'],
): MissionPaneSpec {
  return {
    id: `mission-pane-${paneId ?? 'legacy'}`,
    missionId: 'mission-a',
    adapterId: 'codex',
    title: 'Executor',
    role: 'worker',
    paneId,
    createdAt: 1,
    activity,
  };
}

describe('pane activity display', () => {
  it('resolves activity only for the exact persisted pane id', () => {
    const activity = {
      title: 'Corrigir o checkout',
      lastLine: 'Vitest: 12 testes passaram',
      stoppedAt: 42,
      source: 'tail' as const,
    };
    expect(
      resolvePaneActivity(
        [spec('pane-other', null), spec('pane-worker', activity)],
        'pane-worker',
      ),
    ).toEqual(activity);
    expect(resolvePaneActivity([spec(undefined, activity)], 'pane-worker')).toBeNull();
  });

  it('shows the latest meaningful line and keeps the first task as context', () => {
    expect(
      paneActivityDisplay({
        title: 'Corrigir o checkout',
        lastLine: 'Vitest: 12 testes passaram',
        stoppedAt: 42,
        source: 'tail',
      }),
    ).toEqual({
      text: 'Vitest: 12 testes passaram',
      title: 'Corrigir o checkout — Vitest: 12 testes passaram',
    });
  });

  it('falls back to the first task and hides empty metadata', () => {
    expect(
      paneActivityDisplay({
        title: 'Mapear autenticação',
        lastLine: null,
        stoppedAt: 42,
        source: 'transcript',
      }),
    ).toEqual({ text: 'Mapear autenticação', title: 'Mapear autenticação' });
    expect(paneActivityDisplay(null)).toBeNull();
  });
});
