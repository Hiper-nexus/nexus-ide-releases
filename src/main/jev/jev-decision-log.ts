/**
 * Diário de decisões do Jev (learning loop): cada superfície que consulta o
 * modelo grava UMA linha JSONL com ids de perguntas, probabilidades e a
 * decisão tomada — NUNCA o state (texto sai para terceiro; aqui ficam só
 * números). O usuário marca certo/errado na tela e `jevDecisionStats`
 * transforma isso em sugestões de limiar/toggle (texto, nunca auto-aplicado).
 *
 * Fail-open: erro de fs vira console.warn e nada quebra.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { JevSurface } from './jev-autopilot';
import type { JevAnswer } from './jev-client';
import type { DecisionProvider, DecisionRoute, DecisionUsageReceipt } from '../../shared/decision-models';
import { USD_PER_INPUT_TOKEN } from './jev-pricing';
import { parseDecisionRow } from './jev-decision-row';
import type { JevOptimizationEvidence, JevOptimizationStats, DecisionUsageStats } from '../../shared/jev-ipc';
import { trace } from '../observability/main-trace';

export type JevDecisionSurface =
  | JevSurface
  | 'judgeTool'
  | 'rankTool'
  | 'browserTool'
  | 'computerTool'
  /** Clef-omni ouve o clipe da ativação passiva e diz se é TV/ambiente (F-1161). */
  | 'wakeConfirm'
  /** F-1167: linha agregada por modelo de uma calibração (gasto visível nas estatísticas). */
  | 'calibration';

/** Motivo categórico de uma consulta sem resposta — nunca o texto do erro. */
export type JevNoAnswerReason =
  | 'timeout'
  | 'rate-limited'
  | 'client-error'
  | 'server-error'
  | 'network'
  | 'malformed'
  | 'aborted'
  /** Bug ou configuração quebrada dentro do Nexus (não do provedor): nunca o texto do erro. */
  | 'internal-error'
  /** A Decisions API recusou a consulta. Não é um predicado negativo. */
  | 'refusal'
  /** A resposta parseou, mas a distribuição não serve o contrato. */
  | 'ambiguous'
  /** Juntos não teve respostas comparáveis, ou uma escolha de segurança divergiu. */
  | 'divergent'
  /** O orçamento de decisão da missão esgotou: nenhuma requisição saiu (F-1164). */
  | 'budget';

export { JEV_NO_ANSWER_REASONS } from './jev-decision-row';

export interface JevDecisionEntry {
  id: string;
  at: number;
  /** Ausente = 'decision' — linhas antigas continuam válidas. */
  kind?: 'decision' | 'no-answer' | 'optimization';
  reason?: JevNoAnswerReason;
  surface: JevDecisionSurface;
  sessionId?: string;
  missionId?: string;
  model: string;
  provider?: DecisionProvider;
  route?: DecisionRoute;
  durationMs?: number;
  requestCount?: number;
  usageIncomplete?: boolean;
  questions: string[];
  probabilities: Record<string, number>;
  confidence?: Record<string, number>;
  decision: string;
  /** `null` nas linhas sem resposta — métrica ausente, nunca zero fabricado. */
  inputTokens: number | null;
  usd: number | null;
  /**
   * Valor que o livro de orçamento da missão efetivamente cobrou (F-1164):
   * custo medido, ou o estimado quando o custo é desconhecido. Ausente em
   * linhas antigas e fora do livro; a reconstrução cai no `usd`.
   */
  budgetChargedUsd?: number;
  feedback?: 'right' | 'wrong';
  feedbackAt?: number;
  optimization?: JevOptimizationEvidence;
  /** Juntos discordou. A linha não leva o texto da consulta. */
  diverged?: boolean;
  /** Números por pergunta e provedor. Sem texto. */
  ensemblePeers?: Record<string, Record<string, number>>;
}

export type JevDecisionInput = Omit<JevDecisionEntry, 'id' | 'at'>;

const MAX_LOG_BYTES = 5 * 1024 * 1024;
const MAX_LIST_LIMIT = 500;

let injectedDir: string | undefined;

/** Para testes: fixa o diretório do log; `undefined` volta ao userData. */
export function configureJevDecisionLog(dir?: string): void {
  injectedDir = dir;
}

