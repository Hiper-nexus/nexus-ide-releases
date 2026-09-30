import type {
  BusinessFlow,
  BusinessInvariant,
  BusinessModelDocument,
} from './business-model-contract';
import type { BusinessHurdle } from './business-model-hurdles';
import { capText, judge, USD_PER_INPUT_TOKEN, type JevQuestion } from '../../jev/jev-client';
import { isJevSurfaceEnabled } from '../../jev/jev-autopilot';
import { hasJevCredential } from '../../jev/jev-secrets';
import {
  jevAnswerConfidences,
  jevAnswerProbabilities,
  recordJevDecision,
} from '../../jev/jev-decision-log';

/**
 * SELEÇÃO por tarefa do modelo de negócio: quais fluxos, invariantes e hurdles
 * importam para ESTE pedido. O Jev (`businessModel` surface) julga cada
 * candidato como instrução estruturada; sem Jev (desligado, sem chave,
 * timeout, resposta malformada) o ranking lexical determinístico responde.
 * Contrato fail-open em ambos: nunca lança, nunca inventa item — a saída é
 * sempre um subconjunto do documento dado.
 *
 * Texto do repositório é DADO inerte: vai ao state do Jev e ao bloco como
 * conteúdo citado (arquivo:linha), nunca como instrução.
 */

export interface BusinessModelSelection {
  readonly flows: readonly BusinessFlow[];
  readonly invariants: readonly BusinessInvariant[];
  readonly hurdles: readonly BusinessHurdle[];
  /** 'jev' quando o modelo respondeu; 'lexical' no fallback determinístico. */
  readonly source: 'jev' | 'lexical';
  /** Conjunto de ids — o hook dedup entrega repetida por ele. */
  readonly key: string;
}

export interface SelectBusinessContextInput {
  /** O pedido (task/prompt) que o pane vai executar. */
  readonly task: string;
  readonly document: BusinessModelDocument;
  readonly hurdles: readonly BusinessHurdle[];
  readonly sessionId?: string;
  readonly missionId?: string;
  readonly maxFlows?: number;
  readonly maxInvariants?: number;
  readonly maxHurdles?: number;
}

export interface SelectBusinessContextDeps {
  readonly judge?: typeof judge;
  readonly surfaceEnabled?: (surface: 'businessModel') => boolean;
  readonly hasCredential?: () => boolean;
  readonly recordDecision?: typeof recordJevDecision;
}

const DEFAULT_MAX_FLOWS = 4;
const DEFAULT_MAX_INVARIANTS = 8;
const DEFAULT_MAX_HURDLES = 4;
/** O que vai ao Jev como candidatos (o doc pode ter 214 regras e ~1.5k hurdles). */
const MAX_JEV_FLOW_CANDIDATES = 24;
const MAX_JEV_INVARIANT_CANDIDATES = 40;
const MAX_JEV_HURDLE_CANDIDATES = 40;
const JEV_RELEVANCE_THRESHOLD = 0.5;
const JEV_TIMEOUT_MS = 6_000;
const MAX_TASK_CHARS = 1_200;

const STOPWORDS = new Set([
  'para', 'com', 'uma', 'que', 'dos', 'das', 'isso', 'esse', 'esta', 'este',
  'the', 'and', 'for', 'como', 'quando', 'onde', 'task', 'tarefa', 'agora',
  'preciso', 'fazer', 'faz', 'você', 'voce', 'por', 'favor', 'nos', 'nós',
]);

function normalizeToken(token: string): string {
  return token
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

/** Tokens da tarefa/candidato: minúsculos, sem acento, ≥3 chars, sem stopword. */
function tokenize(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const raw of text.split(/[^\p{L}\p{N}]+/u)) {
    const token = normalizeToken(raw);
    if (token.length >= 3 && !STOPWORDS.has(token)) tokens.add(token);
  }
  return tokens;
}

function basenameTokens(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  return base.replace(/\.[^.]+$/, '');
}

