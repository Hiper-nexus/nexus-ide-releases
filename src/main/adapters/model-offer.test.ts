import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { adapterSchema, type Adapter } from '../../shared/adapter-types';
import { BUILTIN_ADAPTERS } from '../../adapters/builtin';
import {
  DEFAULT_ROUTING_TABLE,
  routeTask,
  type AdapterAvailability,
} from '../orch/task-router';
import { resetModelAccessQuarantineForTests } from '../orch/model-access-quarantine';
import { BUILTIN_MODEL_CATALOG, PUBLISHED_MODEL_CATALOG, mergeModelCatalogs } from './model-catalog';
import {
  parseAgyModelsOutput,
  recordDiscoveredModelListing,
  resetModelDiscoveryForTests,
} from './model-discovery';
import { currentModelOffer, resolveAdapterModelOffer, setModelOfferBase } from './model-offer';

// Determinístico: nunca o ~/.nexus/custom-models.json da máquina.
vi.mock('./custom-models', () => ({
  getCustomModels: () => [],
  addCustomModel: vi.fn(),
  removeCustomModel: vi.fn(),
}));

/** Saída real de `agy models` do AGY 1.3.1 (07/10/2026; stderr à parte). */
const AGY_1_3_1 = fs.readFileSync(
  path.join(__dirname, '__fixtures__', 'agy-models-1.3.1.stdout.txt'),
  'utf8',
);
/** Os três ids que o Nexus oferecia e o AGY 1.3.1 não lista (F-990). */
const GHOSTS = ['gemini-4-argon', 'claude-opus-4-6-thinking', 'claude-sonnet-4-6'];
const CATALOG = mergeModelCatalogs(BUILTIN_MODEL_CATALOG, PUBLISHED_MODEL_CATALOG);

function builtin(id: string): Adapter {
  const raw = BUILTIN_ADAPTERS.find((adapter) => (adapter as { id?: string }).id === id);
  return adapterSchema.parse(raw);
}

/** O agy como o Nexus o oferecia até o F-990 (lista estática com os fantasmas). */
function legacyAgy(): Adapter {
  const agy = builtin('agy');
  return { ...agy, models: { ...agy.models, list: [...GHOSTS, ...agy.models.list] } };
}

afterEach(() => {
  resetModelDiscoveryForTests();
  resetModelAccessQuarantineForTests();
  setModelOfferBase(new Map(), new Map());
});

describe('F-990 — fixture do agy 1.3.1', () => {
  it('a listagem viva é a oferta; Argon e os Claude 4-6 viram unverified', () => {
    const listed = parseAgyModelsOutput(AGY_1_3_1);
    expect(listed).toHaveLength(18);
    expect(listed).not.toContain('gemini-4-argon');
    recordDiscoveredModelListing('agy', listed);

    const offer = resolveAdapterModelOffer(legacyAgy(), { catalog: CATALOG });
    expect(offer.source).toBe('live');
    expect(offer.offered).toEqual(listed);
    for (const ghost of GHOSTS) {
      expect(offer.offered).not.toContain(ghost);
      expect(offer.routable).not.toContain(ghost);
      expect(offer.unverified).toContain(ghost);
    }
    expect(offer.defaultModel).toBe('gemini-3.8-flash-high');
  });

  it('o agy 1.3.1 nunca é roteado para o Argon — tabela do hard, lane de julgamento nem menção', () => {
    recordDiscoveredModelListing('agy', parseAgyModelsOutput(AGY_1_3_1));
    const offer = resolveAdapterModelOffer(legacyAgy(), { catalog: CATALOG });
    // Seletor velho (com o Argon) + a listagem autoritativa, como o tools-domain monta.
    const agy: AdapterAvailability = {
      id: 'agy',
      installed: true,
      models: ['gemini-4-argon', ...offer.offered],
      liveModels: offer.routable,
      liveModelsAuthoritative: true,
    };
    const kimi: AdapterAvailability = { id: 'kimi', installed: true, models: ['kimi-code/k3'] };
    for (const task of [
      'Análise profunda somente leitura: motor de orquestração v2 cruzado com o Nexus',
      'Revisão cruzada crítica do diff de autenticação antes do merge',
      'Use o gemini-4-argon para revisar a arquitetura do roteador',
    ]) {
      const decision = routeTask(task, [agy, kimi], DEFAULT_ROUTING_TABLE, 'hard', false, undefined, { multiScore: false });
      const all = decision ? [decision, ...decision.alternatives] : [];
      expect(all.map((c) => `${c.adapterId}:${c.model}`)).not.toContain('agy:gemini-4-argon');
    }
  });

  it('codex: id do models_cache.json que o model/list não lista não vira modelo de chat', () => {
    recordDiscoveredModelListing('codex', ['gpt-6.1-sol', 'gpt-6-luna'], { defaultModel: 'gpt-6-luna' });
    const offer = resolveAdapterModelOffer(builtin('codex'), {
      catalog: CATALOG,
      cacheIds: ['gpt-6.1-sol', 'codex-auto-review'],
    });
    expect(offer.offered).toEqual(['gpt-6.1-sol', 'gpt-6-luna']);
    expect(offer.offered).not.toContain('codex-auto-review');
    // O catálogo prefere o Sol 6.1 quando a conta o lista (applyManifestDefault).
    expect(offer.defaultModel).toBe('gpt-6.1-sol');
  });

  it('F-217 continua: modelo mais novo da linha que a CLI lista vira o default', () => {
    recordDiscoveredModelListing('codex', ['gpt-6.1-sol', 'gpt-6.2-sol', 'gpt-6-luna']);
    const offer = resolveAdapterModelOffer(builtin('codex'), { catalog: CATALOG });
    expect(offer.defaultModel).toBe('gpt-6.2-sol');
    expect(offer.offered).toEqual(['gpt-6.1-sol', 'gpt-6.2-sol', 'gpt-6-luna']);
  });

  it('leitura atual usa a lista estática pura do reload, não a composta', () => {
    const composed = builtin('agy');
    setModelOfferBase(new Map([['agy', legacyAgy()]]), new Map());
    recordDiscoveredModelListing('agy', ['gemini-3.8-flash-high']);
    const offer = currentModelOffer(composed);
    expect(offer.offered).toEqual(['gemini-3.8-flash-high']);
    expect(offer.unverified).toEqual(expect.arrayContaining(GHOSTS));
  });

  it('CLI sem listagem (Claude) segue com a lista composta do adapter', () => {
    const claude = builtin('claude');
    const offer = currentModelOffer(claude);
    expect(offer.authority).toBe('bundled');
    expect(offer.offered).toEqual(claude.models.list);
    expect(offer.defaultModel).toBe(claude.models.default);
  });
});