function decisionsDir(): string {
  if (injectedDir) return injectedDir;
  // Require tardio: fora do Electron (vitest/tsx) `electron` não expõe `app`.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const electron = require('electron') as {
    app?: { getPath(name: 'userData'): string };
  };
  if (typeof electron?.app?.getPath !== 'function') {
    throw new Error('jev decision log requires configureJevDecisionLog(dir) outside Electron');
  }
  return path.join(electron.app.getPath('userData'), 'jev');
}

function logFile(dir?: string): string {
  return path.join(dir ?? decisionsDir(), 'decisions.jsonl');
}

function rotatedLogFile(dir?: string): string {
  return path.join(dir ?? decisionsDir(), 'decisions.1.jsonl');
}

function readEntries(file: string): JevDecisionEntry[] {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const entries: JevDecisionEntry[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const row = parseDecisionRow(JSON.parse(trimmed));
      if (row) entries.push(row);
    } catch {
      // linha truncada por rotação no meio da escrita — ignora
    }
  }
  return entries;
}

/** Stats e list leem o arquivo rotacionado antes do corrente (ordem cronológica). */
function readAllEntries(dir?: string): JevDecisionEntry[] {
  return [
    ...readEntries(rotatedLogFile(dir)),
    ...readEntries(logFile(dir)),
  ];
}

/** Append síncrono; engole erro de fs com warn (o diário nunca bloqueia). */
export function recordJevDecision(
  entry: JevDecisionInput,
  deps?: { dir?: string },
): string {
  const id = crypto.randomUUID();
  const line: JevDecisionEntry = { id, at: Date.now(), surface: entry.surface,
    kind: entry.kind, reason: entry.reason, sessionId: entry.sessionId, missionId: entry.missionId,
    model: entry.model, questions: entry.questions, probabilities: entry.probabilities,
    confidence: entry.confidence, decision: entry.decision, inputTokens: entry.inputTokens, usd: entry.usd,
    provider: entry.provider, route: entry.route, durationMs: entry.durationMs, requestCount: entry.requestCount,
    usageIncomplete: entry.usageIncomplete, diverged: entry.diverged, ensemblePeers: entry.ensemblePeers,
    budgetChargedUsd: entry.budgetChargedUsd,
    feedback: entry.feedback, feedbackAt: entry.feedbackAt, optimization: entry.optimization };
  // Espelho e contagem acontecem mesmo se o fs falhar: a decisão existiu.
  countDecisionLine(line);
  traceDecisionLine(line);
  try {
    const file = logFile(deps?.dir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      if (fs.statSync(file).size > MAX_LOG_BYTES) {
        fs.renameSync(file, file.replace('decisions.jsonl', 'decisions.1.jsonl'));
      }
    } catch {
      // arquivo ainda não existe — nada a rotacionar
    }
    fs.appendFileSync(file, JSON.stringify(line) + '\n');
  } catch (error) {
    console.warn('[jev] decision log write failed (ignored):', error);
  }
  return id;
}

/**
 * Contadores desde o boot por provider e superfície (IPC `jev:status`): todo
 * o trabalho de decisão — inclusive Clef e Luna — fica visível sem ler o
 * diário. Linhas de otimização (cache hit, sem requisição) contam como
 * atividade do provider que teria respondido.
 */
const bootCounts = {
  byProvider: Object.create(null) as Record<string, number>,
  bySurface: Object.create(null) as Record<string, number>,
};

export function jevDecisionBootCounts(): {
  byProvider: Record<string, number>;
  bySurface: Record<string, number>;
} {
  return { byProvider: { ...bootCounts.byProvider }, bySurface: { ...bootCounts.bySurface } };
}

function countDecisionLine(entry: JevDecisionEntry): void {
  const provider = providerOfEntry(entry);
  bootCounts.byProvider[provider] = (bootCounts.byProvider[provider] ?? 0) + 1;
  bootCounts.bySurface[entry.surface] = (bootCounts.bySurface[entry.surface] ?? 0) + 1;
}

/** Amostragem do trace: uma linha `optimization` por superfície por minuto. */
const TRACE_OPTIMIZATION_MIN_INTERVAL_MS = 60_000;
const optimizationTracedAt = new Map<string, number>();

/**
 * Espelha cada linha do diário no trace principal (`main.trace.ndjson`) SEM
 * conteúdo: só rótulos e números (surface/provider/model/outcome/duração).
 * O diário continua sendo a fonte completa; o trace dá às decisões a mesma
 * visibilidade que os eventos de ciclo de vida já têm. Fail-open total.
 */
