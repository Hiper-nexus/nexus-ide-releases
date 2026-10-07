import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_ROUTING_TABLE,
  routeTask,
  withLiveRouteCatalog,
  type AdapterAvailability,
} from './task-router';
import {
  quarantineRejectedModel,
  resetModelAccessQuarantineForTests,
} from './model-access-quarantine';

/**
 * F-958 (07/10, missão harvest T3 Code): a 1ª linha do hard mandava o estudo
 * somente leitura para `agy:gemini-4-argon`; o AGY 1.3.0 instalado respondeu
 * "model gemini-4-argon is not recognized as a known model" e o pane morreu
 * em 3,8 s. O Argon seguiu nas alternativas das rotas seguintes.
 */
const TASK =
  'Análise profunda somente leitura: motor de orquestração v2 do T3 Code (event log, ' +
  'effect worker, checkpoints, settlement) cruzado com o Nexus';
const AGY_BUNDLED = [
  'gemini-4-argon',
  'gemini-3.8-flash-high',
  'gemini-3.8-flash-medium',
  'gemini-3.8-flash-low',
];
/** O que o `agy models` do 1.3.0 anuncia (sem o Argon). */
const AGY_LIVE = ['gemini-3.8-flash-high', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-low'];

function agy(overrides: Partial<AdapterAvailability> = {}): AdapterAvailability {
  return { id: 'agy', installed: true, models: [...AGY_BUNDLED], ...overrides };
}
const kimi: AdapterAvailability = { id: 'kimi', installed: true, models: ['kimi-code/k3'] };
const ctx = () => ({ multiScore: false });

afterEach(() => resetModelAccessQuarantineForTests());

function routed(adapters: AdapterAvailability[]) {
  const decision = routeTask(TASK, adapters, DEFAULT_ROUTING_TABLE, 'hard', false, undefined, ctx());
  expect(decision).not.toBeNull();
  return decision!;
}

describe('F-958 — catálogo vivo da CLI manda no roteamento', () => {
  it('AGY cuja listagem viva não traz o Argon nunca recebe o Argon (nem nas alternativas)', () => {
    const decision = routed([agy({ liveModels: AGY_LIVE }), kimi]);
    expect(`${decision.adapterId}:${decision.model}`).not.toBe('agy:gemini-4-argon');
    expect(decision.alternatives.map((c) => `${c.adapterId}:${c.model}`)).not.toContain(
      'agy:gemini-4-argon',
    );
  });

  it('sem listagem viva, o assento de acesso restrito (Argon) exige prova também na tabela do tier', () => {
    const decision = routed([agy(), kimi]);
    expect(decision.model).not.toBe('gemini-4-argon');
    expect(decision.alternatives.some((c) => c.model === 'gemini-4-argon')).toBe(false);
  });

  it('com a CLI anunciando o Argon, a 1ª linha do hard volta a valer', () => {
    const decision = routed([agy({ liveModels: AGY_BUNDLED })]);
    expect(`${decision.adapterId}:${decision.model}`).toBe('agy:gemini-4-argon');
  });

  it('listagem viva sem nenhum id conhecido é parse quebrado: vale o bundled (menos o Argon)', () => {
    const normalized = withLiveRouteCatalog(agy({ liveModels: ['Gemini', 'Claude'] }));
    expect(normalized.models).toEqual(AGY_BUNDLED.filter((model) => model !== 'gemini-4-argon'));
  });

  it('modelo recusado no nascimento sai do ranking e das alternativas daquela CLI', () => {
    quarantineRejectedModel('agy', 'gemini-3.8-flash-high', 'a CLI instalada não reconhece o modelo');
    const decision = routed([agy({ liveModels: AGY_LIVE }), kimi]);
    const all = [decision, ...decision.alternatives].map((c) => `${c.adapterId}:${c.model}`);
    expect(all).not.toContain('agy:gemini-3.8-flash-high');
  });

  it('adapter fora da lista autoritativa mantém a união bundled ∪ descoberta', () => {
    const kimiLive = withLiveRouteCatalog({ ...kimi, liveModels: ['kimi-code/kimi-for-coding'] });
    expect(kimiLive.models).toEqual(['kimi-code/k3']);
  });
});