function scoreTokens(taskTokens: ReadonlySet<string>, haystack: string): number {
  if (taskTokens.size === 0) return 0;
  const tokens = tokenize(haystack);
  let score = 0;
  for (const token of taskTokens) {
    if (tokens.has(token)) score += 1;
  }
  return score;
}

interface Scored<T> {
  readonly item: T;
  readonly score: number;
  readonly index: number;
}

function pickTop<T>(items: readonly Scored<T>[], max: number): T[] {
  return [...items]
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, max)
    .map((item) => item.item);
}

/**
 * Ranking lexical determinístico: fluxo ganha peso por tabela/função, o
 * invariante herda a nota do fluxo dele (a regra via de brinde quando o fluxo
 * é tocado), a hurdle pontua por título/resumo/origem.
 */
function lexicalScores(
  taskTokens: ReadonlySet<string>,
  document: BusinessModelDocument,
): { flows: Scored<BusinessFlow>[]; invariants: Scored<BusinessInvariant>[] } {
  const flowScore = new Map<string, number>();
  const flows = document.flows.map((flow, index) => {
    const name = `${flow.fluxo} ${flow.escreve.join(' ')} ${flow.le.join(' ')}`;
    const refs = `${flow.funcoes.join(' ')} ${flow.arquivos.map(basenameTokens).join(' ')} ${flow.testes.map(basenameTokens).join(' ')}`;
    const score = scoreTokens(taskTokens, name) * 3 + scoreTokens(taskTokens, refs) * 2;
    flowScore.set(flow.fluxo, score);
    return { item: flow, score, index };
  });
  const invariants = document.invariants.map((invariant, index) => {
    const own =
      scoreTokens(taskTokens, invariant.regra) +
      scoreTokens(taskTokens, invariant.tabelas.join(' ')) * 3 +
      scoreTokens(taskTokens, `${invariant.arquivos.map(basenameTokens).join(' ')} ${invariant.testes.map(basenameTokens).join(' ')}`) * 2;
    // Regra global do projeto é levemente relevante para qualquer tarefa.
    const base = invariant.fluxo === 'projeto' ? 1 : 0;
    return {
      item: invariant,
      score: own + (flowScore.get(invariant.fluxo) ?? 0) + base,
      index,
    };
  });
  return { flows, invariants };
}

function lexicalHurdleScores(
  taskTokens: ReadonlySet<string>,
  hurdles: readonly BusinessHurdle[],
): Scored<BusinessHurdle>[] {
  return hurdles.map((hurdle, index) => ({
    item: hurdle,
    score:
      scoreTokens(taskTokens, hurdle.titulo) * 2 +
      scoreTokens(taskTokens, hurdle.resumo) +
      scoreTokens(taskTokens, basenameTokens(hurdle.origem)) * 2,
    index,
  }));
}

function selectionKey(
  flows: readonly BusinessFlow[],
  invariants: readonly BusinessInvariant[],
  hurdles: readonly BusinessHurdle[],
): string {
  return [
    flows.map((item) => item.fluxo).join(','),
    invariants.map((item) => item.id).join(','),
    hurdles.map((item) => item.id).join(','),
  ].join('|');
}

