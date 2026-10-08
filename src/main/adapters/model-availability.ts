// Inspired by pingdotgg/t3code @ 26285ab80513260d1ff29d2c3fbe18f21990cb62 (no code copied)
// Referência (T3 Code, MIT): a regra "a listagem da CLI é a verdade; o manifesto só classifica e escolhe o default, nunca acrescenta id" (apps/server/src/provider/ModelManifest.ts:214-330, applyManifestDefault/classifyModels; AntigravityProvider.ts:45-79, 308-316; docs/internals/providers.md "an authoritative empty catalog must clear the old list").
// Implementação do Nexus: função pura em TS, com as três autoridades do Nexus (live | version-cache | bundled), a última listagem boa no lugar do snapshot do provider, ids custom do operador e o guarda de parse quebrado do F-984.

/**
 * F-990 (PRV-01): quais modelos o Nexus OFERECE e quais ROTEIA por CLI.
 *
 * Antes, o seletor e o roteador uniam lista estática do adapter, catálogo e
 * listagem viva. O `gemini-4-argon` (bundled + catálogo) continuou oferecido
 * ao AGY 1.3.1, que não o lista, e o pane morreu com "not recognized".
 *
 * Regras (sem I/O; quem chama traz o estado):
 *  - autoridade `bundled` (CLI sem listagem: Claude, wrappers): nada muda — o
 *    catálogo é o manifesto e acrescenta ids, como o T3 faz com o Claude;
 *  - autoridade `live`/`version-cache` (CLI que sabe listar):
 *      listagem `ok`         → oferta = listagem ∪ custom (vazia limpa: só custom);
 *      falhou com última boa → oferta = última boa ∪ custom;
 *      sem nenhuma listagem  → cache oficial da CLI, senão a lista estática
 *                              (contrato bundled até a CLI responder);
 *    id do estático ou do catálogo fora da listagem vira `unverified` (nunca
 *    oferecido nem roteado); id só do catálogo também.
 *  - listagem não vazia sem NENHUM id da linha de um id conhecido é parse
 *    quebrado (F-984), não catálogo: cai para a próxima fonte em vez de
 *    oferecer rótulos.
 *  - default: o do catálogo se estiver na oferta, senão o do adapter, senão o
 *    que a CLI marcou, senão o mais novo da linha do default; sem nenhum, ''
 *    (a CLI abre no próprio default — nunca um id que ela não lista).
 */

import { modelLineOf, newestInModelLine } from '../../shared/model-line';

export type ModelListAuthority = 'live' | 'version-cache' | 'bundled';
/** De onde veio a oferta efetiva. */
export type ModelListSource = 'live' | 'last-good' | 'cache' | 'bundled';
/** Prova por id oferecido. `custom` = o operador acrescentou à mão. */
export type ModelProof = ModelListSource | 'custom';

/**
 * CLIs cuja listagem (comando vivo ou app-server) é a fonte de verdade dos ids
 * aceitos. Espelha `MODEL_DISCOVERY_INVENTORY` (kind `cli`) — o teste do
 * model-discovery amarra os dois.
 */
const LIVE_LISTING_ADAPTERS: ReadonlySet<string> = new Set([
  'agy',
  'codex',
  'cursor-agent',
  'kimi',
  'mimo-code',
  'omp',
  'opencode',
  'prime-agent',
  'qoder',
]);

/** CLIs cujo cache oficial (amarrado à versão instalada) é a listagem. */
const VERSION_CACHE_ADAPTERS: ReadonlySet<string> = new Set(['grok']);

export function modelListAuthority(adapterId: string): ModelListAuthority {
  if (LIVE_LISTING_ADAPTERS.has(adapterId)) return 'live';
  if (VERSION_CACHE_ADAPTERS.has(adapterId)) return 'version-cache';
  return 'bundled';
}

export interface LiveModelListing {
  /** ok = respondeu agora; failed = falhou (timeout, deslogada); absent = nunca perguntou. */
  readonly status: 'ok' | 'failed' | 'absent';
  readonly models: readonly string[];
  /** Última listagem `ok` (inclusive vazia). Ausente = nunca houve sucesso. */
  readonly lastGood?: readonly string[];
  /** Default que a própria CLI marcou (Codex `isDefault`). */
  readonly defaultModel?: string;
}

export interface OfferedModelsInput {
  readonly authority: ModelListAuthority;
  /** Lista do JSON do adapter (builtin ou plugin do operador). */
  readonly staticIds: readonly string[];
  readonly staticDefault?: string;
  /** Ids do catálogo em camadas (já sem ids migrados). Só classificam. */
  readonly catalogIds?: readonly string[];
  readonly catalogDefault?: string;
  readonly customIds?: readonly string[];
  /** Ids do cache oficial da CLI, já filtrados pela versão instalada. */
  readonly cacheIds?: readonly string[];
  readonly live?: LiveModelListing;
  /** api-only/deprecated nunca viram default. */
  readonly isBlocked?: (model: string) => boolean;
}