function traceDecisionLine(entry: JevDecisionEntry): void {
  try {
    const outcome = entry.kind ?? 'decision';
    if (outcome === 'optimization') {
      const last = optimizationTracedAt.get(entry.surface) ?? -Infinity;
      if (entry.at - last < TRACE_OPTIMIZATION_MIN_INTERVAL_MS) return;
      optimizationTracedAt.set(entry.surface, entry.at);
    }
    trace({
      kind: 'decision',
      surface: entry.surface,
      provider: providerOfEntry(entry),
      model: entry.model,
      outcome: outcome === 'decision' && entry.decision === 'skip' ? 'skip' : outcome,
      ...(entry.reason !== undefined ? { reason: entry.reason } : {}),
      ...(entry.durationMs !== undefined ? { durationMs: entry.durationMs } : {}),
      ...(entry.requestCount !== undefined ? { requestCount: entry.requestCount } : {}),
      ...(typeof entry.inputTokens === 'number' ? { inputTokens: entry.inputTokens } : {}),
      ...(entry.sessionId !== undefined ? { sessionId: entry.sessionId } : {}),
      ...(entry.missionId !== undefined ? { missionId: entry.missionId } : {}),
    });
  } catch {
    // O trace é diagnóstico: nunca derruba a gravação do diário.
  }
}

/** Para testes: zera contadores de boot e a amostragem do trace. */
export function resetJevDecisionInstrumentationForTesting(): void {
  bootCounts.byProvider = Object.create(null);
  bootCounts.bySurface = Object.create(null);
  optimizationTracedAt.clear();
}

/** A reused answer made no API request; never inflate call, token or USD totals. */
export function recordJevOptimization(
  input: Pick<JevDecisionInput, 'surface' | 'sessionId' | 'missionId' | 'model'> & {
    optimization: JevOptimizationEvidence;
  },
  deps?: { dir?: string },
): string {
  return recordJevDecision({
    ...input, kind: 'optimization', questions: [], probabilities: {},
    decision: 'reuse', inputTokens: 0, usd: 0,
  }, deps);
}

/**
 * Consulta que não teve resposta (timeout, erro, limite): a superfície caiu
 * no caminho determinístico. Gravado centralmente por `judge()` quando o
 * chamador informa `surface` — nunca o texto do erro.
 */
export function recordJevNoAnswer(
  input: {
    surface: JevDecisionSurface;
    reason: JevNoAnswerReason;
    model: string;
    provider?: DecisionProvider;
    route?: DecisionRoute;
    sessionId?: string;
    missionId?: string;
    usage?: DecisionUsageReceipt;
    /** Tentativas HTTP já feitas; `0` = falhou antes de qualquer requisição (medido, não desconhecido). */
    requestCount?: number;
    /** Valor cobrado pelo livro de orçamento da missão (F-1164). */
    budgetChargedUsd?: number;
  },
  deps?: { dir?: string },
): string {
  const requestCount = input.usage?.requestCount ?? input.requestCount;
  const inputTokens = input.usage?.inputTokens ?? (requestCount === 0 ? 0 : null);
  const usd = input.usage?.usd ?? (requestCount === 0 ? 0 : null);
  return recordJevDecision(
    {
      kind: 'no-answer',
      reason: input.reason,
      surface: input.surface,
      sessionId: input.sessionId,
      missionId: input.missionId,
      model: input.model,
      provider: input.provider,
      route: input.route,
      questions: [],
      probabilities: {},
      decision: 'rule',
      inputTokens,
      usd,
      requestCount,
      durationMs: input.usage?.durationMs,
      usageIncomplete: Boolean(input.usage?.usageIncomplete || (requestCount !== 0 && (inputTokens === null || usd === null))),
      ...(input.budgetChargedUsd === undefined ? {} : { budgetChargedUsd: input.budgetChargedUsd }),
    },
    deps,
  );
}

