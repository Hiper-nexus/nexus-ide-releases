import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_ROUTING_TABLE, FRONTIER_ORDER, routeTask } from './task-router';
import { BUILTIN_ADAPTERS } from '../../adapters/builtin';
import { adapterSchema } from '../../shared/adapter-types';
import {
  CODEX_FRONTIER_MODEL,
  GROK_FRONTIER_MODEL,
  RETIRED_MODEL_MIGRATIONS,
} from '../../shared/model-defaults';
import { SQUAD_MODEL_DEFAULTS } from '../../shared/squad-model-defaults';
import {
  BUILTIN_MODEL_CATALOG,
  PUBLISHED_MODEL_CATALOG,
  isModelBlockedForAutoRouting,
  mergeModelCatalogs,
  modelCatalogInfo,
} from '../adapters/model-catalog';

/**
 * Trava anti-tabela-velha (estudo docs/models/estudo-2026-09.md): a tabela
 * de roteamento e os defaults nunca podem apontar para um id aposentado
 * (o spawn trocaria em silêncio — o roteador "pensava" gemini-3.1-pro e
 * abria 3.8 Flash), ausente do catálogo do adapter, ou deprecated.
 */
const adapters = new Map(
  BUILTIN_ADAPTERS.map((raw) => {
    const adapter = adapterSchema.parse(raw);
    return [adapter.id, adapter] as const;
  }),
);
const catalog = mergeModelCatalogs(BUILTIN_MODEL_CATALOG, PUBLISHED_MODEL_CATALOG);
const retired = (model: string | undefined) =>
  model !== undefined && Object.hasOwn(RETIRED_MODEL_MIGRATIONS, model);

describe('contrato: tabela de roteamento × catálogos', () => {
  it('offers Sonnet 5.5 in the balanced route and preserves Sonnet 5 fallback', () => {
    const installed = [{ id: 'claude', installed: true, authReady: true,
      models: ['claude-sonnet-5-5', 'claude-sonnet-5'], efforts: ['low', 'medium', 'high', 'xhigh'] }];
    const route = routeTask('implementar componente', installed, DEFAULT_ROUTING_TABLE, 'medium', false, catalog);
    expect([route?.model, ...(route?.alternatives.map((c) => c.model) ?? [])]).toContain('claude-sonnet-5-5');
    const explicit = routeTask('Use Sonnet 5.5 para implementar componente', installed,
      DEFAULT_ROUTING_TABLE, 'medium', false, catalog, { effortOverride: 'high' });
    expect(explicit).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'high' });
    const legacy = routeTask('implementar componente', [{ ...installed[0], models: ['claude-sonnet-5'] }],
      DEFAULT_ROUTING_TABLE, 'medium', false, catalog);
    expect(legacy?.model).toBe('claude-sonnet-5');
  });
  const rows = Object.entries(DEFAULT_ROUTING_TABLE).flatMap(([tier, list]) =>
    list.map((c) => ({ tier, ...c })),
  );

  it.each(rows)('$tier $adapterId:$model é id vivo do catálogo do adapter', (row) => {
    const adapter = adapters.get(row.adapterId);
    expect(adapter, `adapter ${row.adapterId} não é builtin`).toBeDefined();
    expect(row.model, 'candidato sem modelo explícito').toBeTruthy();
    expect(retired(row.model), `${row.model} está em RETIRED_MODEL_MIGRATIONS`).toBe(false);
    expect(adapter!.models.list, `${row.adapterId} não lista ${row.model}`).toContain(row.model);
    // api-only NÃO reprova: é política do catálogo (overlay do usuário pode
    // liberar) e o roteador já o pula com "evitou" no reason.
    expect(
      modelCatalogInfo(catalog, row.adapterId, row.model)?.availability,
      `${row.adapterId}:${row.model} está deprecated no catálogo`,
    ).not.toBe('deprecated');
  });

  it('defaults de adapter e de catálogo não apontam para id aposentado ou fora da lista', () => {
    for (const adapter of adapters.values()) {
      const fallback = adapter.models.default;
      if (fallback) {
        expect.soft(retired(fallback), `${adapter.id} default ${fallback}`).toBe(false);
        expect.soft(adapter.models.list, `${adapter.id} default fora da lista`).toContain(fallback);
      }
    }
    for (const source of [BUILTIN_MODEL_CATALOG, PUBLISHED_MODEL_CATALOG]) {
      for (const [adapterId, entry] of Object.entries(source.adapters ?? {})) {
        // A LISTA pode manter um id aposentado que a CLI ainda expõe (o
        // spawn migra); o DEFAULT não — ele é a escolha sem operador.
        expect.soft(retired(entry.default), `catálogo ${adapterId} default ${entry.default}`).toBe(false);
      }
    }
  });

  it('modelos de topo da política estão em hard e critical e não são bloqueados', () => {
    // Recibo velho: "evitou claude:claude-fable-5 (api-only)" — o topo da
    // tabela era um id que o roteador nunca podia escolher.
    const models = new Set(Object.values(FRONTIER_ORDER).flat());
    for (const tier of ['hard', 'critical'] as const) {
      for (const model of models) {
        const row = DEFAULT_ROUTING_TABLE[tier].find((c) => c.model === model);
        expect(row, `${tier} sem ${model}`).toBeDefined();
        expect(
          isModelBlockedForAutoRouting(modelCatalogInfo(catalog, row!.adapterId, model)),
          `${row!.adapterId}:${model} bloqueado para rota automática`,
        ).toBe(false);
      }
    }
  });

  it('defaults de produto (fronteira, squads) são ids vivos', () => {
    for (const model of [CODEX_FRONTIER_MODEL, GROK_FRONTIER_MODEL, ...Object.values(SQUAD_MODEL_DEFAULTS)]) {
      expect(retired(model), model).toBe(false);
    }
  });
});

describe('aviso em runtime: CLI instalada sem o modelo roteado', () => {
  it('diz no reason e loga uma vez quando a lista da CLI não tem o modelo da tabela', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const table = {
        trivial: [], easy: [], hard: [], critical: [],
        medium: [
          { adapterId: 'agy', model: 'gemini-9.9-flash-high' },
          { adapterId: 'grok', model: GROK_FRONTIER_MODEL },
        ],
      };
      const installed = [
        { id: 'agy', installed: true, models: ['gemini-3.8-flash-high'] },
        { id: 'grok', installed: true, models: [GROK_FRONTIER_MODEL] },
      ];
      const first = routeTask('tarefa', installed, table, 'medium', false, { adapters: {} });
      routeTask('tarefa', installed, table, 'medium', false, { adapters: {} });
      expect(first?.adapterId).toBe('grok');
      expect(first?.reason).toContain('CLI sem o modelo roteado: agy:gemini-9.9-flash-high');
      const logged = warn.mock.calls.filter(([line]) =>
        String(line).includes('agy:gemini-9.9-flash-high'));
      expect(logged).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });
});
