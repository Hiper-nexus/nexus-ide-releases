/**
 * Task router — the orchestrator's cost brain. Classifies a task description
 * into a complexity tier and picks the cheapest agent that can handle it
 * (adapter + model + reasoning effort), so easy work never burns
 * Opus/Fable-class tokens and hard work never lands on a fast-and-loose
 * model. Pure logic (no electron imports) — fully unit-testable; the MCP tool
 * nexus_route_task feeds it the live adapter list.
 */

export type TaskTier = 'trivial' | 'easy' | 'medium' | 'hard' | 'critical';

export interface RouteCandidate {
  adapterId: string;
  model?: string;
  effort?: string;
}

export type RoutingTable = Record<TaskTier, RouteCandidate[]>;

/**
 * Default ladder, cheapest-first inside each tier — and deliberately spread
 * across every installed LLM so work isn't dumped on one provider: the LEAD
 * model per tier rotates (grok → kimi → glm → claude) for real diversity.
 * Model ids match the builtin adapter catalogs; a missing/uninstalled adapter
 * (or GLM without its z.ai key) falls through to the next candidate.
 *
 * GLM (z.ai, model 5.2) is a first-class `glm` adapter now — strong AND cheap,
 * so it LEADS the medium tier and is an early option on hard. It runs on the
 * Claude binary pointed at the z.ai endpoint (see glm.json).
 */
export const DEFAULT_ROUTING_TABLE: RoutingTable = {
  trivial: [
    { adapterId: 'grok', model: 'grok-code-fast-1', effort: 'low' },
    { adapterId: 'gemini', model: 'gemini-3.5-flash', effort: 'low' },
    { adapterId: 'kimi', model: 'kimi-for-coding', effort: 'low' },
    { adapterId: 'claude', model: 'claude-haiku-4-5', effort: 'low' },
  ],
  easy: [
    { adapterId: 'kimi', model: 'kimi-for-coding', effort: 'low' },
    { adapterId: 'grok', model: 'grok-4-fast', effort: 'low' },
    { adapterId: 'gemini', model: 'gemini-3-flash', effort: 'low' },
    { adapterId: 'codex', model: 'gpt-5.4-mini', effort: 'low' },
    { adapterId: 'agy', model: 'gemini-3.5-flash-high', effort: 'low' },
    { adapterId: 'claude', model: 'claude-sonnet-4-6', effort: 'low' },
  ],
  medium: [
    { adapterId: 'glm', model: 'glm-5.2', effort: 'medium' },
    { adapterId: 'kimi', model: 'kimi-for-coding', effort: 'medium' },
    { adapterId: 'grok', model: 'grok-4.1', effort: 'medium' },
    { adapterId: 'gemini', model: 'gemini-3.1-pro', effort: 'medium' },
    { adapterId: 'agy', model: 'gemini-3.1-pro-high', effort: 'medium' },
    { adapterId: 'codex', model: 'gpt-5.4', effort: 'medium' },
    { adapterId: 'claude', model: 'claude-sonnet-5', effort: 'medium' },
  ],
  hard: [
    { adapterId: 'claude', model: 'claude-opus-4-8', effort: 'high' },
    { adapterId: 'glm', model: 'glm-5.2', effort: 'high' },
    { adapterId: 'codex', model: 'gpt-5.5', effort: 'high' },
    { adapterId: 'gemini', model: 'gemini-3.1-pro', effort: 'high' },
    { adapterId: 'kimi', model: 'kimi-for-coding', effort: 'high' },
    { adapterId: 'grok', model: 'grok-4.1', effort: 'high' },
  ],
  critical: [
    { adapterId: 'claude', model: 'claude-fable-5', effort: 'xhigh' },
    { adapterId: 'claude', model: 'claude-opus-4-8', effort: 'xhigh' },
    { adapterId: 'codex', model: 'gpt-5.5', effort: 'xhigh' },
    { adapterId: 'glm', model: 'glm-5.2', effort: 'xhigh' },
  ],
};

/**
 * Keyword signals, PT-BR + EN (orchestrators prompt in both). Order matters:
 * the strongest matched bucket wins, then size nudges the tier up or down.
 */
const CRITICAL_SIGNALS = [
  'security', 'segurança', 'vulnerab', 'auth', 'autentica', 'authoriza',
  'autoriza', 'payment', 'pagamento', 'billing', 'cobrança', 'migration',
  'migração', 'migracao', 'cript', 'crypt', 'tenant', 'rls', 'produção',
  'producao', 'production', 'data loss', 'perda de dados', 'race condition',
  'concorrência', 'concorrencia', 'deadlock', 'webhook', 'secret', 'token',
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

function matchSignals(text: string, signals: string[]): string[] {
  return signals.filter((signal) => text.includes(signal));
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
): RouteDecision | null {
  const installed = new Set(
    adapters.filter((a) => a.installed).map((a) => a.id),
  );
  if (installed.size === 0) return null;

  const classification = classifyTask(taskText);
  const tier = tierOverride ?? classification.tier;
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
  for (const candidateTier of searchOrder) {
    const available = table[candidateTier].filter((c) =>
      installed.has(c.adapterId),
    );
    if (available.length === 0) continue;
    const [pick, ...alternatives] = available;
    const borrowed =
      candidateTier === tier ? '' : ` (tier ${candidateTier} — melhor opção instalada)`;
    return {
      tier,
      adapterId: pick.adapterId,
      model: pick.model,
      effort: pick.effort,
      reason: `${tier}${borrowed}; ${why}`,
      alternatives,
    };
  }

  // No table adapter installed at all — degrade to whatever exists.
  const fallback = [...installed][0];
  return {
    tier,
    adapterId: fallback,
    effort: table[tier][0]?.effort,
    reason: `${tier}; ${why}; nenhum candidato da tabela instalado — usando ${fallback}`,
    alternatives: [],
  };
}