function lexicalSelection(
  input: SelectBusinessContextInput,
  taskTokens: ReadonlySet<string>,
): BusinessModelSelection | null {
  const { flows, invariants } = lexicalScores(taskTokens, input.document);
  const hurdleScores = lexicalHurdleScores(taskTokens, input.hurdles);
  const pickedFlows = pickTop(
    flows.filter((item) => item.score > 0),
    input.maxFlows ?? DEFAULT_MAX_FLOWS,
  );
  // Invariante de fluxo escolhido entra mesmo sem match próprio; os demais
  // precisam pontuar (regra global entra pelo baseline).
  const pickedFlowNames = new Set(pickedFlows.map((flow) => flow.fluxo));
  const pickedInvariants = pickTop(
    invariants.filter(
      (item) => item.score > 0 || pickedFlowNames.has(item.item.fluxo),
    ),
    input.maxInvariants ?? DEFAULT_MAX_INVARIANTS,
  );
  const pickedHurdles = pickTop(
    hurdleScores.filter((item) => item.score > 0),
    input.maxHurdles ?? DEFAULT_MAX_HURDLES,
  );
  if (pickedFlows.length === 0 && pickedInvariants.length === 0 && pickedHurdles.length === 0) {
    return null;
  }
  return Object.freeze({
    flows: Object.freeze(pickedFlows),
    invariants: Object.freeze(pickedInvariants),
    hurdles: Object.freeze(pickedHurdles),
    source: 'lexical' as const,
    key: selectionKey(pickedFlows, pickedInvariants, pickedHurdles),
  });
}

const QUESTION_RULE =
  'Esta regra de negócio é relevante para a tarefa? Sim só se a tarefa toca o fluxo, as tabelas ou os arquivos que ela protege.';
const QUESTION_FLOW = 'Este fluxo de negócio é tocado pela tarefa?';
const QUESTION_HURDLE = 'Esta armadilha conhecida pode morder quem executar esta tarefa?';

function jevCandidates(
  input: SelectBusinessContextInput,
  taskTokens: ReadonlySet<string>,
): {
  questions: Record<string, JevQuestion>;
  flows: Map<string, BusinessFlow>;
  invariants: Map<string, BusinessInvariant>;
  hurdles: Map<string, BusinessHurdle>;
} {
  const { flows, invariants } = lexicalScores(taskTokens, input.document);
  const hurdleScores = lexicalHurdleScores(taskTokens, input.hurdles);
  const questions: Record<string, JevQuestion> = {};
  const flowMap = new Map<string, BusinessFlow>();
  const invariantMap = new Map<string, BusinessInvariant>();
  const hurdleMap = new Map<string, BusinessHurdle>();
  for (const flow of pickTop(flows, MAX_JEV_FLOW_CANDIDATES)) {
    const id = `flow:${flow.fluxo}`;
    flowMap.set(id, flow);
    questions[id] = {
      type: 'noul',
      instructions: {
        question: QUESTION_FLOW,
        flow: {
          name: flow.fluxo,
          writes: flow.escreve.slice(0, 6),
          reads: flow.le.slice(0, 6),
        },
      },
    };
  }
  for (const invariant of pickTop(invariants, MAX_JEV_INVARIANT_CANDIDATES)) {
    const id = `inv:${invariant.id}`;
    invariantMap.set(id, invariant);
    questions[id] = {
      type: 'noul',
      instructions: {
        question: QUESTION_RULE,
        rule: { flow: invariant.fluxo, text: capText(invariant.regra, 240) },
      },
    };
  }
  for (const hurdle of pickTop(hurdleScores, MAX_JEV_HURDLE_CANDIDATES)) {
    const id = `hurdle:${hurdle.id}`;
    hurdleMap.set(id, hurdle);
    questions[id] = {
      type: 'noul',
      instructions: {
        question: QUESTION_HURDLE,
        hurdle: {
          title: capText(hurdle.titulo, 160),
          summary: capText(hurdle.resumo, 200),
        },
      },
    };
  }
  return { questions, flows: flowMap, invariants: invariantMap, hurdles: hurdleMap };
}

/**
 * Julgamento Jev: cada candidato é uma pergunta `noul` com instrução
 * ESTRUTURADA (rule/flow/hurdle tipado). Resposta acima do limiar entra;
 * fluxo de invariante escolhido entra junto. Qualquer falha → o chamador cai
 * no ranking lexical (fail-open).
 */
