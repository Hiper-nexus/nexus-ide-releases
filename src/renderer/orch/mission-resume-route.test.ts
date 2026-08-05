import { describe, expect, it } from 'vitest';
import { missionResumeRoute } from './mission-resume-route';

describe('missionResumeRoute', () => {
  it('focuses the live panes when the mission is already on screen', () => {
    expect(
      missionResumeRoute({ livePanes: 2, recordedPanes: 4, isArmedShell: false }),
    ).toEqual({ kind: 'panes', recordedPanes: 4, live: true });
  });

  it('reopens the recorded panes of a mission whose panes were reaped', () => {
    expect(
      missionResumeRoute({ livePanes: 0, recordedPanes: 4, isArmedShell: false }),
    ).toEqual({ kind: 'panes', recordedPanes: 4, live: false });
  });

  it('NEVER routes a mission with recorded panes to the wizard', () => {
    // O bug relatado: a missão foi classificada como "shell armado" e o
    // operador foi ejetado para Nova Missão, perdendo os panes de vista.
    // Prova vence classificação: se há panes gravados, o destino é panes.
    expect(
      missionResumeRoute({ livePanes: 0, recordedPanes: 4, isArmedShell: true }),
    ).toEqual({ kind: 'panes', recordedPanes: 4, live: false });
  });

  it('opens the wizard only with proof of zero recorded panes', () => {
    expect(
      missionResumeRoute({ livePanes: 0, recordedPanes: 0, isArmedShell: true }),
    ).toEqual({ kind: 'wizard' });
  });

  it('stays in place instead of falling back to the wizard', () => {
    const route = missionResumeRoute({
      livePanes: 0,
      recordedPanes: 0,
      isArmedShell: false,
    });

    expect(route.kind).toBe('stay');
    expect(route.kind === 'stay' ? route.notice : '').toContain(
      'Nova missão',
    );
    expect(route.kind === 'stay' ? route.notice : '').toContain('histórico');
  });
});