export interface OfferedModels {
  readonly authority: ModelListAuthority;
  readonly source: ModelListSource;
  /** O que o seletor e o pane podem usar (inclui custom). */
  readonly offered: readonly string[];
  /** O que a rota automática pode escolher: só ids com prova (sem custom). */
  readonly routable: readonly string[];
  /** Ids conhecidos (estático/catálogo) que a CLI não anuncia. */
  readonly unverified: readonly string[];
  readonly proof: Readonly<Record<string, ModelProof>>;
  readonly defaultModel: string;
}

function unique(...lists: ReadonlyArray<readonly string[]>): string[] {
  const out: string[] = [];
  for (const list of lists) {
    for (const raw of list) {
      const id = typeof raw === 'string' ? raw.trim() : '';
      if (id && !out.includes(id)) out.push(id);
    }
  }
  return out;
}

/**
 * Vazia é autoritativa; não vazia precisa ter ao menos um id da mesma LINHA
 * de um id conhecido (geração nova — `x-2.0` depois de `x-1.0` — vale;
 * rótulos como `Gemini`/`Claude` não).
 */
function isRecognizedListing(listing: readonly string[], known: ReadonlySet<string>): boolean {
  if (listing.length === 0 || known.size === 0) return true;
  const stems = new Set([...known].map((id) => modelLineOf(id).stem));
  return listing.some((id) => known.has(id) || stems.has(modelLineOf(id).stem));
}

function pickDefault(
  offered: readonly string[],
  candidates: ReadonlyArray<string | undefined>,
  isBlocked: (model: string) => boolean,
  lineAnchor: string | undefined,
): string {
  const usable = (model: string | undefined): model is string =>
    typeof model === 'string' && model.length > 0 && offered.includes(model) && !isBlocked(model);
  for (const candidate of candidates) if (usable(candidate)) return candidate;
  if (lineAnchor) {
    const newer = newestInModelLine(lineAnchor, offered.filter((model) => !isBlocked(model)));
    if (usable(newer)) return newer;
  }
  return '';
}

export function resolveOfferedModels(input: OfferedModelsInput): OfferedModels {
  const isBlocked = input.isBlocked ?? (() => false);
  const statics = unique(input.staticIds);
  const catalog = unique(input.catalogIds ?? []);
  const custom = unique(input.customIds ?? []);
  const cache = unique(input.cacheIds ?? []);
  const live = input.live ?? { status: 'absent', models: [] };
  const proof: Record<string, ModelProof> = {};

  if (input.authority === 'bundled') {
    const base = unique(statics, cache, catalog);
    const extraLive = unique(live.status === 'ok' ? live.models : live.lastGood ?? live.models);
    const offered = unique(base, custom, extraLive);
    for (const id of offered) {
      proof[id] = cache.includes(id) || extraLive.includes(id) ? 'cache' : base.includes(id) ? 'bundled' : 'custom';
    }
    const requested = input.catalogDefault ?? input.staticDefault;
    const defaultModel = requested && isBlocked(requested)
      ? offered.find((model) => !isBlocked(model)) ?? requested
      : requested ?? '';
    return { authority: 'bundled', source: 'bundled', offered, routable: offered, unverified: [], proof, defaultModel };
  }

  const known = new Set([...statics, ...catalog]);
  let listing: string[] | null = null;
  let source: ModelListSource = 'bundled';
  if (live.status === 'ok' && isRecognizedListing(live.models, known)) {
    listing = unique(live.models);
    source = 'live';
  } else if (live.lastGood && isRecognizedListing(live.lastGood, known)) {
    listing = unique(live.lastGood);
    source = 'last-good';
  } else if (cache.length > 0 && isRecognizedListing(cache, known)) {
    listing = cache;
    source = 'cache';
  }

  if (listing) {
    const offered = unique(listing, custom);
    for (const id of offered) proof[id] = listing.includes(id) ? source : 'custom';
    const unverified = unique(statics, catalog).filter((id) => !offered.includes(id));
    const cliDefault = source === 'live' || source === 'last-good' ? live.defaultModel : undefined;
    return {
      authority: input.authority,
      source,
      offered,
      routable: listing,
      unverified,
      proof,
      defaultModel: pickDefault(
        offered,
        [input.catalogDefault, input.staticDefault, cliDefault],
        isBlocked,
        input.staticDefault ?? input.catalogDefault,
      ),
    };
  }

  // Nenhuma listagem ainda (boot, CLI deslogada desde sempre): o contrato
  // bundled do adapter vale até a CLI responder; o catálogo não acrescenta.
  const offered = unique(statics, custom);
  for (const id of offered) proof[id] = statics.includes(id) ? 'bundled' : 'custom';
  return {
    authority: input.authority,
    source: 'bundled',
    offered,
    routable: statics,
    unverified: catalog.filter((id) => !offered.includes(id)),
    proof,
    defaultModel: pickDefault(
      offered,
      [input.catalogDefault, input.staticDefault],
      isBlocked,
      input.staticDefault ?? input.catalogDefault,
    ),
  };
}