async function jevSelection(
  input: SelectBusinessContextInput,
  taskTokens: ReadonlySet<string>,
  deps: SelectBusinessContextDeps,
): Promise<BusinessModelSelection | null> {
  const surfaceEnabled = deps.surfaceEnabled ?? isJevSurfaceEnabled;
  const hasCredential = deps.hasCredential ?? hasJevCredential;
  if (!surfaceEnabled('businessModel') || !hasCredential()) return null;
  const candidates = jevCandidates(input, taskTokens);
  if (Object.keys(candidates.questions).length === 0) return null;
  const ask = deps.judge ?? judge;
  const result = await ask({
    state: { task: capText(input.task, MAX_TASK_CHARS) },
    questions: candidates.questions,
    surface: 'businessModel',
    sessionId: input.sessionId,
    missionId: input.missionId,
    timeoutMs: JEV_TIMEOUT_MS,
    retryOnTimeout: false,
  }).catch(() => null);
  if (!result) return null;

  const relevant = new Set<string>();
  for (const [id, answer] of Object.entries(result.answers)) {
    if (answer.type === 'noul' && answer.noul >= JEV_RELEVANCE_THRESHOLD) {
      relevant.add(id);
    }
  }
  const pickedInvariants = [...candidates.invariants.entries()]
    .filter(([id]) => relevant.has(id))
    .map(([, invariant]) => invariant)
    .slice(0, input.maxInvariants ?? DEFAULT_MAX_INVARIANTS);
  const impliedFlows = new Set(pickedInvariants.map((invariant) => invariant.fluxo));
  const pickedFlows = [...candidates.flows.entries()]
    .filter(([id, flow]) => relevant.has(id) || impliedFlows.has(flow.fluxo))
    .map(([, flow]) => flow)
    .slice(0, input.maxFlows ?? DEFAULT_MAX_FLOWS);
  const pickedHurdles = [...candidates.hurdles.entries()]
    .filter(([id]) => relevant.has(id))
    .map(([, hurdle]) => hurdle)
    .slice(0, input.maxHurdles ?? DEFAULT_MAX_HURDLES);
  const recordDecision = deps.recordDecision ?? recordJevDecision;
  try {
    recordDecision({
      surface: 'businessModel',
      sessionId: input.sessionId,
      missionId: input.missionId,
      model: result.model,
      questions: Object.keys(result.answers),
      probabilities: jevAnswerProbabilities(result.answers),
      confidence: jevAnswerConfidences(result.answers),
      decision: `select:${pickedFlows.length}f/${pickedInvariants.length}i/${pickedHurdles.length}h`,
      inputTokens: result.usage?.input_tokens ?? null,
      usd: (result.usage?.input_tokens ?? 0) * USD_PER_INPUT_TOKEN,
    });
  } catch {
    // Diário nunca bloqueia a seleção.
  }
  if (pickedFlows.length === 0 && pickedInvariants.length === 0 && pickedHurdles.length === 0) {
    // Jev respondeu mas não achou nada relevante: vale a palavra dele.
    return Object.freeze({
      flows: Object.freeze([]),
      invariants: Object.freeze([]),
      hurdles: Object.freeze([]),
      source: 'jev' as const,
      key: '||',
    });
  }
  return Object.freeze({
    flows: Object.freeze(pickedFlows),
    invariants: Object.freeze(pickedInvariants),
    hurdles: Object.freeze(pickedHurdles),
    source: 'jev' as const,
    key: selectionKey(pickedFlows, pickedInvariants, pickedHurdles),
  });
}

/**
 * Seleciona o que importa para a tarefa. `null` quando nem Jev nem léxico
 * acham nada — o chamador decide se cai no bloco estático ou omite.
 */
export async function selectBusinessContext(
  input: SelectBusinessContextInput,
  deps: SelectBusinessContextDeps = {},
): Promise<BusinessModelSelection | null> {
  try {
    const taskTokens = tokenize(capText(input.task, MAX_TASK_CHARS));
    const jev = await jevSelection(input, taskTokens, deps);
    if (jev) return jev;
    return lexicalSelection(input, taskTokens);
  } catch {
    return null;
  }
}
