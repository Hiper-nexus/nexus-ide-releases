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
  ROUTE_EFFORTS,
  classifyRouteSpecialty,
  preferAdapterOrder,
  resolveSpecialtyPolicy,
  type RoutePolicySource,
  type RouteEffort,
  type RouteSpecialty,
  type SpecialtyBenchmark,
} from '../../shared/mission-route-specialty';
import {
  bandForSpecialty,
  classifyOperationalBand,
  preferOperationalBand,
} from '../../shared/model-operational-bands';
import { CODEX_FRONTIER_MODEL, GROK_FRONTIER_MODEL, migrateModelId } from '../../shared/model-defaults';
import { isSameLineAtLeast, newestInModelLine } from '../../shared/model-line';
import { BUILTIN_ADAPTERS } from '../../adapters/builtin';
import { adapterSchema } from '../../shared/adapter-types';
import { adapterCircuitBreakers } from './circuit-breaker';
import { multiScoreRerank, tieBreakByUse } from './route-pipeline';
import { modelAccessQuarantine } from './model-access-quarantine';

export type TaskTier = 'trivial' | 'easy' | 'medium' | 'hard' | 'critical';

/**
 * F-232 (regra do operador, 01/10): janela do fair-share GLOBAL — reservas de
 * rota consumidas por adapter neste checkout nos últimos 7 dias, em TODAS as
 * missões. A rotação por missão sozinha só reparte assentos entre os 3
 * primeiros do ranking (1–3 workers/missão); quem nunca entra na missão nunca
 * acumula uso — 7 dias medidos: muse/grok/openclaude/minimax/deepseek com
 * zero reservas.
 */
export const GLOBAL_USE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Gap mínimo para o fair-share trocar o líder — evita pingue-pongue. */
export const FAIR_SHARE_GAP = 2;

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
   * with multi-score (x-algorithm pattern). False preserves table order while
   * circuits are healthy; a failed CLI must still yield to a healthy route.
   */
  multiScore?: boolean;
  /**
   * Injected specialty table. `undefined` uses the empty published benchmark
   * (heuristic). Callers that merged a user overlay pass that object here so
   * unit tests never read `~/.nexus`.
   */
  specialtyBenchmark?: SpecialtyBenchmark | null;
  /**
   * Especialidade já julgada pelo chamador (Jev via jev-task-routing) —
   * substitui só a heurística de palavras-chave; política/benchmark seguem.
   */
  specialtyOverride?: RouteSpecialty;
  /** Reasoning per turn judged independently of model rank and specialty. */
  effortOverride?: RouteEffort;
  /**
   * Spawn da mão do operador (25/09): CLIs já abertas pelo mesmo agente pai.
   * Desempata opções heurísticas do mesmo tier por carga, sem tratar posição
   * na tabela como qualidade medida. Nunca vem de argumento MCP.
   */
  tieBreakUseCounts?: ReadonlyMap<string, number>;
  /**
   * F-232: reservas de rota CONSUMIDAS por adapter neste checkout nos últimos
   * 7 dias (todas as missões) — alimenta o fair-share global.
   */
  globalUseCounts?: ReadonlyMap<string, number>;
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
 * Evidência por modelo (benchmarks, preços, fontes datadas) e o porquê de
 * cada linha: docs/models/estudo-2026-09.md. O contrato
 * task-router-catalog-contract.test.ts reprova id aposentado, fora do
 * catálogo do adapter ou bloqueado para rota automática.
 */
