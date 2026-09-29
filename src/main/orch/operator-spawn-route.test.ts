import { describe, expect, it } from 'vitest';
import {
  ignoredRouteChoice,
  operatorChildUseCounts,
  operatorRouteTask,
  parentPaneIdFor,
  routeString,
  spawnRouteFrom,
  sameAdapterDiversityHint,
} from './operator-spawn-route';

describe('operator-spawn-route', () => {
  it('tarefa vem de task, depois prompt, depois title', () => {
    expect(operatorRouteTask({ task: 'a', prompt: 'b', title: 'c' })).toBe('a');
    expect(operatorRouteTask({ prompt: 'b', title: 'c' })).toBe('b');
    expect(operatorRouteTask({ title: 'c' })).toBe('c');
    expect(operatorRouteTask({ task: '   ' })).toBeNull();
  });

  it('lista só o que o agente mandou e será ignorado', () => {
    expect(ignoredRouteChoice({ adapterId: 'claude', effort: 'high' })).toEqual({
      adapterId: 'claude',
      effort: 'high',
    });
    expect(ignoredRouteChoice({ task: 'x' })).toBeNull();
  });

  it('conta a CLI do pai e dos filhos vivos dele, nunca de outro pai', () => {
    const parentOf = (sid: string) =>
      ({ c1: 'parent', c2: 'parent', c3: 'parent', other: 'someone' })[sid];
    const counts = operatorChildUseCounts('parent', 'claude', [
      { sessionId: 'c1', adapterId: 'claude', state: 'busy' },
      { sessionId: 'c2', adapterId: 'codex', state: 'idle' },
      { sessionId: 'c3', adapterId: 'kimi', state: 'exited' },
      { sessionId: 'other', adapterId: 'grok', state: 'busy' },
    ], parentOf);
    expect(Object.fromEntries(counts)).toEqual({ claude: 2, codex: 1 });
  });

  it('sem sessão do pai não há contagem', () => {
    expect(operatorChildUseCounts(undefined, 'claude', [], () => undefined).size).toBe(0);
  });

  it('spawnRouteFrom normaliza origem e motivo', () => {
    expect(spawnRouteFrom(undefined)).toBeUndefined();
    expect(spawnRouteFrom({ classifierSource: 'jev' })).toEqual({ source: 'jev' });
    expect(spawnRouteFrom({ classifierSource: 'heuristic', jevUnavailable: 'no-key' })).toEqual({
      source: 'heuristic',
      jevUnavailable: 'no-key',
    });
    expect(spawnRouteFrom({ classifierSource: 'lol', jevUnavailable: 'lol' })).toEqual({
      source: 'heuristic',
    });
  });

  it('routeString só aceita string não vazia', () => {
    expect(routeString({ model: 'm' }, 'model')).toBe('m');
    expect(routeString({ model: '' }, 'model')).toBeUndefined();
    expect(routeString(undefined, 'model')).toBeUndefined();
  });

  it('parentPaneIdFor converte a sessão do pai em paneId, nunca vaza a sessão', () => {
    const lookup = (sid: string) => (sid === 'sess-parent' ? 'pane-7' : undefined);
    expect(parentPaneIdFor('sess-parent', lookup)).toBe('pane-7');
    expect(parentPaneIdFor('sess-gone', lookup)).toBeUndefined();
    expect(parentPaneIdFor(undefined, lookup)).toBeUndefined();
  });
});

describe('aviso de diversidade no spawn explícito (F-672)', () => {
  const pane = (paneId: string, adapterId: string, extra: Record<string, unknown> = {}) => ({
    paneId, sessionId: `s-${paneId}`, adapterId, state: 'busy' as const, missionId: 'm', role: 'worker', ...extra,
  });

  it('avisa quando a CLI fixada já tem dois helpers vivos na missão', () => {
    // Campo 28/09: o orquestrador fixou claude em todo spawn depois de uma
    // falha do Codex já corrigida; o Jev nunca mais roteou nada.
    const panes = [pane('p1', 'claude'), pane('p2', 'claude'), pane('novo', 'claude')];
    const hint = sameAdapterDiversityHint('claude', 'm', panes, 'novo');
    expect(hint?.sameAdapterLive).toBe(2);
    expect(hint?.hint).toContain('omita adapterId');
  });

  it('não conta orquestrador, pane encerrado, outra missão nem o pane novo', () => {
    const panes = [
      pane('orq', 'claude', { role: 'orchestrator' }),
      pane('morto', 'claude', { state: 'exited' }),
      pane('outra', 'claude', { missionId: 'x' }),
      pane('p1', 'claude'),
      pane('novo', 'claude'),
    ];
    expect(sameAdapterDiversityHint('claude', 'm', panes, 'novo')).toBeNull();
    expect(sameAdapterDiversityHint(undefined, 'm', panes)).toBeNull();
    expect(sameAdapterDiversityHint('claude', undefined, panes)).toBeNull();
  });
});