export function listJevDecisions(opts?: {
  limit?: number;
  surface?: string;
  includeNoAnswer?: boolean;
  dir?: string;
}): JevDecisionEntry[] {
  const limit = Math.min(Math.max(opts?.limit ?? 50, 1), MAX_LIST_LIMIT);
  let entries: JevDecisionEntry[];
  try {
    entries = readAllEntries(opts?.dir);
  } catch {
    return [];
  }
  const decisions = entries.filter((e) => e.kind !== 'optimization');
  const answered = opts?.includeNoAnswer
    ? decisions
    : decisions.filter((e) => e.kind !== 'no-answer');
  const filtered = opts?.surface
    ? answered.filter((e) => e.surface === opts.surface)
    : answered;
  return filtered.slice(-limit).reverse();
}

export function setJevDecisionFeedback(
  id: string,
  verdict: 'right' | 'wrong',
  deps?: {
    dir?: string;
    /**
     * F-782: feedback vindo de um gesto do fluxo (ACK do Maestro), não da
     * tela. O id chega por um artifact do handoff, que o worker também
     * escreve — só marca a linha que passar no predicado (superfície/sessão).
     */
    accept?: (entry: JevDecisionEntry) => boolean;
  },
): boolean {
  try {
    const file = logFile(deps?.dir);
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      return false;
    }
    // F-782: o ACK do Maestro chama isto no Main. Só a linha da decisão é
    // relida e regravada; as outras seguem byte a byte. Reparsear e
    // reserializar o diário inteiro custava ~55 ms no teto de 5 MB.
    const line = findDecisionLine(raw, id);
    if (!line) return false;
    if (deps?.accept && !deps.accept(line.entry)) return false;
    const updated = { ...line.entry, feedback: verdict, feedbackAt: Date.now() };
    const tmp = file + '.tmp';
    fs.writeFileSync(
      tmp,
      raw.slice(0, line.start) + JSON.stringify(updated) + raw.slice(line.end),
    );
    fs.renameSync(tmp, file);
    return true;
  } catch (error) {
    console.warn('[jev] decision feedback failed (ignored):', error);
    return false;
  }
}

/** Primeira linha válida cujo `id` é exatamente `id` (o texto pode aparecer em outros campos). */
function findDecisionLine(
  raw: string,
  id: string,
): { start: number; end: number; entry: JevDecisionEntry } | null {
  if (!id) return null;
  const needle = JSON.stringify(id).slice(1, -1);
  for (let hit = raw.indexOf(needle); hit >= 0; ) {
    const start = raw.lastIndexOf('\n', hit) + 1;
    const newline = raw.indexOf('\n', hit);
    const end = newline < 0 ? raw.length : newline;
    try {
      const entry = parseDecisionRow(JSON.parse(raw.slice(start, end)));
      if (entry?.id === id) return { start, end, entry };
    } catch {
      // linha truncada por rotação no meio da escrita — segue procurando
    }
    hit = newline < 0 ? -1 : raw.indexOf(needle, end + 1);
  }
  return null;
}

export interface JevWindowStats {
  consultations: number;
  answered: number;
  noAnswer: number;
  usd: number;
  inputTokens: number;
  optimization?: JevOptimizationStats;
}

export interface JevDecisionStats {
  byProvider: Record<string, DecisionUsageStats>;
  byModel: Record<string, DecisionUsageStats>;
  /** calls = decisões respondidas; noAnswer = consultas sem resposta. */
  totals: { calls: number; usd: number; inputTokens: number; noAnswer: number };
  windows: {
    today: JevWindowStats;
    last30d: JevWindowStats;
    allTime: JevWindowStats;
  };
  bySurface: Record<
    string,
    {
      calls: number;
      usd: number;
      noAnswer: number;
      /** jev = decisões respondidas na janela; rule = quedas p/ o caminho determinístico. */
      last30d: { jev: number; rule: number; usd: number };
      decisions: Record<string, number>;
      feedback: { right: number; wrong: number };
      suggestion?: string;
      optimization?: JevOptimizationStats;
    }
  >;
  /** Gasto e consultas por missão (F-1164). Linhas sem missionId ficam fora. */
  byMission: Record<string, JevMissionStats>;
  /**
   * F-1167: gasto das calibrações (linhas `calibration`). Entra só no GASTO
   * (totais, janelas, provedor e modelo); nunca nas contagens de decisões.
   */
  calibration: JevCalibrationSpend;
  pricing: { usdPerInputToken: number; source: 'typesafe-published' };
}

export interface JevCalibrationSpend {
  /** Linhas agregadas gravadas (uma por modelo consultado em cada calibração). */
  lines: number;
  usd: number;
  inputTokens: number;
  last30dUsd: number;
}

