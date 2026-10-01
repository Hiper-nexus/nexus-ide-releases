import { decisionResultUsage } from '../decision-models/decision-usage';
import { ProcessGitRunner, type GitRunner } from '../runtime/git-command';
import type { ProjectExecutionScope } from '../../shared/types';
import { redactVisibleSecrets } from '../../shared/vision-ipc';
import {
  capText,
  judge,
  type JevQuestion,
} from '../jev/jev-client';
import { isJevSurfaceEnabled } from '../jev/jev-autopilot';
import { hasDecisionCredential } from '../decision-models/decision-availability';
import {
  jevAnswerConfidences,
  jevAnswerProbabilities,
  recordJevDecision,
} from '../jev/jev-decision-log';
import {
  readBusinessHurdles,
  type BusinessInvariant,
} from '../context/business-model/business-model-contract';
import type { BusinessHurdle } from '../context/business-model/business-model-hurdles';

/**
 * RISCO DE NEGÓCIO do portão de regressão — ADVISORY, nunca veredito.
 *
 * Depois de o portão decidir (determinístico: testes que rodaram/falharam),
 * este módulo responde "o diff encosta em quais regras e armadilhas
 * conhecidas?". Cada invariante tocado e as hurdles mais próximas viram UMA
 * pergunta `noul` para o Jev na superfície `businessModel`; sem Jev (toggle,
 * chave, timeout, resposta malformada) o relatório ainda lista os itens
 * tocados, só que sem probabilidade (`p: null`).
 *
 * Limites deliberados: o resultado é informativo — NÃO entra no status, não
 * bloqueia e não aprova nada. Texto do repositório continua dado inerte:
 * redigido, numa linha e sem delimitadores antes de ir ao relatório.
 */

const MAX_RISK_RULES = 8;
const MAX_RISK_HURDLES = 4;
const MAX_HURDLE_CANDIDATES = 24;
const MAX_DIFF_CHARS = 12_000;
const MAX_REPORT_TEXT = 200;
const RISK_THRESHOLD = 0.5;
const JEV_TIMEOUT_MS = 6_000;

export interface GateBusinessRiskItem {
  readonly id: string;
  /** Texto inerte (redigido, uma linha, sem «») para o relatório. */
  readonly text: string;
  /** Probabilidade do Jev; `null` no fallback lexical. */
  readonly p: number | null;
}

export interface GateBusinessRisk {
  readonly source: 'jev' | 'lexical';
  readonly rules: readonly GateBusinessRiskItem[];
  readonly hurdles: readonly GateBusinessRiskItem[];
}

export interface GateBusinessRiskInput {
  readonly scope: ProjectExecutionScope;
  readonly projectScope?: ProjectExecutionScope;
  /** Base do diff que o portão verificou (`base...HEAD` quando existe). */
  readonly baseSha: string | null;
  readonly changedFiles: readonly string[];
  /** Invariantes que o portão já marcou como tocados pelo diff. */
  readonly touched: readonly BusinessInvariant[];
}

export interface GateBusinessRiskDeps {
  readonly judge?: typeof judge;
  readonly surfaceEnabled?: (surface: 'businessModel') => boolean;
  readonly hasCredential?: () => boolean;
  readonly recordDecision?: typeof recordJevDecision;
  readonly git?: GitRunner;
}

const UNSAFE_TEXT_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/gu;

/** Mesma doutrina do `neutralizeRunnerText`: saída inerte, uma linha, sem «». */
function inert(text: string, max = MAX_REPORT_TEXT): string {
  const clean = redactVisibleSecrets(text.replace(/\u001b\[[0-9;]*[A-Za-z]/gu, ''))
    .replace(UNSAFE_TEXT_RE, ' ')
    .replace(/[«»]/gu, '"')
    .replace(/\s+/gu, ' ')
    .trim();
  return clean.length <= max ? clean : `${clean.slice(0, max)}…`;
}

const STOPWORDS = new Set([
  'para', 'com', 'uma', 'que', 'dos', 'das', 'the', 'and', 'for', 'diff',
  'index', 'blob', 'mode', 'file',
]);

function tokenize(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const raw of text.split(/[^\p{L}\p{N}]+/u)) {
    const token = raw
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
    if (token.length >= 3 && !STOPWORDS.has(token)) tokens.add(token);
  }
  return tokens;
}

function scoreOf(tokens: ReadonlySet<string>, haystack: string): number {
  if (tokens.size === 0) return 0;
  const own = tokenize(haystack);
  let score = 0;
  for (const token of tokens) if (own.has(token)) score += 1;
  return score;
}

/** Diff limitado: `base...HEAD` (commits da base) + working tree vs HEAD. */
function diffText(input: GateBusinessRiskInput, git: GitRunner): string {
  const run = (args: readonly string[]): string => {
    try {
      const result = git.run(input.scope.rootRealPath, args, { allowFailure: true });
      return result.status === 0 ? result.stdout : '';
    } catch {
      return '';
    }
  };
  const committed = input.baseSha
    ? run(['diff', '--unified=1', `${input.baseSha}...HEAD`])
    : '';
  const worktree = run(['diff', '--unified=1', 'HEAD']);
  return capText(`${committed}\n${worktree}`, MAX_DIFF_CHARS);
}

interface RankedHurdle {
  readonly hurdle: BusinessHurdle;
  readonly score: number;
  readonly index: number;
}

function rankedHurdles(
  tokens: ReadonlySet<string>,
  hurdles: readonly BusinessHurdle[],
): RankedHurdle[] {
  return hurdles
    .map((hurdle, index) => ({
      hurdle,
      score: scoreOf(tokens, `${hurdle.titulo} ${hurdle.resumo} ${hurdle.origem}`),
      index,
    }))
    .sort((left, right) => right.score - left.score || left.index - right.index);
}

