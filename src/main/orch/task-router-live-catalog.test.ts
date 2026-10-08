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
 * F-984 (07/10, missão harvest T3 Code): a 1ª linha do hard mandava o estudo
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

describe('F-984 — catálogo vivo da CLI manda no roteamento', () => {
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

  it('com a CLI anunciando o Argon, o assento da lane de julgamento volta a valer', () => {
    // F-990: a tabela do hard não carrega mais o Argon (o AGY 1.3.1 não o
    // lista); a lane de julgamento o usa quando a listagem viva o prova.
    const decision = routeTask('Revisão cruzada crítica do diff de autenticação',
      [agy({ liveModels: AGY_BUNDLED })], DEFAULT_ROUTING_TABLE, 'hard', false, undefined, ctx());
    expect(`${decision!.adapterId}:${decision!.model}`).toBe('agy:gemini-4-argon');
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

  it('CLI sem listagem (bundled, ex.: Claude) mantém o contrato do adapter', () => {
    const claude: AdapterAvailability = { id: 'claude', installed: true, models: ['claude-sonnet-5-5', 'claude-opus-5-5'] };
    expect(withLiveRouteCatalog({ ...claude, liveModels: ['claude-sonnet-5-5'] }).models).toEqual(claude.models);
    expect(withLiveRouteCatalog({ ...claude, liveModels: ['claude-sonnet-5-5'], liveModelsAuthoritative: true }).models)
      .toEqual(claude.models);
  });
});

describe('F-990 — prova viva em TODAS as lanes, para toda CLI que lista', () => {
  it('generaliza o F-984: Kimi com listagem só roteia o que ela anuncia', () => {
    const kimiLive = withLiveRouteCatalog({
      ...kimi,
      models: ['kimi-code/k3', 'kimi-code/kimi-for-coding'],
      liveModels: ['kimi-code/kimi-for-coding'],
    });
    expect(kimiLive.models).toEqual(['kimi-code/kimi-for-coding']);
  });

  it('listagem autoritativa vazia tira a CLI da rota (nunca "sem lista = confia")', () => {
    const empty = withLiveRouteCatalog(agy({ liveModels: [], liveModelsAuthoritative: true }));
    expect(empty.installed).toBe(false);
    expect(empty.unavailableReason).toMatch(/não anuncia/);
    const decision = routed([agy({ liveModels: [], liveModelsAuthoritative: true }), kimi]);
    expect([decision, ...decision.alternatives].every((c) => c.adapterId !== 'agy')).toBe(true);
  });

  it('id custom/catálogo sem prova não entra em nenhuma lane nem pela menção no texto', () => {
    const offered = agy({
      models: [...AGY_LIVE, 'gemini-4-argon', 'gemini-custom-x'],
      liveModels: AGY_LIVE,
      liveModelsAuthoritative: true,
    });
    for (const task of [TASK, 'Revisão cruzada crítica do diff', 'use o gemini-custom-x nesta tarefa']) {
      const decision = routeTask(task, [offered, kimi], DEFAULT_ROUTING_TABLE, 'hard', false, undefined, ctx());
      const all = decision ? [decision, ...decision.alternatives].map((c) => `${c.adapterId}:${c.model}`) : [];
      expect(all).not.toContain('agy:gemini-4-argon');
      expect(all).not.toContain('agy:gemini-custom-x');
    }
  });
});