/** Linha agregada de calibração: gasto real, mas não é decisão de uma surface. */
export function isCalibrationEntry(entry: Pick<JevDecisionEntry, 'surface'>): boolean {
  return entry.surface === 'calibration';
}

function addSpendOnly(buckets: Record<string, DecisionUsageStats>, key: string, entry: JevDecisionEntry): void {
  const bucket = buckets[key] ??= { calls: 0, noAnswer: 0, usd: 0, inputTokens: 0, requests: null, durationMs: null, measuredRows: 0, legacyRows: 0 };
  bucket.usd += entry.usd ?? 0;
  bucket.inputTokens += entry.inputTokens ?? 0;
}

export interface JevMissionStats {
  calls: number;
  noAnswer: number;
  /** Consultas recusadas pelo orçamento da missão (subconjunto de noAnswer). */
  budgetRefusals: number;
  usd: number;
  /** O que o livro de orçamento cobrou (custo desconhecido pesa o estimado). */
  chargedUsd: number;
  inputTokens: number;
  /** Linhas cujo custo não foi medido: o usd é limite inferior. */
  incompleteUsage: number;
  byProvider: Record<string, { calls: number; noAnswer: number; usd: number }>;
}

const DAY_MS = 86_400_000;

function addProviderUsage(buckets: Record<string, DecisionUsageStats>, key: string, entry: JevDecisionEntry): void {
  const bucket = buckets[key] ??= { calls: 0, noAnswer: 0, usd: 0, inputTokens: 0, requests: null, durationMs: null, measuredRows: 0, legacyRows: 0 };
  if (entry.kind === 'no-answer') bucket.noAnswer += 1;
  else bucket.calls += 1;
  bucket.usd += entry.usd ?? 0; bucket.inputTokens += entry.inputTokens ?? 0;
  if (entry.usageIncomplete || (entry.kind === 'no-answer' && entry.requestCount !== 0 && (entry.inputTokens === null || entry.usd === null))) {
    bucket.incompleteUsageCalls = (bucket.incompleteUsageCalls ?? 0) + 1;
  }
  // Linhas antigas não medem tentativas: contam à parte e nunca apagam o que as novas mediram.
  if (entry.requestCount === undefined) bucket.legacyRows += 1;
  else { bucket.measuredRows += 1; bucket.requests = (bucket.requests ?? 0) + entry.requestCount; }
  if (entry.durationMs !== undefined) bucket.durationMs = (bucket.durationMs ?? 0) + entry.durationMs;
}

/**
 * A linha `judge-unavailable` do handoffReview só registra que a revisão não
 * rodou; a consulta já tem a sua linha `no-answer`. Não é chamada nem custo.
 */
function isUnavailableMarker(entry: JevDecisionEntry): boolean {
  return entry.kind !== 'no-answer' && entry.decision === 'judge-unavailable';
}

/** Quanto a linha pesa no livro da missão: o cobrado, senão o custo medido. */
function chargedUsdOf(entry: JevDecisionEntry): number {
  const charged = entry.budgetChargedUsd ?? entry.usd ?? 0;
  return Number.isFinite(charged) && charged > 0 ? charged : 0;
}

const SPEND_YIELD_EVERY_LINES = 2_000;

async function readOrEmpty(file: string): Promise<string> {
  try { return await fs.promises.readFile(file, 'utf8'); } catch { return ''; }
}

async function inodeOf(file: string): Promise<number | null> {
  try { return (await fs.promises.stat(file)).ino; } catch { return null; }
}

/**
 * Lê rotacionado E corrente antes de processar. Uma rotação no meio (o
 * corrente vira `.1`) troca o inode do corrente: refaz, até 3 vezes.
 */
async function readJournalPair(dir: string): Promise<[string, string]> {
  let pair: [string, string] = ['', ''];
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = await inodeOf(logFile(dir));
    pair = await Promise.all([readOrEmpty(rotatedLogFile(dir)), readOrEmpty(logFile(dir))]);
    if ((await inodeOf(logFile(dir))) === before) return pair;
  }
  return pair;
}

