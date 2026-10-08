import type { Adapter } from '../../shared/adapter-types';
import { migrateModelId } from '../../shared/model-defaults';
import { newestInModelLine } from '../../shared/model-line';
import { getCustomModels } from './custom-models';
import {
  isModelBlockedForAutoRouting,
  loadModelCatalog,
  modelCatalogInfo,
  type ModelCatalog,
} from './model-catalog';
import { discoveredModelStateFor } from './model-discovery';
import {
  modelListAuthority,
  resolveOfferedModels,
  type OfferedModels,
} from './model-availability';

/**
 * F-964 (PRV-01): a oferta de modelos de uma CLI no Main — o lado com estado
 * do resolvedor puro (model-availability.ts). O registro de adapters entrega
 * aqui a lista estática pura de cada adapter e os ids dos caches oficiais a
 * cada reload; quem lê (registro, Providers, spawn, rota) recebe a oferta
 * com a listagem viva ATUAL, sem esperar o próximo reload.
 */

let baseAdapters: ReadonlyMap<string, Adapter> = new Map();
let cliCacheModels: ReadonlyMap<string, readonly string[]> = new Map();

/** Chamado pelo registro no reload: estático puro + cache oficial lido. */
export function setModelOfferBase(
  base: ReadonlyMap<string, Adapter>,
  cache: ReadonlyMap<string, readonly string[]>,
): void {
  baseAdapters = base;
  cliCacheModels = cache;
}

/** Oferta a partir do adapter estático (`base`) e do estado da listagem. */
export function resolveAdapterModelOffer(
  base: Adapter,
  context: {
    catalog: ModelCatalog;
    cacheIds?: readonly string[];
    customIds?: readonly string[];
  },
): OfferedModels {
  const entry = context.catalog.adapters?.[base.id];
  const isBlocked = (model: string) =>
    isModelBlockedForAutoRouting(modelCatalogInfo(context.catalog, base.id, model));
  const offer = resolveOfferedModels({
    authority: modelListAuthority(base.id),
    staticIds: base.models.list,
    staticDefault: base.models.default || undefined,
    catalogIds: (entry?.models ?? []).map((model) => model.id).filter((id) => migrateModelId(id) === id),
    catalogDefault: entry?.default,
    customIds: context.customIds ?? [],
    cacheIds: context.cacheIds ?? [],
    live: discoveredModelStateFor(base.id),
    isBlocked,
  });
  // F-217: o default sobe para o mais novo da linha entre os que a CLI prova.
  if (!offer.defaultModel) return offer;
  const newest = newestInModelLine(offer.defaultModel, offer.routable.filter((model) => !isBlocked(model)));
  return newest === offer.defaultModel ? offer : { ...offer, defaultModel: newest };
}

/**
 * Oferta ATUAL de um adapter do registro. CLI sem listagem (`bundled`): a
 * lista composta no reload (estático ∪ cache ∪ catálogo) + custom. CLI que
 * lista: o resolvedor sobre a lista estática pura e a listagem viva de agora.
 */
export function currentModelOffer(adapter: Adapter): OfferedModels {
  const customIds = getCustomModels(adapter.id);
  if (modelListAuthority(adapter.id) === 'bundled') {
    return resolveOfferedModels({
      authority: 'bundled',
      staticIds: adapter.models.list,
      staticDefault: adapter.models.default,
      customIds,
      live: discoveredModelStateFor(adapter.id),
    });
  }
  return resolveAdapterModelOffer(baseAdapters.get(adapter.id) ?? adapter, {
    catalog: loadModelCatalog(),
    cacheIds: cliCacheModels.get(adapter.id) ?? [],
    customIds,
  });
}
