/**
 * Task router — the orchestrator's cost + specialty brain. Classifies a
 * task into a complexity tier AND a work specialty (visual, security, bug,
 * …), then picks adapter + model + effort. Easy work never burns
 * Opus/Fable-class tokens; UI work does not inherit the cheapest coding
 * lead; a three-worker fan-out does not all land on GLM.
 *
 * Ranking layers (highest wins when present):
 *   1. operator/sealed roster (call site)
 *   2. specialty benchmark table (measured rows only — fixture/estimate ignored)
 *   3. nexus-eval quality by dimension (when every installed adapter is scored;
 *      `.../fixture` sources are not authoritative)
 *   4. heuristic specialty prior + operational band (cost/availability) +
 *      DEFAULT_ROUTING_TABLE
 *   5. mission diversity (open RouteReservations + live panes)
 *
 * Pure logic (no electron imports) — fully unit-testable; the MCP tool
 * nexus_route_task feeds it the live adapter list and the merged benchmark.
 */
import {
  hasAuthoritativeModelQuality,
  isModelBlockedForAutoRouting,
  loadModelCatalog,
  modelCatalogInfo,
  modelRoutingRank,
  type ModelCatalog,
} from '../adapters/model-catalog';
import {
  applyEffortFloor,
  classifyRouteSpecialty,
  preferAdapterOrder,
  resolveSpecialtyPolicy,
  type RoutePolicySource,
  type RouteSpecialty,
  type SpecialtyBenchmark,
} from '../../shared/mission-route-specialty';
import {
  bandForSpecialty,
  classifyOperationalBand,
  preferOperationalBand,
} from '../../shared/model-operational-bands';
import { CODEX_FRONTIER_MODEL } from '../../shared/model-defaults';
import { adapterCircuitBreakers } from './circuit-breaker';
import { multiScoreRerank } from './route-pipeline';

export type TaskTier = 'trivial' | 'easy' | 'medium' | 'hard' | 'critical';

export interface RouteCandidate {
  adapterId: string;
  model?: string;
  effort?: string;
}

export type RoutingTable = Record<TaskTier, RouteCandidate[]>;

/**
 * Optional routing context for mission diversity and operator preferences.
 * Pure — call sites inject orch settings and mission pane history.
 */
export interface RouteContext {
  /** Adapters already used by panes in this mission (diversity boost). */
  missionUsedAdapters?: ReadonlySet<string>;
  /** How many times each adapter appears in the mission (diversity attenuation). */
  missionUseCounts?: ReadonlyMap<string, number>;
  /** Soft prefer list applied after table rank. */
  preferAdapters?: readonly string[];
  /**
   * When true (default if mission has history or any circuit open), re-rank
   * with multi-score (x-algorithm pattern). False preserves pure table order.
   */
  multiScore?: boolean;
  /**
   * Injected specialty table. `undefined` uses the empty published benchmark
   * (heuristic). Callers that merged a user overlay pass that object here so
   * unit tests never read `~/.nexus`.
   */
  specialtyBenchmark?: SpecialtyBenchmark | null;
}

export type RankedRouteEntry = {
  c: RouteCandidate;
  fromTier: TaskTier;
  evaluated?: boolean;
};

/**
 * Default ladder, cheapest-first inside each tier — and deliberately spread
 * across every installed LLM so work isn't dumped on one provider: the LEAD
 * model per tier rotates (grok → kimi → glm → claude) for real diversity.
 * Model ids match the builtin adapter catalogs; a missing/uninstalled adapter
 * (or GLM without its z.ai key) falls through to the next candidate.
 *
 * GLM (z.ai, model 5.3) is a first-class `glm` adapter now — strong AND cheap,
 * so it LEADS the medium tier and is an early option on hard. It runs on the
 * Claude binary pointed at the z.ai endpoint (see glm.json). GLM Flash is the
 * same route with every model slot pinned to glm-5.3-flash (the launcher's
 * `ai gf`): the cheap/fast lane for trivial+easy work. LongCat (Meituan,
 * 1M ctx, agentic) follows the same pattern (longcat.json) and sits right
 * behind GLM on medium/hard — comparable price, extra diversity.
 *
 */