async function readMissionSpend(raw: string, before: number, into: Record<string, number>): Promise<void> {
  if (!raw) return;
  const lines = raw.split('\n');
  for (let index = 0; index < lines.length; index++) {
    // Cede a thread a cada bloco: o diário pode ter 10 MB e o Main não trava.
    if (index > 0 && index % SPEND_YIELD_EVERY_LINES === 0) await new Promise<void>(resolve => setImmediate(resolve));
    const trimmed = lines[index].trim();
    if (!trimmed) continue;
    let row: JevDecisionEntry | null = null;
    try { row = parseDecisionRow(JSON.parse(trimmed)); } catch { row = null; }
    if (!row?.missionId || row.kind === 'optimization' || isUnavailableMarker(row) || row.at >= before) continue;
    into[row.missionId] = (into[row.missionId] ?? 0) + chargedUsdOf(row);
  }
}

/**
 * Gasto por missão gravado ANTES de `before` (o nascimento do livro deste
 * processo). Assíncrono e cooperativo: aquece o livro fora do caminho quente.
 */
export async function jevMissionChargedSpend(opts: { before: number; dir?: string }): Promise<Record<string, number>> {
  const spend: Record<string, number> = Object.create(null);
  let dir: string;
  try { dir = opts.dir ?? decisionsDir(); } catch { return spend; }
  const [rotated, current] = await readJournalPair(dir);
  await readMissionSpend(rotated, opts.before, spend);
  await readMissionSpend(current, opts.before, spend);
  return spend;
}

/**
 * F-1167: agregado por missão para o painel, SEM leitura síncrona: lê o par
 * rotacionado/corrente de forma assíncrona e cooperativa e guarda o resultado
 * enquanto mtime e tamanho dos dois arquivos não mudam. Chamadas simultâneas
 * compartilham a mesma leitura. Nunca rejeita: erro vira "sem dados".
 */
interface MissionUsageCache { dir: string; stamp: string; byMission: Record<string, JevMissionStats> }
let missionUsageCache: MissionUsageCache | undefined;
let missionUsageInFlight: { dir: string; stamp: string; promise: Promise<Record<string, JevMissionStats>> } | undefined;

async function journalStamp(dir: string): Promise<string> {
  const part = async (file: string) => {
    try { const stat = await fs.promises.stat(file); return `${stat.ino}:${stat.mtimeMs}:${stat.size}`; } catch { return 'missing'; }
  };
  return `${await part(rotatedLogFile(dir))}|${await part(logFile(dir))}`;
}

function providerOfEntry(entry: JevDecisionEntry): string {
  return entry.provider ?? (entry.model === 'clef' || entry.model === 'clef-flash' || entry.model === 'clef-omni'
    || entry.model.startsWith('@cf/cloudflare/') ? 'clef' : 'jev');
}

async function aggregateMissionUsage(raw: string, into: Record<string, JevMissionStats>): Promise<void> {
  if (!raw) return;
  const lines = raw.split('\n');
  for (let index = 0; index < lines.length; index++) {
    if (index > 0 && index % SPEND_YIELD_EVERY_LINES === 0) await new Promise<void>(resolve => setImmediate(resolve));
    const trimmed = lines[index].trim();
    if (!trimmed) continue;
    let row: JevDecisionEntry | null = null;
    try { row = parseDecisionRow(JSON.parse(trimmed)); } catch { row = null; }
    if (!row?.missionId || row.kind === 'optimization' || isUnavailableMarker(row)) continue;
    addMissionUsage(into, row.missionId, providerOfEntry(row), row);
  }
}

export async function jevMissionUsage(missionId: string, opts: { dir?: string } = {}): Promise<JevMissionStats | undefined> {
  let dir: string;
  try { dir = opts.dir ?? decisionsDir(); } catch { return undefined; }
  try {
    const stamp = await journalStamp(dir);
    if (missionUsageCache?.dir === dir && missionUsageCache.stamp === stamp) return missionUsageCache.byMission[missionId];
    let flight = missionUsageInFlight;
    if (!flight || flight.dir !== dir || flight.stamp !== stamp) {
      const promise = (async () => {
        const byMission: Record<string, JevMissionStats> = Object.create(null);
        const [rotated, current] = await readJournalPair(dir);
        await aggregateMissionUsage(rotated, byMission);
        await aggregateMissionUsage(current, byMission);
        missionUsageCache = { dir, stamp, byMission };
        return byMission;
      })();
      flight = { dir, stamp, promise };
      missionUsageInFlight = flight;
      void promise.finally(() => { if (missionUsageInFlight?.promise === promise) missionUsageInFlight = undefined; }).catch(() => undefined);
    }
    return (await flight.promise)[missionId];
  } catch {
    return undefined;
  }
}

