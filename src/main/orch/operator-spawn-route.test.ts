import { describe, expect, it } from 'vitest';
import type { PaneRuntimeState } from '../../shared/orch-types';
import {
  ignoredRouteChoice,
  limitToReadOnlyCapable,
  liveMissionAdapterSeats,
  operatorChildUseCounts,
  operatorRouteTask,
  parentPaneIdFor,
  routeJevReceipt,
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

  it('spawnRouteFrom leva confiança e ruleChoice saneados quando o Jev influenciou', () => {
    expect(
      spawnRouteFrom({
        classifierSource: 'jev',
        confidence: { tier: 0.8349, specialty: 0.71, task: 'texto da tarefa' },
        ruleChoice: { adapterId: 'claude', model: 'sonnet', reason: 'sinais: texto da tarefa', accountId: 'a1' },
      }),
    ).toEqual({
      source: 'jev',
      confidence: { tier: 0.83, specialty: 0.71 },
      ruleChoice: { adapterId: 'claude', model: 'sonnet' },
    });
    expect(spawnRouteFrom({ classifierSource: 'mixed', ruleChoice: 'same' })).toEqual({
      source: 'mixed',
      ruleChoice: 'same',
    });
  });

  it('spawnRouteFrom ignora confiança/ruleChoice sem influência do Jev e valores inválidos', () => {
    expect(
      spawnRouteFrom({ classifierSource: 'heuristic', confidence: { tier: 0.9 }, ruleChoice: 'same' }),
    ).toEqual({ source: 'heuristic' });
    expect(
      spawnRouteFrom({ classifierSource: 'jev', confidence: { tier: 7 }, ruleChoice: { model: 'sem-cli' } }),
    ).toEqual({ source: 'jev' });
  });

  it('routeJevReceipt devolve só o que pode ir ao recibo, ou nada', () => {
    expect(routeJevReceipt(undefined)).toEqual({});
    expect(routeJevReceipt({ classifierSource: 'heuristic', ruleChoice: 'same' })).toEqual({});
    expect(routeJevReceipt({ classifierSource: 'jev', ruleChoice: 'same', confidence: { effort: 0.66 } })).toEqual({
      ruleChoice: 'same',
      confidence: { effort: 0.66 },
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

describe('somente leitura fora do Autopilot só roteia para CLI que confina (F-802)', () => {
  const pool = [
    { id: 'kimi', installed: true, capabilities: { readOnlyEnforceable: false } },
    { id: 'codex', installed: true, capabilities: { readOnlyEnforceable: true } },
    { id: 'grok', installed: false, capabilities: { readOnlyEnforceable: true } },
    { id: 'mimo-code', installed: true },
  ];

  it('tira do pool as instaladas que não confinam e anota o motivo', () => {
    const limited = limitToReadOnlyCapable(pool, true);
    expect(limited.adapters.filter((a) => a.installed).map((a) => a.id)).toEqual(['codex']);
    expect(limited.note).toContain('somente leitura');
    // F-985: o recibo do preferAdapters não diz "não instalado" para elas.
    expect(limited.adapters.find((a) => a.id === 'kimi')).toMatchObject({
      unavailableReason: 'não confina leitura (helper somente leitura)',
    });
  });

  it('sem exigência, o pool fica como está', () => {
    expect(limitToReadOnlyCapable(pool, false)).toEqual({ adapters: pool, note: '' });
  });

  it('se NENHUMA instalada confina, o pool não é tocado (o spawn mostra o erro real)', () => {
    const none = pool.map((a) => ({ ...a, capabilities: { readOnlyEnforceable: false } }));
    expect(limitToReadOnlyCapable(none, true)).toEqual({ adapters: none, note: '' });
  });
});

describe('assentos vivos da missão por CLI (F-985)', () => {
  const pane = (
    paneId: string,
    adapterId: string,
    state: PaneRuntimeState = 'busy',
    missionId = 'm1',
  ) => ({ paneId, sessionId: `s-${paneId}`, adapterId, state, missionId });

  it('conta só a linha durável cujo pane segue vivo, mais os vivos sem linha', () => {
    const recorded = [
      { paneId: 'orch', adapterId: 'claude' },
      { paneId: 'w-fechado', adapterId: 'claude' },
      { paneId: 'w-exited', adapterId: 'claude' },
      { paneId: 'w-codex', adapterId: 'codex' },
    ];
    const panes = [
      pane('orch', 'claude'),
      pane('w-exited', 'claude', 'exited'),
      pane('w-codex', 'codex'),
      pane('helper-sem-linha', 'claude', 'idle'),
      pane('outra-missao', 'claude', 'busy', 'm2'),
    ];
    expect(liveMissionAdapterSeats('claude', 'm1', recorded, panes)).toBe(2);
    expect(liveMissionAdapterSeats('codex', 'm1', recorded, panes)).toBe(1);
  });

  it('linha sem paneId conta (sem prova de que o pane fechou)', () => {
    expect(liveMissionAdapterSeats('claude', 'm1', [{ paneId: null, adapterId: 'claude' }], [])).toBe(1);
  });
});