export const DEFAULT_ROUTING_TABLE: RoutingTable = {
  trivial: [
    { adapterId: 'grok', model: 'grok-code-fast-1', effort: 'low' },
    { adapterId: 'agy', model: 'gemini-3.7-flash-low', effort: 'low' },
    { adapterId: 'kimi', model: 'kimi-code/k3', effort: 'low' },
    { adapterId: 'glm-flash', model: 'glm-5.3-flash[1m]', effort: 'low' },
    { adapterId: 'claude', model: 'claude-haiku-4-5', effort: 'low' },
  ],
  easy: [
    { adapterId: 'kimi', model: 'kimi-code/k3', effort: 'low' },
    { adapterId: 'grok', model: 'grok-4-fast', effort: 'low' },
    { adapterId: 'agy', model: 'gemini-3.7-flash-low', effort: 'low' },
    { adapterId: 'codex', model: 'gpt-5.4-mini', effort: 'low' },
    { adapterId: 'glm-flash', model: 'glm-5.3-flash[1m]', effort: 'low' },
    { adapterId: 'claude', model: 'claude-sonnet-4-6', effort: 'low' },
  ],
  medium: [
    { adapterId: 'glm', model: 'glm-5.3', effort: 'medium' },
    { adapterId: 'longcat', model: 'LongCat-2.0', effort: 'medium' },
    { adapterId: 'kimi', model: 'kimi-code/k3', effort: 'medium' },
    { adapterId: 'grok', model: 'grok-4.1', effort: 'medium' },
    { adapterId: 'agy', model: 'gemini-3.1-pro-high', effort: 'medium' },
    { adapterId: 'codex', model: 'gpt-5.6-luna', effort: 'medium' },
    { adapterId: 'codex', model: 'gpt-5.4', effort: 'medium' },
    { adapterId: 'claude', model: 'claude-sonnet-5', effort: 'medium' },
  ],
  hard: [
    { adapterId: 'claude', model: 'claude-opus-5', effort: 'high' },
    { adapterId: 'claude', model: 'claude-opus-4-8', effort: 'high' },
    { adapterId: 'glm', model: 'glm-5.3', effort: 'high' },
    { adapterId: 'longcat', model: 'LongCat-2.0', effort: 'high' },
    { adapterId: 'codex', model: CODEX_FRONTIER_MODEL, effort: 'high' },
    { adapterId: 'codex', model: 'gpt-5.6-terra', effort: 'high' },
    { adapterId: 'agy', model: 'gemini-3.1-pro-high', effort: 'high' },
    { adapterId: 'kimi', model: 'kimi-code/k3', effort: 'high' },
    { adapterId: 'grok', model: 'grok-4.1', effort: 'high' },
  ],
  critical: [
    { adapterId: 'claude', model: 'claude-fable-5', effort: 'xhigh' },
    { adapterId: 'claude', model: 'claude-opus-5', effort: 'xhigh' },
    { adapterId: 'claude', model: 'claude-opus-4-8', effort: 'xhigh' },
    { adapterId: 'codex', model: 'gpt-5.6-sol', effort: 'xhigh' },
    { adapterId: 'glm', model: 'glm-5.3', effort: 'xhigh' },
    // Diversidade também no crítico: sem estes, uma máquina sem claude/codex/
    // glm empresta de outro tier e o worker crítico colapsa num só provider.
    // agy antes de kimi preserva a preferência efetiva anterior (o empréstimo
    // do tier hard escolhia gemini-3.1-pro-high quando ambos instalados).
    { adapterId: 'agy', model: 'gemini-3.1-pro-high', effort: 'xhigh' },
    { adapterId: 'kimi', model: 'kimi-code/k3', effort: 'xhigh' },
  ],
};

/**
 * Keyword signals, PT-BR + EN (orchestrators prompt in both). Order matters:
 * the strongest matched bucket wins, then size nudges the tier up or down.
 */
const CRITICAL_SIGNALS = [
  // Com o match por prefixo-de-palavra, compostos genuínos precisam de
  // entrada própria: 'encrypt'/'unauthorized'/'cybersecurity'/'reautentic'
  // não começam com os sinais base ('crypt', 'authoriza', 'security', …).
  'security', 'cybersecurity', 'ciberseg', 'ciberata', 'segurança',
  'vulnerab', 'auth', 'oauth', 'unauthorized', 'não autorizado',
  'nao autorizado', 'desautoriz', 'autentica', 'reautentic', 'authoriza',
  'autoriza', 'payment', 'pagamento', 'billing', 'cobrança', 'migration',
  'migração', 'migracao', 'cript', 'crypt', 'encrypt', 'decrypt', 'encripta',
  'reencript', 'desencripta', 'descriptografa', 'descriptografia',
  'tenant', 'multitenant', 'rls',
  'produção', 'producao', 'production', 'data loss', 'perda de dados',
  'race condition', 'concorrência', 'concorrencia', 'deadlock', 'webhook',
  'secret', 'token',
];

