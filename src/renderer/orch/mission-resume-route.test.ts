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

// B-246 (voo real 05/08, mission-3be48989): a missão parou, o intent foi
// recompilado para v2 e TODOS os sinais de pane morreram junto —
// `mission_panes` vazio, `orch_session_id` NULL, `intentContract.dispatchedAt`
// ausente (verificado no runtime.sqlite3). Sobrou a prova durável: 8 tasks na
// fila e o plano selado. Com recordedPanes=0 e awaiting_approval (armed shell)
// a rota mandava o operador para o assistente de Nova Missão — o caminho de
// perda-de-trabalho-por-UI que ele acertou ao vivo.
describe('missionResumeRoute — plano selado é prova de trabalho', () => {
  const semPanes = { livePanes: 0, recordedPanes: 0, isArmedShell: true };

  it('NUNCA manda ao assistente uma missão que já tem plano, mesmo sem panes', () => {
    const route = missionResumeRoute({ ...semPanes, plannedWork: 8 });
    expect(route.kind).not.toBe('wizard');
  });

  it('mantém o operador na página e nomeia o plano preservado', () => {
    const route = missionResumeRoute({ ...semPanes, plannedWork: 8 });
    expect(route.kind).toBe('stay');
    if (route.kind !== 'stay') throw new Error('esperava stay');
    expect(route.notice).toContain('8');
    expect(route.notice).toContain('preservad');
  });

  it('panes gravados continuam mandando no destino mesmo com plano', () => {
    expect(
      missionResumeRoute({ ...semPanes, recordedPanes: 3, plannedWork: 8 }).kind,
    ).toBe('panes');
  });

  it('shell armado de verdade (zero plano, zero panes) segue indo ao assistente', () => {
    expect(missionResumeRoute({ ...semPanes, plannedWork: 0 }).kind).toBe(
      'wizard',
    );
    expect(missionResumeRoute(semPanes).kind).toBe('wizard');
  });
});