/** Para testes: esquece o agregado por missão. */
export function resetJevMissionUsageCacheForTesting(): void {
  missionUsageCache = undefined;
  missionUsageInFlight = undefined;
}

function addMissionUsage(
  buckets: Record<string, JevMissionStats>, missionId: string, provider: string, entry: JevDecisionEntry,
): void {
  const bucket = buckets[missionId] ??= { calls: 0, noAnswer: 0, budgetRefusals: 0, usd: 0, chargedUsd: 0, inputTokens: 0,
    incompleteUsage: 0, byProvider: Object.create(null) };
  const perProvider = bucket.byProvider[provider] ??= { calls: 0, noAnswer: 0, usd: 0 };
  if (entry.kind === 'no-answer') {
    bucket.noAnswer += 1; perProvider.noAnswer += 1;
    if (entry.reason === 'budget') bucket.budgetRefusals += 1;
  } else { bucket.calls += 1; perProvider.calls += 1; }
  bucket.usd += entry.usd ?? 0; perProvider.usd += entry.usd ?? 0;
  bucket.chargedUsd += chargedUsdOf(entry);
  bucket.inputTokens += entry.inputTokens ?? 0;
  if (entry.usageIncomplete || (entry.requestCount !== 0 && entry.usd === null)) bucket.incompleteUsage += 1;
}

function emptyWindow(): JevWindowStats {
  return { consultations: 0, answered: 0, noAnswer: 0, usd: 0, inputTokens: 0 };
}

function addToWindow(window: JevWindowStats, entry: JevDecisionEntry): void {
  addOptimization(window, entry.optimization);
  if (entry.kind === 'optimization') return;
  window.consultations += 1;
  window.usd += entry.usd ?? 0;
  window.inputTokens += entry.inputTokens ?? 0;
  if (entry.kind === 'no-answer') {
    window.noAnswer += 1;
    return;
  }
  window.answered += 1;
}

function addOptimization(
  target: { optimization?: JevOptimizationStats },
  evidence: JevOptimizationEvidence | undefined,
): void {
  if (!evidence || typeof evidence !== 'object') return;
  const valid = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
  const avoided = valid(evidence.jevRequestsAvoided) ? evidence.jevRequestsAvoided : 0;
  const routed = evidence.llmRoutingBypassed === true ? 1 : 0;
  const context = valid(evidence.contextBytesBefore) && valid(evidence.contextBytesAfter);
  if (!avoided && !routed && !context) return;
  const stats = target.optimization ??= {
    observations: 0, jevRequestsAvoided: 0, llmRoutingBypassed: 0,
    contextSelections: 0, contextBytesBefore: 0, contextBytesAfter: 0,
  };
  stats.observations += 1;
  stats.jevRequestsAvoided += avoided;
  stats.llmRoutingBypassed += routed;
  if (context) {
    stats.contextSelections += 1;
    stats.contextBytesBefore += evidence.contextBytesBefore!;
    stats.contextBytesAfter += evidence.contextBytesAfter!;
  }
}