export const DEFAULT_ROUTING_TABLE: RoutingTable = {
  trivial: [
    { adapterId: 'grok', model: GROK_FRONTIER_MODEL, effort: 'low' },
    // O mais novo primeiro (regra do operador, 29/09); o 3.7 fica de reserva.
    { adapterId: 'agy', model: 'gemini-3.8-flash-low', effort: 'low' },
    { adapterId: 'agy', model: 'gemini-3.7-flash-low', effort: 'low' },
    { adapterId: 'kimi', model: 'kimi-code/k3', effort: 'low' },
    { adapterId: 'glm-flash', model: 'glm-5.3-flash[1m]', effort: 'low' },
    // DeepSeek roda na CLI do Claude no endpoint Anthropic-compatible deles;
    // ids da API /models do DeepSeek, 01/10/2026.
    { adapterId: 'deepseek', model: 'deepseek-flash', effort: 'low' },
    // F-238: Qwen Code (cli-pty, fork do Gemini CLI) — flash barato no
    // trivial/easy; ids do settings do operador / seed do adapter.
    { adapterId: 'qwen', model: 'qwen3.6-flash', effort: 'low' },
    // Cost-based onboarding prior, not a measured quality rank. MiMo exposes
    // no verified effort argv; let its CLI use the model's native default.
    { adapterId: 'mimo-code', model: 'xiaomi/mimo-v2.6-flash' },
    // Same cost-based prior for MiniMax: the `mcode` TUI takes no effort argv
    // (only headless `exec` does), so the model's native default stands.
    { adapterId: 'minimax-code', model: 'minimax/MiniMax-M3.1-Flash-Preview' },
    { adapterId: 'minimax-code', model: 'minimax/MiniMax-M2.7-highspeed' },
    { adapterId: 'claude', model: 'claude-haiku-4-5', effort: 'low' },
    // F-696: Muse Spark 1.3 (free, DeepSWE 75,4 / TB2.1 88,8) em todo tier.
    { adapterId: 'muse', model: 'muse-spark-1.3' },
  ],
  easy: [
    { adapterId: 'kimi', model: 'kimi-code/k3', effort: 'low' },
    { adapterId: 'grok', model: GROK_FRONTIER_MODEL, effort: 'low' },
    // 3.8 Flash supera o 3.7 no mesmo preço (TB4.0 19,1% × 11,2%, model
    // cards Google 2026-08/09); o trivial segue no 3.7-low (free no agy).
    { adapterId: 'agy', model: 'gemini-3.8-flash-low', effort: 'low' },
    // gpt-5.4-mini saiu (migrava p/ 5.6-luna). GPT-6 Luna: geração nova e
    // mais barata ($0,10/$0,50 × $0,20/$1,20) — docs/models/estudo-2026-09.md.
    { adapterId: 'codex', model: 'gpt-6-luna', effort: 'low' },
    { adapterId: 'glm-flash', model: 'glm-5.3-flash[1m]', effort: 'low' },
    { adapterId: 'deepseek', model: 'deepseek-flash', effort: 'low' },
    { adapterId: 'qwen', model: 'qwen3.6-flash', effort: 'low' },
    { adapterId: 'mimo-code', model: 'xiaomi/mimo-v2.6-flash' },
    { adapterId: 'minimax-code', model: 'minimax/MiniMax-M3.1-Flash-Preview' },
    { adapterId: 'minimax-code', model: 'minimax/MiniMax-M2.7-highspeed' },
    // Sonnet 5 é mais novo e mais barato que o 4.6 ($2/$10 × $3/$15).
    // CLI 2.1.284: mesma faixa de custo; catálogo da CLI filtra disponibilidade.
    { adapterId: 'claude', model: 'claude-sonnet-5-5', effort: 'low' },
    { adapterId: 'claude', model: 'claude-sonnet-5', effort: 'low' },
    { adapterId: 'opencode', model: 'opencode/deepseek-v4-flash' },
    { adapterId: 'openclaude', model: 'haiku' },
    { adapterId: 'aider', model: 'claude-haiku-4-5' },
    // F-696: Muse Spark 1.3 (free, DeepSWE 75,4 / TB2.1 88,8) em todo tier.
    { adapterId: 'muse', model: 'muse-spark-1.3' },
  ],
  medium: [
    { adapterId: 'glm', model: 'glm-5.3', effort: 'medium' },
    { adapterId: 'longcat', model: 'LongCat-2.0', effort: 'medium' },
    { adapterId: 'deepseek', model: 'deepseek-v4-pro', effort: 'medium' },
    { adapterId: 'qwen', model: 'qwen3.7-plus', effort: 'medium' },
    { adapterId: 'mimo-code', model: 'xiaomi/mimo-v2.6-flash' },
    { adapterId: 'minimax-code', model: 'minimax/MiniMax-M3.1-Flash-Preview' },
    { adapterId: 'minimax-code', model: 'minimax/MiniMax-M3' },
    { adapterId: 'kimi', model: 'kimi-code/k3', effort: 'medium' },
    { adapterId: 'grok', model: GROK_FRONTIER_MODEL, effort: 'medium' },
    // Gemini 3.8 Flash > 3.1 Pro em código/agentic (TB2.1 81,3 × 70,8, Vals;
    // índice AA 41 × 30) a ~1/3 do preço. A tabela pedia 3.1-pro-high e o
    // spawn migrava para este id em silêncio (F-586) — agora é explícito.
    // F-705: o esforço mora no sufixo do id — -high com --effort medium
    // derrubava o pane ("conflicts with --effort=medium").
    { adapterId: 'agy', model: 'gemini-3.8-flash-medium', effort: 'medium' },
    { adapterId: 'codex', model: 'gpt-6-luna', effort: 'medium' },
    { adapterId: 'codex', model: 'gpt-5.6-luna', effort: 'medium' },
    { adapterId: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' },
    { adapterId: 'claude', model: 'claude-sonnet-5', effort: 'medium' },
    // Catálogo builtin: priors de capacidade, não notas de benchmark.
    // Auth/modelos disponíveis continuam filtrados antes da escolha.
    { adapterId: 'devin', model: 'swe-2-medium' },
    { adapterId: 'muse', model: 'muse-spark-1.3' },
    { adapterId: 'muse-claude', model: 'muse-spark-1.3' },
    { adapterId: 'openclaude', model: 'sonnet' },
    { adapterId: 'aider', model: 'claude-sonnet-5' },
    { adapterId: 'opencode', model: 'openrouter/anthropic/claude-sonnet-5' },
  ],
  hard: [
    { adapterId: 'claude', model: 'claude-opus-5-5', effort: 'high' },
    // Fallback para CLI claude sem o 5.5: Opus 5 (TB4.0 52,3%) antes do 4.8,
    // mesmo preço ($5/$25).
    { adapterId: 'claude', model: 'claude-opus-5', effort: 'high' },
    { adapterId: 'claude', model: 'claude-opus-4-8', effort: 'high' },
    // Topo fora da ordem padrão do hard: só sobe via frontierRoutePolicy
    // (revisão cruzada; risco alto). Fable 5.1 gasta até 50% da cota
    // semanal do Max e perde do Opus 5.5 no TB4 — não é o default.
    { adapterId: 'claude', model: 'claude-fable-5-1', effort: 'high' },
    { adapterId: 'glm', model: 'glm-5.3', effort: 'high' },
    { adapterId: 'longcat', model: 'LongCat-2.0', effort: 'high' },
    { adapterId: 'deepseek', model: 'deepseek-v4-pro', effort: 'high' },
    // F-238: Qwen 3.8 Max no hard — prior de custo/capacidade, sem nota
    // oficial publicada (UNPUBLISHED_ROUTE_MODELS).
    { adapterId: 'qwen', model: 'qwen3.8-max', effort: 'high' },
    { adapterId: 'codex', model: CODEX_FRONTIER_MODEL, effort: 'high' },
    // CLI sem o 6.1 ainda roteia para o GPT-6 Sol (superseded ≠ retired).
    { adapterId: 'codex', model: 'gpt-6-sol', effort: 'high' },
    // F-700: o GPT-6 Astra saiu da rota automática. É caso raro, só pelo
    // nome ("com o Astra", mentionedRoute). Com o Claude reservado ao Maestro,
    // a regra de topo punha o Astra em 20 de 76 workers num dia (toda revisão
    // e todo critical). Ele custa $10/$50 e perde do Sol 6.1 no DeepSWE
    // (74,1 × 75,2).
    { adapterId: 'codex', model: 'gpt-5.6-sol', effort: 'high' },
    { adapterId: 'codex', model: 'gpt-5.6-terra', effort: 'high' },
    // Gemini 4 Argon (Google, 30/09): geração nova entra sempre; só roda se
    // a conta tiver acesso (Fairwind→Ultra→API) — sem acesso, quarentena.
    { adapterId: 'agy', model: 'gemini-4-argon', effort: 'high' },
    { adapterId: 'agy', model: 'gemini-3.8-flash-high', effort: 'high' },
    { adapterId: 'kimi', model: 'kimi-code/k3', effort: 'high' },
    { adapterId: 'grok', model: GROK_FRONTIER_MODEL, effort: 'high' },
    { adapterId: 'mimo-code', model: 'xiaomi/mimo-v2.6-pro' },
    { adapterId: 'mimo-code', model: 'xiaomi/mimo-v2.6-pro-ultraspeed' },
    { adapterId: 'minimax-code', model: 'minimax/MiniMax-M3.1-Flash-Preview' },
    { adapterId: 'minimax-code', model: 'minimax/MiniMax-M3' },
    { adapterId: 'devin', model: 'swe-2-high' },
    { adapterId: 'openclaude', model: 'opus' },
    { adapterId: 'aider', model: 'claude-opus-4-8' },
    { adapterId: 'opencode', model: 'openrouter/anthropic/claude-opus-4.8' },
    // F-696: Muse Spark 1.3 (free, DeepSWE 75,4 / TB2.1 88,8) em todo tier.
    { adapterId: 'muse', model: 'muse-spark-1.3' },
  ],
  critical: [
    // Opus 5.5 lidera o TB4.0 (66,4% — Anthropic 2026-09-22) e custa menos
    // que Fable 5.1 (55,8%, $10/$50). claude-fable-5 era api-only: nunca
    // roteava, só ocupava a 1ª linha.
    { adapterId: 'claude', model: 'claude-opus-5-5', effort: 'xhigh' },
    { adapterId: 'claude', model: 'claude-fable-5-1', effort: 'xhigh' },
    { adapterId: 'claude', model: 'claude-opus-5', effort: 'xhigh' },
    { adapterId: 'claude', model: 'claude-opus-4-8', effort: 'xhigh' },
    // F-700: sem o GPT-6 Astra (só pelo nome, ver o hard).
    { adapterId: 'codex', model: CODEX_FRONTIER_MODEL, effort: 'xhigh' },
    // Mesmo fallback do hard para CLI sem o 6.1.
    { adapterId: 'codex', model: 'gpt-6-sol', effort: 'xhigh' },
    { adapterId: 'codex', model: 'gpt-5.6-sol', effort: 'xhigh' },
    { adapterId: 'codex', model: 'gpt-5.6-terra', effort: 'xhigh' },
    { adapterId: 'glm', model: 'glm-5.3', effort: 'xhigh' },
    // Diversidade também no crítico: sem estes, uma máquina sem claude/codex/
    // glm empresta de outro tier e o worker crítico colapsa num só provider.
    // agy antes de kimi preserva a preferência efetiva anterior (o empréstimo
    // do tier hard escolhia o agy quando ambos instalados).
    // O AGY não tem xhigh: o topo dele é a variante -high (F-705).
    { adapterId: 'agy', model: 'gemini-3.8-flash-high', effort: 'high' },
    { adapterId: 'kimi', model: 'kimi-code/k3', effort: 'xhigh' },
    { adapterId: 'mimo-code', model: 'xiaomi/mimo-v2.6-pro' },
    { adapterId: 'mimo-code', model: 'xiaomi/mimo-v2.6-pro-ultraspeed' },
    { adapterId: 'minimax-code', model: 'minimax/MiniMax-M3.1-Flash-Preview' },
    { adapterId: 'minimax-code', model: 'minimax/MiniMax-M3' },
    // F-696: Muse Spark 1.3 (free, DeepSWE 75,4 / TB2.1 88,8) em todo tier.
    { adapterId: 'muse', model: 'muse-spark-1.3' },
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
  'diagnos', 'diagnós', 'investig', 'root cause', 'causa raiz',
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

export const TIER_ORDER: TaskTier[] = [
  'trivial',
  'easy',
  'medium',
  'hard',
  'critical',
];

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
  // Permissão de escrita não mede dificuldade: uma investigação read-only
  // pode exigir tanto raciocínio quanto uma alteração de código.
  const text = taskText.toLowerCase().replace(
    /\bread[ -]only\b|\b(?:somente|apenas)\s+leitura\b/gu, ' ',
  );
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

  // Revisão de código é raciocínio sobre o trabalho de outro modelo, não
  // inspeção (27/09: "revisão sênior, somente leitura" caiu em trivial →
  // grok low, e a política de modelos de topo nem foi consultada).
  const floor = codeReviewTierFloor(text);
  if (floor && TIER_ORDER.indexOf(tier) < TIER_ORDER.indexOf(floor)) {
    tier = floor;
    signals = matchSignals(text, REVIEW_SIGNALS);
  }

  return { tier, signals };
}

/**
 * Quando usar os modelos de topo (docs/models/estudo-2026-09.md §6). A tabela
 * já abre hard/critical no Opus 5.5 e critical no GPT-6 Astra; esta política
 * só REORDENA modelos dentro do mesmo adapter — nunca troca o adapter líder
 * nem puxa topo para tiers baixos (trivial/easy/medium seguem eficientes):
 *  - cross-review (revisão em hard/critical): modelo de topo diferente do
 *    autor padrão (Opus 5.5) → Astra no codex e Fable 5.1 no claude. O
 *    revisor automático já espalha o quórum por vendors (Anthropic × OpenAI).
 *  - high-risk (critical, ou hard com segurança/bug/arquitetura/integração):
 *    Astra passa o Sol no codex; no claude o Opus 5.5 segue na frente.
 * Por assinatura o custo é cota, não API: Astra e Fable queimam a cota do
 * plano mais rápido (Fable: até 50% da semanal no Max), por isso não viram
 * default do hard comum. Adapter com cota esgotada já sai antes do router
 * (quota auto-exclude em tools-domain).
 */
export type FrontierRoutePolicy = 'cross-review' | 'high-risk';

const REVIEW_SIGNALS = [
  'review', 'revis', 'cross-review', 'code review',
  // F-233 (regra do operador, 01/10): julgamento/veredito também é revisão —
  // auditoria e "aprove ou rejeite" não podem cair em modelo barato.
  'auditoria', 'audit', 'veredito', 'parecer', 'julgue', 'julgar',
  'aprovar ou', 'aprove ou', 'approve or', 'quality assurance', ' qa ',
  'segunda opinião', 'second opinion', 'avalie a entrega', 'avaliar a entrega',
  'valide a entrega', 'validar a entrega',
];

/**
 * Piso de tier para revisão de código: `hard`, para a política de topo
 * (cross-review) valer. Revisar texto/README/label (sinal easy) segue barato.
 * Vale para a heurística e para o tier do Jev; o tier do CHAMADOR não passa
 * por aqui (quem já sabe a complexidade continua mandando).
 */
/**
 * Contexto de CÓDIGO: o piso é para revisão de código/diff/branch. "Revisar a
 * lista de compras" ou "revisar o texto do README" seguem no tier normal;
 * palavras incidentais (CSS, logs, "não altere o README") não cancelam um
 * code review explícito (Astra, 28/09).
 */
const REVIEW_CODE_SIGNALS = [
  'código', 'codigo', 'code', 'diff', 'pull request', 'branch', 'commit',
  'merge', 'patch', 'release', 'implementa', 'refator', 'refactor', 'bug',
  'teste', 'test', 'arquivo', 'file', 'função', 'funcao', 'function', 'classe',
  'módulo', 'modulo', 'module', 'api', 'sql', 'css', 'html', 'script',
  'componente', 'component', 'sênior', 'senior', 'staff', 'arquitetura',
  'architecture', 'repositório', 'repositorio', 'repo',
];

export function codeReviewTierFloor(taskText: string): TaskTier | null {
  const text = taskText.toLowerCase();
  if (matchSignals(text, REVIEW_SIGNALS).length === 0) return null;
  if (matchSignals(text, REVIEW_CODE_SIGNALS).length === 0) return null;
  return 'hard';
}

export function raiseToTierFloor(tier: TaskTier, floor: TaskTier | null): TaskTier {
  return floor && TIER_ORDER.indexOf(tier) < TIER_ORDER.indexOf(floor) ? floor : tier;
}

const HIGH_RISK_SIGNALS = [
  'arquitetura', 'architecture', 'redesign', 'design de sistema',
  'system design', 'distributed', 'distribuído', 'distribuido',
  'integração', 'integracao', 'integration', 'race', 'root cause',
  'causa raiz',
];

export const FRONTIER_ORDER: Readonly<Record<FrontierRoutePolicy, readonly string[]>> = {
  'cross-review': ['claude-fable-5-1', 'claude-opus-5-5'],
  'high-risk': ['claude-opus-5-5', 'claude-fable-5-1'],
};

/**
 * Lane visual (regra do operador, 30/09): trabalho de UI/design sempre vai
 * para os modelos de topo — Opus 5.5 e Sonnet 5.5 lideram (superam até o
 * Astra, palavra do operador), depois Sol 6.1; o Astra entra por escolha
 * explícita do operador para UI (a proibição do F-700 vale para a rota
 * automática geral), mas fica por último: `gpt-6-sol` é o fallback para ele
 * não vencer por eliminação quando a missão já tirou o Claude do pool.
 */
export const VISUAL_FRONTIER_LANE: ReadonlyArray<{
  adapterId: string;
  model: string;
}> = Object.freeze([
  { adapterId: 'claude', model: 'claude-opus-5-5' },
  { adapterId: 'claude', model: 'claude-sonnet-5-5' },
  { adapterId: 'codex', model: 'gpt-6.1-sol' },
  { adapterId: 'codex', model: 'gpt-6-sol' },
  { adapterId: 'codex', model: 'gpt-6-astra' },
]);

/**
 * Lane de julgamento (regra do operador, 01/10): revisão/auditoria/veredito
 * só com modelos de ponta — GLM/MiMo davam "veredito APROVAR" em revisão de
 * código. Fable 5.1 lidera (cross-review clássico), depois Opus/Sonnet e os
 * Codex Sol/Astra.
 */
export const JUDGE_FRONTIER_LANE: ReadonlyArray<{
  adapterId: string;
  model: string;
}> = Object.freeze([
  { adapterId: 'claude', model: 'claude-fable-5-1' },
  { adapterId: 'claude', model: 'claude-opus-5-5' },
  { adapterId: 'claude', model: 'claude-sonnet-5-5' },
  { adapterId: 'codex', model: 'gpt-6.1-sol' },
  { adapterId: 'codex', model: 'gpt-6-astra' },
]);

/**
 * F-234: juiz que satisfaz o portão de integração — o par (adapter, model)
 * casa com um assento da {@link JUDGE_FRONTIER_LANE} por LINHA (a mesma salva
 * do `applyFrontierLane`: `claude-opus-5-6` conta como linha do opus 5-5).
 * Sem modelo (`undefined`) nunca é ponta — identidade incerta não julga.
 */
export function isFrontierReviewer(
  adapterId: string,
  model: string | undefined,
): boolean {
  if (model === undefined) return false;
  return JUDGE_FRONTIER_LANE.some(
    (seat) =>
      seat.adapterId === adapterId && isSameLineAtLeast(model, seat.model),
  );
}

export function frontierRoutePolicy(
  taskText: string,
  tier: TaskTier,
  specialty: RouteSpecialty,
): { policy: FrontierRoutePolicy; signals: string[] } | null {
  if (tier !== 'hard' && tier !== 'critical') return null;
  const text = taskText.toLowerCase();
  const review = matchSignals(text, REVIEW_SIGNALS);
  if (review.length > 0) return { policy: 'cross-review', signals: review };
  if (tier === 'critical') return { policy: 'high-risk', signals: ['critical'] };
  if (specialty === 'security' || specialty === 'bug') {
    return { policy: 'high-risk', signals: [specialty] };
  }
  const risk = matchSignals(text, HIGH_RISK_SIGNALS);
  return risk.length > 0 ? { policy: 'high-risk', signals: risk } : null;
}

/** Reordena os modelos de cada adapter; as posições de adapter não mudam. */
function frontierFirst(list: readonly RouteCandidate[], order: readonly string[]): RouteCandidate[] {
  const rank = (c: RouteCandidate) => {
    const index = order.indexOf(c.model ?? '');
    return index < 0 ? order.length : index;
  };
  const byAdapter = new Map<string, RouteCandidate[]>();
  for (const c of list) {
    const entries = byAdapter.get(c.adapterId) ?? [];
    entries.push(c);
    byAdapter.set(c.adapterId, entries);
  }
  for (const entries of byAdapter.values()) entries.sort((a, b) => rank(a) - rank(b));
  const cursor = new Map<string, number>();
  return list.map((c) => {
    const index = cursor.get(c.adapterId) ?? 0;
    cursor.set(c.adapterId, index + 1);
    return byAdapter.get(c.adapterId)![index];
  });
}

export interface AdapterAvailability {
  id: string;
  installed: boolean;
  /** Optional resolved model list; when present, candidates outside it are skipped. */
  models?: string[];
  /** Live native capabilities; [] = no effort control, absent = bundled contract. */
  efforts?: readonly string[];
}

const BUNDLED_EFFORTS = new Map(BUILTIN_ADAPTERS.map((raw) => {
  const adapter = adapterSchema.parse(raw);
  return [adapter.id, adapter.kind === 'cli-pty' ? adapter.control?.effort?.levels ?? [] : []];
}));

function effortForTier(tier: TaskTier): RouteEffort {
  return tier === 'critical' ? 'xhigh' : tier === 'hard' ? 'high' : tier === 'medium' ? 'medium' : 'low';
}

/**
 * Modelo e esforço citados no texto da tarefa ("com o GPT-6 Astra, esforço
 * xhigh") são a escolha explícita de quem pediu. Um id completo casa direto;
 * senão, um token distintivo que identifica UM modelo do inventário (astra,
 * fable, luna…). Ambíguo ("Astra e Fable") → nada. Só CLIs instaladas
 * contam; modelo de CLI ausente vira `unavailable`, para a decisão dizer por
 * que não foi honrado.
 */
export interface MentionedRoute {
  model?: { adapterId: string; model: string };
  effort?: RouteEffort;
  unavailable?: string;
}

const MENTION_GENERIC_TOKENS = new Set([
  'code', 'flash', 'fast', 'high', 'medium', 'low', 'xhigh', 'mini', 'pro',
  'preview', 'latest', 'chat', 'instruct', 'thinking', 'lite', 'plus', 'turbo',
  'ultra', 'ultraspeed', 'highspeed', 'build', 'coder', 'default', 'beta', 'max',
]);

/** "não use o Astra" / "without Fable": citado para EXCLUIR. */
const MENTION_NEGATIONS = new Set([
  'não', 'nao', 'nunca', 'sem', 'evite', 'evitar', 'exceto',
  'not', 'never', 'no', 'without', 'avoid', 'except',
]);

/** "compare o Astra com o Fable": conteúdo comparado, não escolha. */
const MENTION_COMPARISONS = new Set([
  'compare', 'comparar', 'compara', 'comparando', 'comparação', 'comparacao',
  'comparison', 'versus', 'vs', 'contra',
]);

/**
 * Sem uma destas antes do nome, o modelo é conteúdo da tarefa ("revise o diff
 * produzido pelo GPT-6 Astra"), não a escolha de quem pediu.
 */
const MENTION_SELECTION_CUES = new Set([
  'com', 'use', 'usa', 'usar', 'usando', 'utilize', 'utilizar', 'utilizando',
  'via', 'rode', 'rodar', 'rodando', 'execute', 'executar', 'modelo', 'model',
  'prefira', 'preferir', 'escolha', 'escolher', 'selecione',
  'with', 'using', 'run', 'prefer', 'choose', 'pick', 'select',
]);

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Até 5 palavras antes de `index` (o contexto que diz se é escolha, negação ou comparação). */
function wordsBefore(text: string, index: number): string[] {
  return text
    .slice(Math.max(0, index - 64), index)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .slice(-5);
}

/**
 * Grafia humana de uma sequência de tokens do id: "gpt-6-astra" casa
 * "GPT-6 Astra", "gpt 6 astra" e "gpt-6-astra" (um separador opcional entre
 * tokens), nunca dentro de outra palavra.
 */
function tokenSequenceMatcher(tokens: readonly string[]): RegExp {
  return new RegExp(`(?<![a-z0-9])${tokens.map(escapeRegExp).join('[^a-z0-9]?')}(?![a-z0-9])`, 'gu');
}

interface MentionHit {
  readonly adapterId: string;
  readonly model: string;
  readonly installed: boolean;
  readonly start: number;
  readonly end: number;
  /** Tokens do id casados: mais tokens = menção mais específica (fable-5-1 > fable-5). */
  readonly count: number;
}

function mentionsAdapter(text: string, adapterId: string): boolean {
  const first = adapterId.split(/[^a-z0-9]+/)[0] ?? adapterId;
  return [adapterId, first].some((name) => tokenSequenceMatcher([name]).test(text));
}

/**
 * Modelo e esforço citados no texto da tarefa como ESCOLHA de quem pediu ("com
 * o GPT-6 Astra, esforço xhigh"). Regras: id completo ou sua grafia humana, ou
 * um token que identifica UM modelo entre as CLIs instaladas (astra, fable,
 * luna…); precisa de uma palavra de escolha antes (com/use/modelo/with…), e
 * negação ou comparação no mesmo trecho anulam. Menções sobrepostas são a
 * mesma (fica a mais específica); menções distintas ("Astra e Fable") não
 * escolhem nada. Só CLIs instaladas são escolhidas; provider citado
 * desempata; modelo só de CLI ausente vira `unavailable`, para a decisão dizer
 * por que não foi honrado.
 */
export function mentionedRoute(
  taskText: string,
  adapters: readonly AdapterAvailability[],
): MentionedRoute {
  const text = taskText.toLowerCase();
  const out: MentionedRoute = {};
  const rejectedContext = (index: number): boolean => {
    const before = wordsBefore(text, index);
    return before.some((word) => MENTION_NEGATIONS.has(word) || MENTION_COMPARISONS.has(word));
  };
  for (const match of text.matchAll(
    /(?<![\p{L}])(?:esfor[çc]o|effort)\s*[:=]?\s*(low|medium|high|xhigh)(?![\p{L}])/gu,
  )) {
    if (rejectedContext(match.index)) continue;
    out.effort = match[1] as RouteEffort;
    break;
  }
  const entries = adapters.flatMap((adapter) =>
    (adapter.models ?? []).map((model) => ({
      adapterId: adapter.id,
      model,
      installed: adapter.installed,
      tokens: model.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean),
    })),
  );
  // Token isolado só identifica um modelo se for único entre as CLIs INSTALADAS
  // (o "astra" das variantes do Devin não instalado não tira o do Codex).
  const installedOwners = new Map<string, number>();
  for (const entry of entries) {
    if (!entry.installed) continue;
    for (const token of new Set(entry.tokens)) {
      installedOwners.set(token, (installedOwners.get(token) ?? 0) + 1);
    }
  }
  const nameLike = (token: string): boolean =>
    token.length >= 4 && !/^\d/.test(token) && !MENTION_GENERIC_TOKENS.has(token);
  const distinctiveAlone = (token: string): boolean =>
    nameLike(token) && installedOwners.get(token) === 1;
  const selected = (index: number): boolean => {
    const before = wordsBefore(text, index);
    if (before.some((word) => MENTION_NEGATIONS.has(word) || MENTION_COMPARISONS.has(word))) return false;
    return before.some((word) => MENTION_SELECTION_CUES.has(word));
  };
  const hits: MentionHit[] = [];
  // Nome de família citado como escolha ("com o Fable") que não identifica um
  // modelo entre os instalados: conta como menção que ambiguiza o resto.
  const familyMentions: Array<{ start: number; end: number }> = [];
  for (const entry of entries) {
    let best: { start: number; end: number; count: number } | null = null;
    // Sequências candidatas: sufixos com ≥2 tokens ("fable 5 1", "6 astra") e
    // cada token de nome sozinho ("astra", "fable") em qualquer posição.
    const sequences: string[][] = [];
    for (let from = 0; from + 2 <= entry.tokens.length; from += 1) {
      const suffix = entry.tokens.slice(from);
      if (suffix.some((token) => /^[a-z]{3,}$/.test(token) && !MENTION_GENERIC_TOKENS.has(token))) {
        sequences.push(suffix); // "5 1" ou "flash high" não nomeiam um modelo
      }
    }
    for (const token of new Set(entry.tokens)) {
      if (!nameLike(token)) continue;
      if (distinctiveAlone(token)) {
        sequences.push([token]);
      } else if (entry.installed) {
        for (const match of text.matchAll(tokenSequenceMatcher([token]))) {
          if (selected(match.index)) familyMentions.push({ start: match.index, end: match.index + match[0].length });
        }
      }
    }
    for (const sequence of sequences) {
      for (const match of text.matchAll(tokenSequenceMatcher(sequence))) {
        if (!selected(match.index)) continue;
        if (!best || sequence.length > best.count) {
          best = { start: match.index, end: match.index + match[0].length, count: sequence.length };
        }
      }
    }
    if (best) hits.push({ adapterId: entry.adapterId, model: entry.model, installed: entry.installed, ...best });
  }
  if (hits.length === 0) return out;
  // "com o Astra e com o Fable": o Fable não resolve a um modelo, mas é uma
  // segunda escolha — nada é pinado.
  if (familyMentions.some((family) => !hits.some((hit) => hit.start < family.end && family.start < hit.end))) {
    return out;
  }
  // Acertos sobrepostos são a MESMA menção (claude-fable-5 dentro de "Fable 5.1").
  const regions: MentionHit[][] = [];
  for (const hit of [...hits].sort((a, b) => a.start - b.start)) {
    const region = regions.find((group) => group.some((other) => other.start < hit.end && hit.start < other.end));
    if (region) region.push(hit);
    else regions.push([hit]);
  }
  const resolved: MentionHit[] = [];
  for (const region of regions) {
    const longest = Math.max(...region.map((hit) => hit.count));
    let pool = region.filter((hit) => hit.count === longest);
    if (pool.some((hit) => hit.installed)) pool = pool.filter((hit) => hit.installed);
    if (pool.length > 1) {
      const named = pool.filter((hit) => mentionsAdapter(text, hit.adapterId));
      if (named.length > 0) pool = named;
    }
    if (new Set(pool.map((hit) => `${hit.adapterId}:${hit.model}`)).size !== 1) return out;
    resolved.push(pool[0]!);
  }
  if (new Set(resolved.map((hit) => `${hit.adapterId}:${hit.model}`)).size !== 1) return out;
  const [hit] = resolved;
  if (hit!.installed) out.model = { adapterId: hit!.adapterId, model: hit!.model };
  else out.unavailable = `${hit!.adapterId}:${hit!.model}`;
  return out;
}

/** Automatic routes never claim a knob the CLI cannot receive. */
function nativeRouteEffort(effort: RouteEffort, adapter: AdapterAvailability): RouteEffort | undefined {
  const levels = adapter.efforts ?? BUNDLED_EFFORTS.get(adapter.id) ?? [];
  if (levels.includes(effort)) return effort;
  const supported = ROUTE_EFFORTS.filter((level) => levels.includes(level));
  // Clamp to the nearest supported depth, respecting the CLI's minimum too.
  return supported.filter((level) => ROUTE_EFFORTS.indexOf(level) <= ROUTE_EFFORTS.indexOf(effort)).at(-1)
    ?? supported[0];
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
    // F-249: "reservado ao Maestro/sem credencial" não é "não instalado" — o
    // Maestro lia o rótulo fundido e reportava "sem login" para uma conta
    // logada. O pool já filtrou o adapter antes desta lista, então a ausência
    // aqui não distingue o motivo exato: o rótulo tem de admitir os dois.
    if (!info) {
      fates.push(`${id}=fora do pool (reservado/indisponível)`);
    } else if (!info.installed) {
      fates.push(`${id}=não instalado`);
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
  /**
   * F-233: a tarefa pede julgamento (revisão/veredito) e nenhum modelo de
   * ponta da lane está disponível — o Maestro julga no próprio pane.
   */
  judgeUnavailable?: boolean;
}

type QualityDimension = 'coding' | 'reasoning' | 'frontend' | 'security';

function qualityDimension(specialty: RouteSpecialty, tier: TaskTier): QualityDimension {
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
 * (`gpt-5.6-luna`). Agora:
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
  const migrated = migrateModelId(requested);
  if (migrated && migrated !== requested) {
    return resolveRoutableModel(migrated, available);
  }
  if (!available || available.length === 0) return { ok: true, model: requested };
  if (available.includes(requested)) return { ok: true, model: requested };
  const variant = available.find((model) =>
    isRoutableModelResolution(requested, model),
  );
  return variant ? { ok: true, model: variant } : { ok: false };
}

const warnedMissingRoutes = new Set<string>();

/**
 * Tabela velha visível em runtime: um candidato cuja CLI instalada não lista
 * o modelo roteado é descartado (nunca cai no default silencioso), mas o
 * operador precisa SABER — senão o roteador "pensa" que escolhe um modelo
 * que a máquina não roda. Loga uma vez por adapter:modelo e devolve a nota
 * que entra no `reason` da decisão.
 */
function warnRoutedModelsMissingFromCli(missing: readonly string[]): string {
  const unique = [...new Set(missing)];
  if (unique.length === 0) return '';
  for (const key of unique) {
    if (warnedMissingRoutes.has(key)) continue;
    warnedMissingRoutes.add(key);
    console.warn(
      `[task-router] modelo roteado ausente da lista da CLI instalada: ${key} ` +
      '(tabela de roteamento desatualizada ou modelo sem auth) — candidato ignorado',
    );
  }
  return `; CLI sem o modelo roteado: ${unique.slice(0, 3).join(', ')}`;
}

function evaluatedCandidates(
  specialty: RouteSpecialty,
  tier: TaskTier,
  available: ReadonlyMap<string, AdapterAvailability>,
  catalog: ModelCatalog,
): RouteCandidate[] {
  const dimension = qualityDimension(specialty, tier);
  const effort = effortForTier(tier);
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
  const mention = mentionedRoute(taskText, adapters);
  const requestedEffort = mention.effort ?? context.effortOverride ?? effortForTier(tier);
  const effortFor = (adapterId: string) => nativeRouteEffort(requestedEffort, available.get(adapterId)!);
  const effortNoteFor = (adapterId: string) =>
    `; effort=${effortFor(adapterId) ?? 'cli-default'} requested=${requestedEffort}` +
    ` source=${mention.effort ? 'texto' : context.effortOverride ? 'jev' : 'tier'}`;
  const heuristicSpecialty = classifyRouteSpecialty(taskText);
  const specialtyVerdict = context.specialtyOverride
    ? {
        ...heuristicSpecialty,
        specialty: context.specialtyOverride,
        reason: `especialidade julgada pelo Jev (heurística: ${heuristicSpecialty.specialty})`,
      }
    : heuristicSpecialty;
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
    ? evaluatedCandidates(specialtyVerdict.specialty, tier, available, modelCatalog)
    : [];
  const why =
    classification.signals.length > 0
      ? `sinais: ${classification.signals.slice(0, 5).join(', ')}`
      : 'sem sinais fortes — tier padrão pelo tamanho da tarefa';

  const frontier = frontierRoutePolicy(taskText, tier, specialtyVerdict.specialty);
  const routingTable: RoutingTable = frontier
    ? (Object.fromEntries(
        TIER_ORDER.map((t) => [t, frontierFirst(table[t], FRONTIER_ORDER[frontier.policy])]),
      ) as RoutingTable)
    : table;
  const frontierNote = frontier
    ? `; topo=${frontier.policy} (${frontier.signals.slice(0, 3).join(', ')})`
    : '';

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
  const missingFromCli: string[] = [];
  const lineUpgrades: string[] = [];
  // F-217 (regra do operador 29/09): a CLI anuncia modelos que ninguém
  // catalogou ainda. Entre os elegíveis (não bloqueados pelo catálogo nem
  // recusados pelo provider), o mais novo DA MESMA LINHA substitui o modelo
  // roteado — e resgata um modelo da tabela que a CLI já não lista.
  const eligibleByAdapter = new Map<string, readonly string[]>();
  const eligibleModels = (adapter: AdapterAvailability): readonly string[] => {
    const cached = eligibleByAdapter.get(adapter.id);
    if (cached) return cached;
    const eligible = (adapter.models ?? []).filter(
      (model) =>
        !isModelBlockedForAutoRouting(
          modelCatalogInfo(modelCatalog, adapter.id, model),
        ) && !modelAccessQuarantine(adapter.id, model),
    );
    eligibleByAdapter.set(adapter.id, eligible);
    return eligible;
  };
  for (const candidateTier of searchOrder) {
    const tierCandidates = routingTable[candidateTier]
      .flatMap((c) => {
        const adapter = available.get(c.adapterId);
        if (!adapter) return [];
        // Resolve o modelo da tabela para um que o adapter REALMENTE roda
        // (variante de família quando a geração foi renomeada). Sem família
        // disponível, descarta — nunca cai no default silencioso do CLI.
        const eligible = eligibleModels(adapter);
        const resolved = resolveRoutableModel(c.model, adapter.models);
        if (!resolved.ok) {
          const newer = c.model ? newestInModelLine(c.model, eligible) : undefined;
          if (!newer || newer === c.model) {
            missingFromCli.push(`${c.adapterId}:${c.model}`);
            return [];
          }
          lineUpgrades.push(`${c.adapterId}:${c.model}→${newer}`);
          return [{ ...c, model: newer }];
        }
        const upgraded =
          resolved.model !== undefined
            ? newestInModelLine(resolved.model, eligible)
            : resolved.model;
        if (upgraded !== resolved.model) {
          lineUpgrades.push(`${c.adapterId}:${resolved.model}→${upgraded}`);
        }
        const routed: RouteCandidate = { ...c, model: upgraded };
        const info = modelCatalogInfo(modelCatalog, routed.adapterId, routed.model);
        if (isModelBlockedForAutoRouting(info)) {
          skippedRisk.push(
            `${routed.adapterId}:${routed.model ?? '(default)'} (${info?.availability ?? 'blocked'})`,
          );
          return [];
        }
        // F-683: provider recusou este modelo há pouco (acesso desligado).
        if (modelAccessQuarantine(routed.adapterId, routed.model)) {
          skippedRisk.push(
            `${routed.adapterId}:${routed.model ?? '(default)'} (recusado pelo provider)`,
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

  // Uso geral: só um benchmark de especialidade MEDIDO reordena a tabela.
  // `context.preferAdapters` é soft (bônus +4 no multi-score) e a heurística
  // de especialidade não carrega providers — a qualidade vem dos benchmarks
  // oficiais publicados, não de uma lista fixa de CLIs.
  const prependIds =
    policy.source === 'benchmark' ? policy.preferAdapterIds : [];
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
    anyCircuitOpen ||
    context.multiScore === true ||
    (context.multiScore !== false && hasMissionHistory);
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
  let tieBreakNote = '';
  if (context.tieBreakUseCounts && ranked.length > 1 &&
      policy.source !== 'benchmark' && evaluated.length === 0) {
    const tie = tieBreakByUse({
      ranked,
      useCounts: context.tieBreakUseCounts,
      tier,
      modelCatalog,
      context,
      circuitOpen: (id) => adapterCircuitBreakers.isOpen(id),
    });
    ranked = tie.ranked;
    tieBreakNote = tie.note;
  }

  // F-214: cross-review e critical valem o topo ENTRE CLIs — o frontierFirst
  // da tabela só reordena dentro de cada adapter e, com os benchmarks
  // oficiais saturados, custo/uso do multi-score deixava um modelo barato à
  // frente do frontier (MiMo Pro sobre o Astra na revisão de 29/09). Os
  // modelos da ordem sobem na ordem dela; o resto mantém a ordem relativa.
  // Hard high-risk sem revisão fica como está (só dentro do adapter).
  let crossCliNote = '';
  // F-233: cross-review saiu daqui — virou a lane de julgamento abaixo. O
  // topo entre CLIs agora vale só para high-risk/critical.
  if (frontier?.policy === 'high-risk') {
    const order = FRONTIER_ORDER['high-risk'];
    // F-217: o candidato pode ter subido para a versão mais nova da mesma
    // linha (ex.: a CLI anuncia claude-opus-5-6 e a tabela pede o 5-5) — a
    // vaga de topo é da LINHA, então a ordem casa por linha, não por id.
    const orderIndex = (model: string | undefined): number =>
      model === undefined
        ? -1
        : order.findIndex((ref) => isSameLineAtLeast(model, ref));
    const head = ranked.filter((r) => orderIndex(r.c.model) >= 0);
    if (head.length > 0) {
      const next = [
        ...[...head].sort(
          (a, b) => orderIndex(a.c.model) - orderIndex(b.c.model),
        ),
        ...ranked.filter((r) => orderIndex(r.c.model) < 0),
      ];
      if (next[0].c !== ranked[0].c) crossCliNote = `; topo entre CLIs (high-risk)`;
      ranked = next;
    }
  }

  // Lanes de topo (regras do operador, 30/09 e 01/10): a tabela do tier pode
  // não listar os modelos da lane (Astra só existe no catálogo, fora de
  // qualquer tier), então o candidato é injetado quando a CLI o anuncia e a
  // lane é promovida à frente do resultado do rerank. Dentro da lane, o
  // adapter MENOS usado na missão vai primeiro — N workers se distribuem
  // entre os de topo em vez de concentrarem no primeiro da lista.
  const applyFrontierLane = (
    lane: ReadonlyArray<{ adapterId: string; model: string }>,
  ): boolean => {
    const laneSeats: Array<{ lane: number; adapterId: string; model: string }> = [];
    lane.forEach((seat, laneIndex) => {
      const adapter = available.get(seat.adapterId);
      if (!adapter?.installed) return;
      const eligible = eligibleModels(adapter);
      const resolved = resolveRoutableModel(seat.model, adapter.models);
      // `resolved.ok` cobre o id exato; senão tenta o mais novo da MESMA
      // linha entre os elegíveis (mesma salva da tabela, :1030) — um id
      // mais novo promovido pela linha (gpt-6.2-sol) mantém o assento.
      const chosen = resolved.ok
        ? (newestInModelLine(resolved.model ?? seat.model, eligible) ?? resolved.model ?? seat.model)
        : newestInModelLine(seat.model, eligible);
      if (!chosen) return;
      // Lista de modelos exposta pela CLI: o modelo tem que estar nela.
      // Sem lista (contrato bundled), confia na lane como a tabela confia.
      if (adapter.models !== undefined && !eligible.includes(chosen)) return;
      if (
        isModelBlockedForAutoRouting(modelCatalogInfo(modelCatalog, seat.adapterId, chosen)) ||
        modelAccessQuarantine(seat.adapterId, chosen)
      ) return;
      laneSeats.push({ lane: laneIndex, adapterId: seat.adapterId, model: chosen });
      if (!ranked.some((r) => r.c.adapterId === seat.adapterId && r.c.model === chosen)) {
        ranked.push({ c: { adapterId: seat.adapterId, model: chosen }, fromTier: tier });
      }
    });
    const laneRank = (entry: RankedRouteEntry): number =>
      laneSeats.find(
        (seat) => seat.adapterId === entry.c.adapterId && seat.model === entry.c.model,
      )?.lane ?? -1;
    const inLane = ranked.filter(
      (entry) => laneRank(entry) >= 0 && !adapterCircuitBreakers.isOpen(entry.c.adapterId),
    );
    if (inLane.length === 0) return false;
    const set = new Set(inLane);
    const used = (entry: RankedRouteEntry) =>
      context.missionUseCounts?.get(entry.c.adapterId) ?? 0;
    ranked = [
      ...inLane.sort((a, b) => used(a) - used(b) || laneRank(a) - laneRank(b)),
      ...ranked.filter((entry) => !set.has(entry)),
    ];
    return true;
  };

  // Lane visual (regra do operador, 30/09): UI/design vai sempre para os
  // modelos de topo.
  let visualNote = '';
  if (
    specialtyVerdict.specialty === 'visual' &&
    policy.source !== 'benchmark' &&
    mention.model === undefined &&
    applyFrontierLane(VISUAL_FRONTIER_LANE)
  ) {
    visualNote = '; lane visual (modelos de topo)';
  }

  // Lane de julgamento (regra do operador, 01/10): cross-review (revisão,
  // auditoria, veredito) só é julgado por modelo de ponta. Sem assento de
  // lane, a rota segue no melhor barato e o Maestro é quem julga.
  let judgeNote = '';
  let judgeUnavailable = false;
  if (
    frontier?.policy === 'cross-review' &&
    policy.source !== 'benchmark' &&
    mention.model === undefined
  ) {
    if (applyFrontierLane(JUDGE_FRONTIER_LANE)) {
      judgeNote = '; lane de julgamento (modelos de ponta)';
    } else {
      judgeNote = '; sem juiz frontier disponível — o Maestro julga';
      judgeUnavailable = true;
    }
  }

  // Rotação garantida por missão (regra do operador, 29/09): uma missão deve
  // dar um assento a CADA adapter elegível antes de repetir qualquer um —
  // a diversidade proporcional (−18/assento) sozinha nunca alcança adapters
  // sem benchmark publicado quando há muitos com nota alta. Fora de alcance:
  // critical (o topo entre CLIs manda), menção explícita, escolha medida
  // (benchmark de especialidade / avaliação Nexus) e primeira reserva.
  let rotationNote = '';
  const usedInMission = new Set<string>([
    ...(context.missionUsedAdapters ?? []),
    ...(context.missionUseCounts?.keys() ?? []),
  ]);
  if (
    tier !== 'critical' &&
    frontier === null &&
    evaluated.length === 0 &&
    policy.source !== 'benchmark' &&
    specialtyVerdict.specialty !== 'visual' &&
    specialtyVerdict.specialty !== 'security' &&
    specialtyVerdict.specialty !== 'bug' &&
    mention.model === undefined &&
    usedInMission.size > 0 &&
    usedInMission.has(ranked[0]?.c.adapterId ?? '')
  ) {
    // Só rotaciona para um candidato do MESMO tier da tarefa — um assento
    // "fresco" emprestado de tier mais fraco derrubaria o trabalho (achado
    // da revisão: task hard → glm-flash[1m]).
    const fresh = ranked.find(
      (entry) =>
        entry.fromTier === tier &&
        !usedInMission.has(entry.c.adapterId) &&
        !adapterCircuitBreakers.isOpen(entry.c.adapterId),
    );
    if (fresh) {
      ranked = [fresh, ...ranked.filter((entry) => entry !== fresh)];
      rotationNote = `; rotação garantida: ${fresh.c.adapterId} ainda sem assento na missão`;
    }
  }

  // F-232: fair-share global (regra do operador, 01/10). A rotação por
  // missão cobre só quem disputa assento dentro dela; providers nunca
  // escolhidos ficavam com ZERO reservas em 7 dias. Quando o líder acumulou
  // uso global muito acima do menos usado do pool do tier, o menos usado
  // lidera — converge para uso igual sem pingue-pongue (FAIR_SHARE_GAP).
  // Mesmas exclusões da rotação por missão, e só quando ela NÃO venceu.
  let fairShareNote = '';
  if (
    rotationNote === '' &&
    context.globalUseCounts !== undefined &&
    tier !== 'critical' &&
    frontier === null &&
    evaluated.length === 0 &&
    policy.source !== 'benchmark' &&
    specialtyVerdict.specialty !== 'visual' &&
    specialtyVerdict.specialty !== 'security' &&
    specialtyVerdict.specialty !== 'bug' &&
    mention.model === undefined
  ) {
    const use = (id: string) => context.globalUseCounts!.get(id) ?? 0;
    const pool = ranked.filter(
      (entry) =>
        entry.fromTier === tier &&
        !adapterCircuitBreakers.isOpen(entry.c.adapterId),
    );
    const leader = ranked[0];
    if (leader && pool.length > 1) {
      const minUse = Math.min(...pool.map((entry) => use(entry.c.adapterId)));
      if (use(leader.c.adapterId) >= minUse + FAIR_SHARE_GAP) {
        // Primeiro no ranking entre os menos usados.
        const pick = pool.find((entry) => use(entry.c.adapterId) === minUse);
        if (pick && pick !== leader) {
          ranked = [pick, ...ranked.filter((entry) => entry !== pick)];
          fairShareNote =
            `; fair-share: ${pick.c.adapterId} (uso 7d ` +
            `${use(pick.c.adapterId)} × ${use(leader.c.adapterId)} do líder)`;
        }
      }
    }
  }

  let mentionNote = '';
  if (mention.model) {
    const { adapterId, model } = mention.model;
    const info = modelCatalogInfo(modelCatalog, adapterId, model);
    if (isModelBlockedForAutoRouting(info)) {
      mentionNote = `; modelo pedido no texto bloqueado: ${adapterId}:${model} (${info?.availability ?? 'blocked'})`;
    } else if (adapterCircuitBreakers.isOpen(adapterId)) {
      // A CLI acabou de falhar (cota/crash): pedir por nome não reabre o circuito.
      mentionNote = `; modelo pedido no texto em quarentena (circuit breaker): ${adapterId}:${model}`;
    } else {
      // F-218 (regra do operador 29/09): a menção continua vencendo as outras
      // rotas — mas o id pedido sobe para o mais novo da mesma linha que a
      // CLI oferece (menos bloqueados/quarentenados), como a tabela já faz.
      const adapter = available.get(adapterId);
      const upgraded = adapter
        ? newestInModelLine(model, eligibleModels(adapter))
        : model;
      if (upgraded !== model) {
        lineUpgrades.push(`${adapterId}:${model}→${upgraded}`);
      }
      ranked = [
        { c: { adapterId, model: upgraded, effort: effortFor(adapterId) }, fromTier: tier },
        ...ranked.filter((r) => !(r.c.adapterId === adapterId && r.c.model === upgraded)),
      ];
      mentionNote = `; modelo pedido no texto: ${adapterId}:${model}`;
    }
  } else if (mention.unavailable) {
    mentionNote = `; modelo pedido no texto indisponível: ${mention.unavailable}`;
  }

  const missingNote = warnRoutedModelsMissingFromCli(missingFromCli);
  const lineUpgradeNote =
    lineUpgrades.length > 0
      ? `; mais novo da linha: ${[...new Set(lineUpgrades)].slice(0, 3).join(', ')}`
      : '';

  if (ranked.length > 0) {
    let chosen = ranked[0];
    if (reserveClaude && chosen.c.adapterId === 'claude') {
      const alt = ranked.find((r) => r.c.adapterId !== 'claude');
      // ponytail: só claude instalado → sem alternativa, mantém claude (o
      // orquestrador serializa os workers claude nesse caso raro).
      if (alt) chosen = alt;
    }
    const pick = chosen.c;
    const effort = effortFor(pick.adapterId);
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
    const specialtyNote =
      `; specialty=${specialtyVerdict.specialty} source=${policySource}` +
      (context.specialtyOverride ? ` (${specialtyVerdict.reason})` : '');
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
      reason: `${tier}${borrowed}${specialtyNote}; ${why}${frontierNote}${mentionNote}${costNote}${evaluationNote}${riskNote}${missingNote}${lineUpgradeNote}${bandNote}${multiScoreNote}${tieBreakNote}${crossCliNote}${visualNote}${judgeNote}${rotationNote}${fairShareNote}${preferNote}${effortNoteFor(pick.adapterId)}`,
      alternatives: ranked.filter((r) => r.c !== pick).map(({ c }) => ({ ...c, effort: effortFor(c.adapterId) })),
      specialty: specialtyVerdict.specialty,
      policySource,
      ...(judgeUnavailable ? { judgeUnavailable } : {}),
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
    effort: effortFor(fallback),
    reason: `${tier}; specialty=${specialtyVerdict.specialty} source=${policy.source}; ${why}; nenhum candidato da tabela instalado — usando ${fallback} (menos usado na missão)${missingNote}${effortNoteFor(fallback)}`,
    alternatives: [],
    specialty: specialtyVerdict.specialty,
    policySource: policy.source,
    ...(judgeUnavailable ? { judgeUnavailable } : {}),
  };
}