/** Fallback sem Jev: os itens tocados entram sem probabilidade. */
function lexicalRisk(
  touched: readonly BusinessInvariant[],
  hurdles: readonly RankedHurdle[],
): GateBusinessRisk | null {
  const rules = touched.slice(0, MAX_RISK_RULES).map((invariant) =>
    Object.freeze({ id: invariant.id, text: inert(invariant.regra), p: null }));
  const picked = hurdles
    .filter((item) => item.score > 0)
    .slice(0, MAX_RISK_HURDLES)
    .map((item) =>
      Object.freeze({ id: item.hurdle.id, text: inert(item.hurdle.titulo), p: null }));
  if (rules.length === 0 && picked.length === 0) return null;
  return Object.freeze({
    source: 'lexical' as const,
    rules: Object.freeze(rules),
    hurdles: Object.freeze(picked),
  });
}

const RULE_QUESTION =
  'Pelo diff e pelos arquivos tocados, existe risco real de este invariante de negócio ser violado?';
const HURDLE_QUESTION =
  'Pelo diff e pelos arquivos tocados, esta armadilha conhecida pode ocorrer nesta mudança?';

/**
 * Risco de negócio do diff que o portão verificou. `null` quando não há
 * modelo extraído nem nada tocado. Nunca lança e nunca decide o veredito —
 * quem aprova/reprova é o conjunto de testes, não este relatório.
 */
export async function evaluateGateBusinessRisk(
  input: GateBusinessRiskInput,
  deps: GateBusinessRiskDeps = {},
): Promise<GateBusinessRisk | null> {
  try {
    const touched = input.touched.slice(0, MAX_RISK_RULES);
    const allHurdles = readBusinessHurdles(input.scope, input.projectScope);
    if (touched.length === 0 && allHurdles.length === 0) return null;

    const git = deps.git ?? new ProcessGitRunner();
    const diff = diffText(input, git);
    const tokens = tokenize(`${input.changedFiles.join(' ')}\n${diff}`);
    const hurdleCandidates = rankedHurdles(tokens, allHurdles).slice(0, MAX_HURDLE_CANDIDATES);

    const surfaceEnabled = deps.surfaceEnabled ?? isJevSurfaceEnabled;
    const hasCredential = deps.hasCredential ?? (() => hasDecisionCredential('businessModel'));
    if (!surfaceEnabled('businessModel') || !hasCredential()) {
      return lexicalRisk(touched, hurdleCandidates);
    }

    const questions: Record<string, JevQuestion> = {};
    const ruleById = new Map<string, BusinessInvariant>();
    const hurdleById = new Map<string, BusinessHurdle>();
    for (const invariant of touched) {
      const id = `rule:${invariant.id}`;
      ruleById.set(id, invariant);
      questions[id] = {
        type: 'noul',
        instructions: {
          question: RULE_QUESTION,
          rule: { flow: invariant.fluxo, text: capText(invariant.regra, 240) },
        },
      };
    }
    for (const { hurdle } of hurdleCandidates) {
      const id = `hurdle:${hurdle.id}`;
      hurdleById.set(id, hurdle);
      questions[id] = {
        type: 'noul',
        instructions: {
          question: HURDLE_QUESTION,
          hurdle: {
            title: capText(hurdle.titulo, 160),
            summary: capText(hurdle.resumo, 200),
          },
        },
      };
    }
    if (Object.keys(questions).length === 0) return null;

    const ask = deps.judge ?? judge;
    const result = await ask({
      state: {
        files: input.changedFiles.slice(0, 40),
        diff,
      },
      questions,
      surface: 'businessModel',
      timeoutMs: JEV_TIMEOUT_MS,
      retryOnTimeout: false,
    }).catch(() => null);
    if (!result) return lexicalRisk(touched, hurdleCandidates);

    const probability = (id: string): number | null => {
      const answer = result.answers[id];
      return answer && answer.type === 'noul' ? answer.noul : null;
    };
    const rules = touched
      .flatMap((invariant) => {
        const p = probability(`rule:${invariant.id}`);
        return p === null || p < RISK_THRESHOLD
          ? []
          : [Object.freeze({ id: invariant.id, text: inert(invariant.regra), p })];
      })
      .sort((left, right) => right.p - left.p || left.id.localeCompare(right.id));
    const picked = [...hurdleById.entries()]
      .flatMap(([id, hurdle]) => {
        const p = probability(id);
        return p === null || p < RISK_THRESHOLD
          ? []
          : [Object.freeze({ id: hurdle.id, text: inert(hurdle.titulo), p })];
      })
      .sort((left, right) => right.p - left.p || left.id.localeCompare(right.id))
      .slice(0, MAX_RISK_HURDLES);
    const recordDecision = deps.recordDecision ?? recordJevDecision;
    try {
      recordDecision({
        surface: 'businessModel',
        model: result.model,
        questions: Object.keys(result.answers),
        probabilities: jevAnswerProbabilities(result.answers),
        confidence: jevAnswerConfidences(result.answers),
        decision: `risk:${rules.length}r/${picked.length}h`,
        ...decisionResultUsage(result),
      });
    } catch {
      // Diário nunca bloqueia o relatório.
    }
    if (rules.length === 0 && picked.length === 0) {
      // Jev respondeu e não viu risco: isso é um achado — não cair no lexical.
      return Object.freeze({
        source: 'jev' as const,
        rules: Object.freeze([]),
        hurdles: Object.freeze([]),
      });
    }
    return Object.freeze({
      source: 'jev' as const,
      rules: Object.freeze(rules),
      hurdles: Object.freeze(picked),
    });
  } catch {
    return null;
  }
}