const HARD_SIGNALS = [
  'arquitetura', 'architecture', 'refactor', 'refatora', 'redesign',
  'performance', 'otimiza', 'optimiz', 'algorithm', 'algoritmo', 'debug',
  'race', 'memory leak', 'vazamento', 'complex', 'complexo', 'complexa',
  'design de sistema', 'system design', 'distributed', 'distribuído',
  'distribuido', 'protocolo', 'protocol', 'parser', 'compiler', 'engine',
  'motor', 'integração', 'integracao', 'integration',
];

const EASY_SIGNALS = [
  'rename', 'renomea', 'typo', 'comment', 'comentário', 'comentario',
  'readme', 'doc', 'documenta', 'format', 'formata', 'lint', 'css', 'estilo',
  'style', 'copy', 'texto', 'label', 'tradu', 'translat', 'ajuste simples',
  'small fix', 'log', 'print',
];

const TRIVIAL_SIGNALS = [
  // 'list'/'listar' como prefixo casavam DENTRO de "li(sta)gem" —
  // "implemente a página de listagem" ia para trivial (modelo mais barato
  // construindo feature; matriz 23/08). Imperativo de inspeção fica:
  'liste', 'leitura', 'read', 'ler', 'check', 'verificar', 'status',
  'mostrar', 'show', 'contar', 'count', 'buscar arquivo', 'find file',
];

const TIER_ORDER: TaskTier[] = ['trivial', 'easy', 'medium', 'hard', 'critical'];

// Sinais casam como PREFIXO DE PALAVRA ('autentica' → 'autenticação'), nunca
// no meio de outra palavra ('cript' NÃO pode casar 'typescript'). Substring
// pura inflava tasks rotineiras de TypeScript para tier critical.
const signalMatchers = new Map<string, RegExp>();

