/**
 * Task router — the orchestrator's cost brain. Classifies a task description
 * into a complexity tier and picks the cheapest agent that can handle it
 * (adapter + model + reasoning effort), so easy work never burns
 * Opus/Fable-class tokens and hard work never lands on a fast-and-loose
 * model. Pure logic (no electron imports) — fully unit-testable; the MCP tool
 * nexus_route_task feeds it the live adapter list.
 */
import {
  isModelBlockedForAutoRouting,
  loadModelCatalog,
  modelCatalogInfo,
  modelRoutingRank,
  type ModelCatalog,
} from '../adapters/model-catalog';
import type { OmpParticipation } from '../../shared/settings-types';

export type TaskTier = 'trivial' | 'easy' | 'medium' | 'hard' | 'critical';

export interface RouteCandidate {
  adapterId: string;
  model?: string;
  effort?: string;
}

export type RoutingTable = Record<TaskTier, RouteCandidate[]>;

/**
 * Optional routing context: omp participation + mission diversity.
 * Pure — call sites inject orch settings and mission pane history.
 */
export interface RouteContext {
  /** Adapters already used by panes in this mission (diversity boost). */
  missionUsedAdapters?: ReadonlySet<string>;
  /** Soft prefer list (e.g. ['omp']) applied after table rank. */
  preferAdapters?: readonly string[];
  /**
   * How Oh My Pi participates. Default `diversity` matches product policy.
   * Call sites should pass getOrchSettings().ompParticipation.
   */
  ompParticipation?: OmpParticipation;
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
 * GLM (z.ai, model 5.2) is a first-class `glm` adapter now — strong AND cheap,
 * so it LEADS the medium tier and is an early option on hard. It runs on the
 * Claude binary pointed at the z.ai endpoint (see glm.json). LongCat
 * (Meituan, 1M ctx, agentic) follows the same pattern (longcat.json) and sits
 * right behind GLM on medium/hard — comparable price, extra diversity.
 *
 * Oh My Pi (omp) sits early on medium/hard (not last): it aggregates providers
 * already logged into omp and is a first-class diversity citizen. Runtime
 * `ompParticipation` can demote/exclude it without editing this table.
 */
export const DEFAULT_ROUTING_TABLE: RoutingTable = {
  trivial: [
    { adapterId: 'grok', model: 'grok-code-fast-1', effort: 'low' },
    { adapterId: 'agy', model: 'gemini-3.5-flash-low', effort: 'low' },
    { adapterId: 'kimi', model: 'kimi-code/kimi-for-coding', effort: 'low' },
    { adapterId: 'claude', model: 'claude-haiku-4-5', effort: 'low' },
  ],
  easy: [
    { adapterId: 'kimi', model: 'kimi-code/kimi-for-coding', effort: 'low' },
    { adapterId: 'grok', model: 'grok-4-fast', effort: 'low' },
    { adapterId: 'agy', model: 'gemini-3.5-flash-low', effort: 'low' },
    { adapterId: 'omp', model: 'zai/glm-5', effort: 'low' },
    { adapterId: 'codex', model: 'gpt-5.4-mini', effort: 'low' },
    { adapterId: 'claude', model: 'claude-sonnet-4-6', effort: 'low' },
  ],
  medium: [
    { adapterId: 'glm', model: 'glm-5.2', effort: 'medium' },
    // omp early: real diversity when installed, not silent last-resort.
    { adapterId: 'omp', model: 'zai/glm-5', effort: 'medium' },
    { adapterId: 'longcat', model: 'LongCat-2.0', effort: 'medium' },
    { adapterId: 'kimi', model: 'kimi-code/kimi-for-coding', effort: 'medium' },
    { adapterId: 'grok', model: 'grok-4.1', effort: 'medium' },
    { adapterId: 'agy', model: 'gemini-3.1-pro-high', effort: 'medium' },
    { adapterId: 'codex', model: 'gpt-5.4', effort: 'medium' },
    { adapterId: 'claude', model: 'claude-sonnet-5', effort: 'medium' },
  ],
  hard: [
    { adapterId: 'claude', model: 'claude-opus-4-8', effort: 'high' },
    { adapterId: 'glm', model: 'glm-5.2', effort: 'high' },
    { adapterId: 'omp', model: 'xai/grok-4.5', effort: 'high' },
    { adapterId: 'longcat', model: 'LongCat-2.0', effort: 'high' },
    { adapterId: 'codex', model: 'gpt-5.6-sol', effort: 'high' },
    { adapterId: 'agy', model: 'gemini-3.1-pro-high', effort: 'high' },
    { adapterId: 'kimi', model: 'kimi-code/kimi-for-coding', effort: 'high' },
    { adapterId: 'grok', model: 'grok-4.1', effort: 'high' },
  ],
  critical: [
    { adapterId: 'claude', model: 'claude-fable-5', effort: 'xhigh' },
    { adapterId: 'claude', model: 'claude-opus-4-8', effort: 'xhigh' },
    { adapterId: 'codex', model: 'gpt-5.6-sol', effort: 'xhigh' },
    { adapterId: 'glm', model: 'glm-5.2', effort: 'xhigh' },
    // Diversidade também no crítico: sem estes, uma máquina sem claude/codex/
    // glm empresta de outro tier e o worker crítico colapsa num só provider.
    // agy antes de kimi preserva a preferência efetiva anterior (o empréstimo
    // do tier hard escolhia gemini-3.1-pro-high quando ambos instalados).
    { adapterId: 'agy', model: 'gemini-3.1-pro-high', effort: 'xhigh' },
    { adapterId: 'kimi', model: 'kimi-code/kimi-for-coding', effort: 'xhigh' },
    // omp last on critical — security floor keeps claude/codex first.
    { adapterId: 'omp', model: 'xai/grok-4.5', effort: 'xhigh' },
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
  'list', 'listar', 'read', 'ler', 'check', 'verificar', 'status', 'mostrar',
  'show', 'contar', 'count', 'buscar arquivo', 'find file',
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

export interface RouteDecision {
  tier: TaskTier;
  adapterId: string;
  model?: string;
  effort?: string;
  reason: string;
  /** Remaining installed candidates of the tier, for manual override. */
  alternatives: RouteCandidate[];
}

type QualityDimension = 'coding' | 'reasoning' | 'frontend' | 'security';

function qualityDimension(taskText: string, tier: TaskTier): QualityDimension {
  if (/\b(frontend|landing|website|interface|ui|ux|css|design|responsive|acessibilidade)\b/i.test(taskText)) {
    return 'frontend';
  }
  if (/\b(security|seguran|auth|oauth|permission|token|secret|payment|pagamento|billing)\b/i.test(taskText)) {
    return 'security';
  }
  return tier === 'hard' || tier === 'critical' ? 'reasoning' : 'coding';
}

/**
 * Resolve o modelo de um candidato da tabela contra a lista REAL de modelos do
 * adapter instalado. Motivo de campo (17/07): a tabela pedia `gpt-5.6`, mas a
 * OpenAI renomeou a geração em variantes (`gpt-5.6-sol`/`-luna`/`-terra`); o
 * CLI ignorava o modelo fantasma e caía SILENCIOSAMENTE no seu default
 * (`gpt-5.5`). Agora:
 *  - modelo exato disponível → usa ele;
 *  - família disponível (mesmo prefixo de geração, ex.: `gpt-5.6` →
 *    `gpt-5.6-sol`) → usa a 1ª variante que o CLI lista (a CLI ordena a
 *    preferida primeiro);
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
  const variant = available.find(
    (model) => model.startsWith(`${requested}-`) || model.startsWith(`${requested}.`),
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
      if (!info?.quality || isModelBlockedForAutoRouting(info)) return [];
      const quality = info.quality[dimension] ?? info.quality.coding ?? info.quality.overall;
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
 * Security/critical floor: do not force omp ahead of claude/codex when those
 * are available. Diversity still keeps omp in the ladder later.
 */
function securityFloorActive(taskText: string, tier: TaskTier): boolean {
  return qualityDimension(taskText, tier) === 'security' || tier === 'critical';
}

/**
 * Reorder ranked candidates for omp participation + mission diversity.
 * Pure and unit-tested — never invents candidates that aren't already ranked.
 */
export function applyOmpParticipation(
  ranked: RankedRouteEntry[],
  taskText: string,
  tier: TaskTier,
  context: RouteContext = {},
): { ranked: RankedRouteEntry[]; note: string } {
  const participation = context.ompParticipation ?? 'diversity';
  if (ranked.length === 0) return { ranked, note: '' };

  if (participation === 'off') {
    const filtered = ranked.filter((entry) => entry.c.adapterId !== 'omp');
    if (filtered.length === ranked.length) return { ranked, note: '' };
    return {
      ranked: filtered.length > 0 ? filtered : ranked,
      note: filtered.length > 0 ? '; ompParticipation=off' : '',
    };
  }

  const ompEntries = ranked.filter((entry) => entry.c.adapterId === 'omp');
  if (ompEntries.length === 0) return { ranked, note: '' };

  const withoutOmp = ranked.filter((entry) => entry.c.adapterId !== 'omp');

  // Legacy ladder: omp is last among eligible candidates (table now places it
  // early for diversity; fallback re-demotes so settings still match the label).
  if (participation === 'fallback') {
    if (withoutOmp.length === 0) return { ranked, note: '' };
    return {
      ranked: [...withoutOmp, ...ompEntries],
      note: '; ompParticipation=fallback',
    };
  }

  const used = context.missionUsedAdapters;
  const ompAlreadyUsed = used?.has('omp') === true;
  const preferList = context.preferAdapters ?? [];
  const softPreferOmp = preferList.includes('omp');
  const floor = securityFloorActive(taskText, tier);

  if (participation === 'prefer' && !floor) {
    return {
      ranked: [...ompEntries, ...withoutOmp],
      note: '; ompParticipation=prefer',
    };
  }

  // diversity: always keep omp as #2 when eligible (even on the first pick),
  // so vibe-coder missions get real multi-CLI without waiting for history.
  if (!floor && !ompAlreadyUsed && participation === 'diversity') {
    if (withoutOmp.length === 0) {
      return { ranked: ompEntries, note: '; omp diversity (only eligible)' };
    }
    const head = withoutOmp[0];
    const tail = withoutOmp.slice(1);
    return {
      ranked: [head, ...ompEntries, ...tail],
      note: '; omp diversity boost (#2)',
    };
  }

  if (softPreferOmp && !floor && !ompAlreadyUsed) {
    // Soft prefer from MCP preferAdapters without global prefer mode.
    if (withoutOmp.length === 0) {
      return { ranked: ompEntries, note: '; preferAdapters includes omp' };
    }
    const head = withoutOmp[0];
    const tail = withoutOmp.slice(1);
    return {
      ranked: [head, ...ompEntries, ...tail],
      note: '; preferAdapters includes omp',
    };
  }

  return { ranked, note: '' };
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
  // A avaliação por dimensão só pode PRÉ-EMPTAR a tabela de diversidade
  // quando TODO adapter instalado tem ≥1 modelo avaliado. Com cobertura
  // parcial (ex.: kimi/agy sem nota nexus-eval), rankear só os avaliados
  // colapsaria o roteamento nos providers com nota — a tabela é que manda,
  // como o contrato declarado abaixo ("o catálogo só bloqueia riscos e anota
  // custo") sempre prometeu.
  const evaluationCoversAllInstalled = [...available.values()].every((adapter) =>
    (adapter.models ?? []).some((model) => {
      const info = modelCatalogInfo(modelCatalog, adapter.id, model);
      return Boolean(info?.quality) && !isModelBlockedForAutoRouting(info);
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

  const ompApplied = applyOmpParticipation(ranked, taskText, tier, context);
  ranked = ompApplied.ranked;

  if (ranked.length > 0) {
    let chosen = ranked[0];
    if (reserveClaude && chosen.c.adapterId === 'claude') {
      const alt = ranked.find((r) => r.c.adapterId !== 'claude');
      // ponytail: só claude instalado → sem alternativa, mantém claude (o
      // orquestrador serializa os workers claude nesse caso raro).
      if (alt) chosen = alt;
    }
    const pick = chosen.c;
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
    const riskNote =
      skippedRisk.length > 0
        ? `; evitou ${[...new Set(skippedRisk)].slice(0, 3).join(', ')}`
        : '';
    return {
      tier,
      adapterId: pick.adapterId,
      model: pick.model,
      effort: pick.effort,
      reason: `${tier}${borrowed}; ${why}${costNote}${evaluationNote}${riskNote}${ompApplied.note}`,
      alternatives: ranked.filter((r) => r.c !== pick).map((r) => r.c),
    };
  }

  // No table adapter installed at all — degrade to whatever exists.
  const fallback = [...available.keys()][0];
  return {
    tier,
    adapterId: fallback,
    effort: table[tier][0]?.effort,
    reason: `${tier}; ${why}; nenhum candidato da tabela instalado — usando ${fallback}`,
    alternatives: [],
  };
}