export function jevDecisionStats(deps?: {
  dir?: string;
  now?: number;
}): JevDecisionStats {
  const now = deps?.now ?? Date.now();
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const todayFrom = todayStart.getTime();
  const last30dFrom = now - 30 * DAY_MS;
  const stats: JevDecisionStats = {
    totals: { calls: 0, usd: 0, inputTokens: 0, noAnswer: 0 },
    windows: { today: emptyWindow(), last30d: emptyWindow(), allTime: emptyWindow() },
    bySurface: {},
    byProvider: Object.create(null), byModel: Object.create(null), byMission: Object.create(null),
    calibration: { lines: 0, usd: 0, inputTokens: 0, last30dUsd: 0 },
    pricing: { usdPerInputToken: USD_PER_INPUT_TOKEN, source: 'typesafe-published' },
  };
  let entries: JevDecisionEntry[];
  try {
    entries = readAllEntries(deps?.dir);
  } catch {
    return stats;
  }
  for (const entry of entries) {
    if (isCalibrationEntry(entry) && entry.kind !== 'optimization') {
      // F-1167: só gasto. Fora de consultas, chamadas, decisões e taxas de acerto/sem resposta.
      const usd = entry.usd ?? 0;
      const tokens = entry.inputTokens ?? 0;
      stats.calibration.lines += 1; stats.calibration.usd += usd; stats.calibration.inputTokens += tokens;
      stats.totals.usd += usd; stats.totals.inputTokens += tokens;
      const windows = [stats.windows.allTime, ...(entry.at >= todayFrom ? [stats.windows.today] : []),
        ...(entry.at >= last30dFrom ? [stats.windows.last30d] : [])];
      for (const window of windows) { window.usd += usd; window.inputTokens += tokens; }
      if (entry.at >= last30dFrom) stats.calibration.last30dUsd += usd;
      addSpendOnly(stats.byProvider, entry.provider ?? 'jev', entry);
      addSpendOnly(stats.byModel, entry.model, entry);
      continue;
    }
    const isNoAnswer = entry.kind === 'no-answer';
    addToWindow(stats.windows.allTime, entry);
    if (entry.at >= todayFrom) addToWindow(stats.windows.today, entry);
    if (entry.at >= last30dFrom) addToWindow(stats.windows.last30d, entry);
    const bucket = (stats.bySurface[entry.surface] ??= {
      calls: 0,
      usd: 0,
      noAnswer: 0,
      last30d: { jev: 0, rule: 0, usd: 0 },
      decisions: {},
      feedback: { right: 0, wrong: 0 },
    });
    addOptimization(bucket, entry.optimization);
    if (entry.kind === 'optimization') continue;
    const provider = entry.provider ?? (entry.model === 'clef' || entry.model === 'clef-flash' || entry.model === 'clef-omni' || entry.model.startsWith('@cf/cloudflare/') ? 'clef' : 'jev');
    addProviderUsage(stats.byProvider, provider, entry);
    addProviderUsage(stats.byModel, entry.model, entry);
    if (entry.missionId && !isUnavailableMarker(entry)) addMissionUsage(stats.byMission, entry.missionId, provider, entry);
    stats.totals.usd += entry.usd ?? 0;
    stats.totals.inputTokens += entry.inputTokens ?? 0;
    bucket.usd += entry.usd ?? 0;
    if (entry.at >= last30dFrom) bucket.last30d.usd += entry.usd ?? 0;
    if (isNoAnswer) {
      bucket.noAnswer += 1;
      stats.totals.noAnswer += 1;
      if (entry.at >= last30dFrom) bucket.last30d.rule += 1;
      continue;
    }
    stats.totals.calls += 1;
    bucket.calls += 1;
    if (entry.at >= last30dFrom) {
      bucket.last30d.jev += 1;
    }
    bucket.decisions[entry.decision] = (bucket.decisions[entry.decision] ?? 0) + 1;
    if (entry.feedback === 'right') bucket.feedback.right += 1;
    if (entry.feedback === 'wrong') bucket.feedback.wrong += 1;
  }
  for (const bucket of Object.values(stats.bySurface)) {
    const total = bucket.feedback.right + bucket.feedback.wrong;
    if (total >= 10 && bucket.feedback.wrong / total >= 0.3) {
      bucket.suggestion =
        'Muitos erros nesta superfície: considere desligar ou revisar os limiares';
    } else if (total >= 10 && bucket.feedback.wrong / total <= 0.05) {
      bucket.suggestion = 'Estável: limiares podem ser relaxados';
    }
  }
  return stats;
}

/** Probabilidades normalizadas por tipo de resposta, para o diário. */
export function jevAnswerProbabilities(
  answers: Record<string, JevAnswer>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [id, a] of Object.entries(answers)) {
    if (a.type === 'noul') {
      out[id] = a.noul;
    } else if (a.type === 'choice') {
      out[id] = a.probabilities[a.choice] ?? 0;
    } else if (a.type === 'score') {
      const levels = Object.keys(a.legend).length;
      out[id] = levels > 1 ? a.score / (levels - 1) : a.score;
    }
  }
  return out;
}

/** Confiança por pergunta (choice/score trazem `confidence`). */
export function jevAnswerConfidences(
  answers: Record<string, JevAnswer>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [id, a] of Object.entries(answers)) {
    if ('confidence' in a && typeof a.confidence === 'number') {
      out[id] = a.confidence;
    }
  }
  return out;
}