function signalMatcher(signal: string): RegExp {
  let matcher = signalMatchers.get(signal);
  if (!matcher) {
    const escaped = signal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    matcher = new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}`, 'u');
    signalMatchers.set(signal, matcher);
  }
  return matcher;
}

function matchSignals(text: string, signals: string[]): string[] {
  return signals.filter((signal) => signalMatcher(signal).test(text));
}

function bumpTier(tier: TaskTier, delta: number): TaskTier {
  const index = TIER_ORDER.indexOf(tier) + delta;
  return TIER_ORDER[Math.max(0, Math.min(TIER_ORDER.length - 1, index))];
}

export interface TaskClassification {
  tier: TaskTier;
  /** Matched keywords — the transparent "why" of the decision. */
  signals: string[];
}

/**
 * Heuristic complexity classifier. Keyword buckets set the base tier
 * (critical > hard > easy/trivial > default medium); task size nudges it:
 * a one-liner drops a level, a long multi-part description raises one.
 */
export function classifyTask(taskText: string): TaskClassification {
  const text = taskText.toLowerCase();
  const words = text.split(/\s+/).filter((w) => w.length > 0).length;

  const critical = matchSignals(text, CRITICAL_SIGNALS);
  const hard = matchSignals(text, HARD_SIGNALS);
  const easy = matchSignals(text, EASY_SIGNALS);
  const trivial = matchSignals(text, TRIVIAL_SIGNALS);

  let tier: TaskTier;
  let signals: string[];
  if (critical.length > 0) {
    tier = 'critical';
    signals = critical;
  } else if (hard.length > 0) {
    tier = 'hard';
    signals = hard;
  } else if (easy.length > 0 && easy.length >= trivial.length) {
    tier = 'easy';
    signals = easy;
  } else if (trivial.length > 0) {
    tier = 'trivial';
    signals = trivial;
  } else {
    tier = 'medium';
    signals = [];
  }

  // Size nudge: risk keywords always keep their floor; otherwise a very short
  // ask is likely simpler and a long multi-part brief likely harder.
  if (critical.length === 0) {
    if (words <= 6 && tier !== 'trivial') tier = bumpTier(tier, -1);
    else if (words > 80) tier = bumpTier(tier, 1);
  }

  return { tier, signals };
}

export interface AdapterAvailability {
  id: string;
  installed: boolean;
  /** Optional resolved model list; when present, candidates outside it are skipped. */
  models?: string[];
}

/**
 * Explica o resultado da lista de preferência do chamador (bug F): qual
 * preferido venceu, ou por que cada um ficou de fora — "não instalado",
 * "reservado/sem modelo", "fora do ranking do tier". Sem isto o Maestro via
 * um adapter "não verificado" sem entender o que aconteceu com o pedido.
 */
export function describePreferAdaptersOutcome(
  preferAdapters: readonly string[] | undefined,
  chosenAdapterId: string,
  availability: readonly AdapterAvailability[],
  rankedAdapterIds: readonly string[],
): string {
  if (!preferAdapters || preferAdapters.length === 0) return '';
  const available = new Map(availability.map((a) => [a.id, a]));
  const fates: string[] = [];
  for (const id of preferAdapters) {
    if (id === chosenAdapterId) {
      fates.push(`${id}=preferido escolhido`);
      continue;
    }
    const info = available.get(id);
    if (!info || !info.installed) {
      fates.push(`${id}=não instalado/reservado`);
    } else if (!rankedAdapterIds.includes(id)) {
      fates.push(`${id}=fora do ranking do tier`);
    } else {
      fates.push(`${id}=preterido no multi-score`);
    }
  }
  return `; prefer: ${fates.join(', ')}`;
}

export interface RouteDecision {
  tier: TaskTier;
  adapterId: string;
  model?: string;
  effort?: string;
  reason: string;
  /** Remaining installed candidates of the tier, for manual override. */
  alternatives: RouteCandidate[];
  /** Work specialty the motor classified (visual, security, …). */
  specialty?: RouteSpecialty;
  /** Why this adapter won: heuristic prior, eval scores, or benchmark rows. */
  policySource?: RoutePolicySource;
}

type QualityDimension = 'coding' | 'reasoning' | 'frontend' | 'security';

function qualityDimension(taskText: string, tier: TaskTier): QualityDimension {
  const specialty = classifyRouteSpecialty(taskText).specialty;
  if (specialty === 'visual') return 'frontend';
  if (specialty === 'security') return 'security';
  if (specialty === 'bug') return 'reasoning';
  return tier === 'hard' || tier === 'critical' ? 'reasoning' : 'coding';
}

const ROUTABLE_MODEL_FAMILY_VARIANTS: ReadonlyMap<
  string,
  ReadonlySet<string>
> = new Map([
  ['gpt-5.6', new Set(['gpt-5.6-sol', 'gpt-5.6-luna', 'gpt-5.6-terra'])],
]);

/**
 * Exact, release-pinned proof that a routed model is the sanctioned live
 * variant of a configured model family. This deliberately is not a prefix
 * check: an arbitrary `gpt-5.6-*` id must never inherit the sealed authority
 * of `gpt-5.6`.
 */
export function isRoutableModelResolution(
  requested: string,
  resolved: string | undefined,
): boolean {
  return (
    resolved === requested ||
    (resolved !== undefined &&
      (ROUTABLE_MODEL_FAMILY_VARIANTS.get(requested)?.has(resolved) ?? false))
  );
}

/**
 * Resolve o modelo de um candidato da tabela contra a lista REAL de modelos do
 * adapter instalado. Motivo de campo (17/07): a tabela pedia `gpt-5.6`, mas a
 * OpenAI renomeou a geração em variantes (`gpt-5.6-sol`/`-luna`/`-terra`); o
 * CLI ignorava o modelo fantasma e caía SILENCIOSAMENTE no seu default
 * (`gpt-5.5`). Agora:
 *  - modelo exato disponível → usa ele;
 *  - família release-pinned disponível (ex.: `gpt-5.6` → `gpt-5.6-sol`) →
 *    usa a 1ª variante que o CLI lista (a CLI ordena a preferida primeiro);
 *  - nada da família instalado → candidato é DESCARTADO (nunca emite um
 *    modelo que o adapter não roda);
 *  - adapter sem lista de modelos → confia na tabela (não há como validar).
 */
export function resolveRoutableModel(
  requested: string | undefined,
  available: readonly string[] | undefined,
): { readonly ok: true; readonly model: string | undefined } | { readonly ok: false } {
  if (!requested) return { ok: true, model: undefined };
  if (!available || available.length === 0) return { ok: true, model: requested };
  if (available.includes(requested)) return { ok: true, model: requested };
  const variant = available.find((model) =>
    isRoutableModelResolution(requested, model),
  );
  return variant ? { ok: true, model: variant } : { ok: false };
}

function evaluatedCandidates(
  taskText: string,
  tier: TaskTier,
  available: ReadonlyMap<string, AdapterAvailability>,
  catalog: ModelCatalog,
): RouteCandidate[] {
  const dimension = qualityDimension(taskText, tier);
  const effort = tier === 'critical'
    ? 'xhigh'
    : tier === 'hard'
      ? 'high'
      : tier === 'medium'
        ? 'medium'
        : 'low';
  return [...available.values()]
    .flatMap((adapter) => (adapter.models ?? []).flatMap((model) => {
      const info = modelCatalogInfo(catalog, adapter.id, model);
      if (!hasAuthoritativeModelQuality(info) || isModelBlockedForAutoRouting(info)) {
        return [];
      }
      const qualityInfo = info!.quality!;
      const quality =
        qualityInfo[dimension] ?? qualityInfo.coding ?? qualityInfo.overall;
      const costPenalty = tier === 'trivial' || tier === 'easy'
        ? modelRoutingRank(info) * 12
        : tier === 'medium'
          ? modelRoutingRank(info) * 4
          : 0;
      return [{ candidate: { adapterId: adapter.id, model, effort }, score: quality - costPenalty }];
    }))
    .sort((left, right) => right.score - left.score)
    .map((entry) => entry.candidate);
}

/**
 * Pick the first installed candidate of the task's tier (candidates are
 * ordered cheapest-first). When nothing of the tier is installed, walk the
 * cheaper tiers down then the stronger ones up; last resort is the first
 * installed adapter with the tier's effort.
 */
export function routeTask(
  taskText: string,
  adapters: AdapterAvailability[],
  table: RoutingTable = DEFAULT_ROUTING_TABLE,
  tierOverride?: TaskTier,
  // Contexto de WORKER (o handler passa true): reserva o binário `claude`
  // OAuth para o orquestrador. N instâncias claude concorrentes reescrevem o
  // MESMO item de keychain "Claude Code-credentials" e o corrompem (tokens
  // zerados → todos deslogam). glm/longcat usam o mesmo binário mas autenticam
  // por ANTHROPIC_AUTH_TOKEN, então não disputam o keychain e seguem elegíveis.
  reserveClaude = false,
  /** Defaults to loadModelCatalog() = BUILTIN + PUBLISHED (eval quality) + user. */
  modelCatalog: ModelCatalog = loadModelCatalog(),
  context: RouteContext = {},
): RouteDecision | null {
  const available = new Map(
    adapters.filter((a) => a.installed).map((a) => [a.id, a]),
  );
  if (available.size === 0) return null;

  const classification = classifyTask(taskText);
  const tier = tierOverride ?? classification.tier;
  const specialtyVerdict = classifyRouteSpecialty(taskText);
  const policy = resolveSpecialtyPolicy(
    specialtyVerdict.specialty,
    context.specialtyBenchmark,
  );
  // A avaliação por dimensão só pode PRÉ-EMPTAR a tabela de diversidade
  // quando TODO adapter instalado tem ≥1 modelo avaliado. Com cobertura
  // parcial (ex.: kimi/agy sem nota nexus-eval), rankear só os avaliados
  // colapsaria o roteamento nos providers com nota — a tabela é que manda,
  // como o contrato declarado abaixo ("o catálogo só bloqueia riscos e anota
  // custo") sempre prometeu.
  const evaluationCoversAllInstalled = [...available.values()].every((adapter) =>
    (adapter.models ?? []).some((model) => {
      const info = modelCatalogInfo(modelCatalog, adapter.id, model);
      return (
        hasAuthoritativeModelQuality(info) &&
        !isModelBlockedForAutoRouting(info)
      );
    }),
  );
  const evaluated = evaluationCoversAllInstalled
    ? evaluatedCandidates(taskText, tier, available, modelCatalog)
    : [];
  const why =
    classification.signals.length > 0
      ? `sinais: ${classification.signals.slice(0, 5).join(', ')}`
      : 'sem sinais fortes — tier padrão pelo tamanho da tarefa';

  const tierIndex = TIER_ORDER.indexOf(tier);
  // Same tier first, then cheaper tiers (never waste), then stronger ones.
  const searchOrder = [
    tier,
    ...TIER_ORDER.slice(0, tierIndex).reverse(),
    ...TIER_ORDER.slice(tierIndex + 1),
  ];
  // Achata os candidatos instalados na ordem de busca (guardando o tier de
  // origem para o motivo "melhor opção instalada"). A ordem declarada da
  // tabela continua sendo a fonte de capacidade; o catálogo só bloqueia riscos
  // e anota custo, sem promover modelos baratos acima de modelos fortes.
  let ranked: RankedRouteEntry[] = evaluated.map((c) => ({
    c,
    fromTier: tier,
    evaluated: true,
  }));
  const skippedRisk: string[] = [];
  for (const candidateTier of searchOrder) {
    const tierCandidates = table[candidateTier]
      .flatMap((c) => {
        const adapter = available.get(c.adapterId);
        if (!adapter) return [];
        // Resolve o modelo da tabela para um que o adapter REALMENTE roda
        // (variante de família quando a geração foi renomeada). Sem família
        // disponível, descarta — nunca cai no default silencioso do CLI.
        const resolved = resolveRoutableModel(c.model, adapter.models);
        if (!resolved.ok) return [];
        const routed: RouteCandidate = { ...c, model: resolved.model };
        const info = modelCatalogInfo(modelCatalog, routed.adapterId, routed.model);
        if (isModelBlockedForAutoRouting(info)) {
          skippedRisk.push(
            `${routed.adapterId}:${routed.model ?? '(default)'} (${info?.availability ?? 'blocked'})`,
          );
          return [];
        }
        return [routed];
      });

    for (const c of tierCandidates) {
      if (!ranked.some((entry) => entry.c.adapterId === c.adapterId && entry.c.model === c.model)) {
        ranked.push({ c, fromTier: candidateTier });
      }
    }
  }

  // Specialty prior (heuristic today, benchmark when that table has rows)
  // reorders BEFORE multi-score so a UI task does not inherit the medium-tier
  // GLM lead, and a second route_task in the same wave can still diversify.
  // Eval-full coverage already ranked by qualityDimension(specialty) — do not
  // undo measured scores with the heuristic prior. A real benchmark table
  // outranks both.
  const prependIds = [
    ...(context.preferAdapters ?? []),
    ...(policy.source === 'benchmark' || evaluated.length === 0
      ? policy.preferAdapterIds
      : []),
  ].filter((id, index, all) => all.indexOf(id) === index);
  if (prependIds.length > 0) {
    ranked = preferAdapterOrder(
      ranked,
      (entry) => entry.c.adapterId,
      prependIds,
    );
  }

  // Overclock-style cost band: refine a heuristic specialty prior at model
  // granularity (haiku vs opus on the same CLI). Adapter order stays the
  // heuristic/table lead — do not float Grok/GLM over Kimi. Empty prefer
  // lists (feature/general) skip this. Never runs on a measured benchmark
  // or full eval coverage.
  let bandNote = '';
  if (
    policy.source === 'heuristic' &&
    policy.preferAdapterIds.length > 0 &&
    evaluated.length === 0
  ) {
    const targetBand = bandForSpecialty(policy.specialty);
    const preferred = new Set(policy.preferAdapterIds);
    const head = ranked.filter((entry) => preferred.has(entry.c.adapterId));
    const tail = ranked.filter((entry) => !preferred.has(entry.c.adapterId));
    const adapterOrder: string[] = [];
    const byAdapter = new Map<string, typeof head>();
    for (const entry of head) {
      const adapterId = entry.c.adapterId;
      if (!byAdapter.has(adapterId)) {
        adapterOrder.push(adapterId);
        byAdapter.set(adapterId, []);
      }
      byAdapter.get(adapterId)!.push(entry);
    }
    ranked = [
      ...adapterOrder.flatMap((adapterId) =>
        preferOperationalBand(
          byAdapter.get(adapterId)!,
          (entry) =>
            classifyOperationalBand(
              modelCatalogInfo(modelCatalog, entry.c.adapterId, entry.c.model),
            ),
          targetBand,
        ),
      ),
      ...tail,
    ];
    bandNote = `; band=${targetBand}`;
  }

  // x-algorithm multi-score: activate when mission has history, circuit open,
  // or caller opts in — preserves pure table order on cold first pick.
  const anyCircuitOpen = ranked.some((r) =>
    adapterCircuitBreakers.isOpen(r.c.adapterId),
  );
  const hasMissionHistory =
    (context.missionUsedAdapters?.size ?? 0) > 0 ||
    (context.missionUseCounts?.size ?? 0) > 0;
  const runMultiScore =
    context.multiScore === true ||
    (context.multiScore !== false && (hasMissionHistory || anyCircuitOpen));
  let multiScoreNote = '';
  if (runMultiScore && ranked.length > 1) {
    const scored = multiScoreRerank({
      ranked,
      tier,
      context,
      modelCatalog,
      circuitOpen: (id) => adapterCircuitBreakers.isOpen(id),
      missionUseCounts: context.missionUseCounts,
    });
    ranked = scored.ranked;
    multiScoreNote = scored.note;
  }

  if (ranked.length > 0) {
    let chosen = ranked[0];
    if (reserveClaude && chosen.c.adapterId === 'claude') {
      const alt = ranked.find((r) => r.c.adapterId !== 'claude');
      // ponytail: só claude instalado → sem alternativa, mantém claude (o
      // orquestrador serializa os workers claude nesse caso raro).
      if (alt) chosen = alt;
    }
    const pick = chosen.c;
    const effort = applyEffortFloor(pick.effort, policy.effortFloor);
    const policySource: RoutePolicySource = chosen.evaluated
      ? 'nexus-eval'
      : policy.source;
    const borrowed =
      chosen.fromTier === tier
        ? ''
        : ` (tier ${chosen.fromTier} — melhor opção instalada)`;
    const costRank = modelRoutingRank(
      modelCatalogInfo(modelCatalog, pick.adapterId, pick.model),
    );
    const costNote = costRank <= 1 ? '; preferiu rota free/cheap' : '';
    const evaluationNote = chosen.evaluated
      ? '; selecionado por avaliação Nexus por dimensão'
      : '';
    const specialtyNote = `; specialty=${specialtyVerdict.specialty} source=${policySource}`;
    // Bug F (Maestro 2026-08-17): preferAdapters parecia "ignorado" porque o
    // preferido era derrubado em silêncio (não instalado, sem candidato no
    // tier, reservado). A decisão agora DIZ o destino de cada preferido.
    const preferNote = describePreferAdaptersOutcome(
      context.preferAdapters,
      pick.adapterId,
      adapters,
      ranked.map((r) => r.c.adapterId),
    );
    const riskNote =
      skippedRisk.length > 0
        ? `; evitou ${[...new Set(skippedRisk)].slice(0, 3).join(', ')}`
        : '';
    return {
      tier,
      adapterId: pick.adapterId,
      model: pick.model,
      effort,
      reason: `${tier}${borrowed}${specialtyNote}; ${why}${costNote}${evaluationNote}${riskNote}${bandNote}${multiScoreNote}${preferNote}`,
      alternatives: ranked.filter((r) => r.c !== pick).map((r) => r.c),
      specialty: specialtyVerdict.specialty,
      policySource,
    };
  }

  // No table adapter installed at all — degrade to whatever exists.
  // F-525: "whatever exists" não pode ser sempre o primeiro (concentrava a
  // missão num único CLI, tipicamente Codex). Escolhe o MENOS USADO da missão
  // entre os disponíveis — o mesmo sinal de diversidade do multi-score, agora
  // no degrau final.
  const fallbackPool = [...available.keys()];
  const useCount = (id: string): number =>
    context.missionUseCounts?.get(id) ?? 0;
  const fallback = fallbackPool.reduce((least, id) =>
    useCount(id) < useCount(least) ? id : least,
  fallbackPool[0]!);
  return {
    tier,
    adapterId: fallback,
    effort: applyEffortFloor(table[tier][0]?.effort, policy.effortFloor),
    reason: `${tier}; specialty=${specialtyVerdict.specialty} source=${policy.source}; ${why}; nenhum candidato da tabela instalado — usando ${fallback} (menos usado na missão)`,
    alternatives: [],
    specialty: specialtyVerdict.specialty,
    policySource: policy.source,
  };
}
