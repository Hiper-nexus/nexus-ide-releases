/**
 * Tabela de qualidade do roteador custo×qualidade (F-1165). Gerada a partir de
 * `evaluateDecisionCases` e persistida em userData como JSON versionado. A
 * leitura é tolerante: arquivo ausente, corrompido ou de outra versão vira
 * `null`, e o roteador usa os priors embutidos. Nada aqui lança.
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { DecisionEvalReport } from './decision-evaluation';
import type { JevNoAnswerReason } from '../jev/jev-decision-log';

export const DECISION_MODEL_KEYS = ['jev', 'clef', 'clef-flash', 'clef-omni', 'luna'] as const;
export type DecisionModelKey = typeof DECISION_MODEL_KEYS[number];

export const DECISION_QUALITY_TABLE_VERSION = 1;
/** Abaixo disto a medição local não substitui o prior. */
export const MIN_QUALITY_CASES = 5;

const cellSchema = z.object({
  accuracy: z.number().finite().min(0).max(1),
  cases: z.number().int().min(0),
  p50Ms: z.number().finite().min(0).nullable().optional(),
}).strip();
const modelCellsSchema = z.partialRecord(z.enum(DECISION_MODEL_KEYS), cellSchema);

export const decisionQualityTableSchema = z.object({
  version: z.literal(DECISION_QUALITY_TABLE_VERSION),
  generatedAt: z.number().finite(),
  source: z.literal('evaluateDecisionCases'),
  models: modelCellsSchema,
  surfaces: z.record(z.string().min(1).max(64), modelCellsSchema),
}).strip();

export type DecisionQualityCell = z.infer<typeof cellSchema>;
export type DecisionQualityTable = z.infer<typeof decisionQualityTableSchema>;

export interface DecisionQualityEstimate { quality: number; source: 'local-evaluation' | 'prior'; p50Ms: number | null }

export type QualityModality = 'text' | 'image' | 'audio';

/**
 * Priors embutidos (sem medição local). Texto: o Jev segue o padrão; nas
 * surfaces de escolha barata (toolPick, triagem, ranking) o benchmark público
 * favorece o Clef e o Flash leva pelo custo. Imagem: o Omni entende imagem por
 * menos que o Clef cheio. Áudio: só o Omni ouve.
 */
const TEXT_PRIORS: Record<DecisionModelKey, number> = { jev: 0.80, clef: 0.82, 'clef-flash': 0.77, 'clef-omni': 0.79, luna: 0.80 };
const CHEAP_CHOICE_PRIORS: Record<DecisionModelKey, number> = { jev: 0.78, clef: 0.86, 'clef-flash': 0.84, 'clef-omni': 0.82, luna: 0.80 };
const IMAGE_PRIORS: Record<DecisionModelKey, number> = { jev: 0, clef: 0.84, 'clef-flash': 0, 'clef-omni': 0.83, luna: 0.77 };
const AUDIO_PRIORS: Record<DecisionModelKey, number> = { jev: 0, clef: 0, 'clef-flash': 0, 'clef-omni': 0.85, luna: 0 };
const CHEAP_CHOICE_SURFACES = new Set(['toolPick', 'researchTriage', 'rank', 'rankTool']);
/**
 * F-1166: julgamento sobre trabalho entregue (risco de regressão, cobertura
 * do objetivo). Prior favorece modelo de raciocínio; ainda consultivo.
 */
const JUDGMENT_PRIORS: Record<DecisionModelKey, number> = { jev: 0.80, clef: 0.84, 'clef-flash': 0.75, 'clef-omni': 0.79, luna: 0.84 };
const JUDGMENT_SURFACES = new Set(['reviewTriage', 'completionCheck']);

export function decisionQualityPrior(surface: string | undefined, model: DecisionModelKey, modality: QualityModality): number {
  if (modality === 'image') return IMAGE_PRIORS[model];
  if (modality === 'audio') return AUDIO_PRIORS[model];
  if (surface && JUDGMENT_SURFACES.has(surface)) return JUDGMENT_PRIORS[model];
  return (surface && CHEAP_CHOICE_SURFACES.has(surface) ? CHEAP_CHOICE_PRIORS : TEXT_PRIORS)[model];
}

/**
 * Medição local da surface, depois a global do modelo, depois o prior.
 * Imagem/áudio só usam medição da surface. Acurácia medida 0 é tratada como
 * medição suspeita (credencial, endpoint): cai no prior em vez de enterrar o modelo.
 */
export function decisionQuality(
  table: DecisionQualityTable | null, surface: string | undefined, model: DecisionModelKey, modality: QualityModality,
): DecisionQualityEstimate {
  const local = surface ? table?.surfaces[surface]?.[model] : undefined;
  if (local && local.cases >= MIN_QUALITY_CASES && local.accuracy > 0) return { quality: local.accuracy, source: 'local-evaluation', p50Ms: local.p50Ms ?? null };
  const global = modality === 'text' ? table?.models[model] : undefined;
  if (global && global.cases >= MIN_QUALITY_CASES && global.accuracy > 0) return { quality: global.accuracy, source: 'local-evaluation', p50Ms: global.p50Ms ?? null };
  return { quality: decisionQualityPrior(surface, model, modality), source: 'prior', p50Ms: null };
}

let injectedFile: string | undefined;
let cache: { file: string; stamp: string; checkedAt: number; table: DecisionQualityTable | null } | undefined;
/** Sem `stat` a cada decisão: a tabela muda raramente (calibração manual). */
export const QUALITY_TABLE_TTL_MS = 5_000;
let clock: () => number = Date.now;

/** Para testes: relógio do TTL do cache. */
export function configureDecisionQualityClock(now?: () => number): void {
  clock = now ?? Date.now;
}

/** Para testes: fixa o arquivo; `undefined` volta ao userData. */
export function configureDecisionQualityTable(file?: string): void {
  injectedFile = file;
  cache = undefined;
}

function qualityTableFile(): string | null {
  if (injectedFile) return injectedFile;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- fora do Electron (vitest) `app` não existe
    const electron = require('electron') as { app?: { getPath(name: 'userData'): string } };
    if (typeof electron?.app?.getPath !== 'function') return null;
    return path.join(electron.app.getPath('userData'), 'decision-models', 'quality-table.json');
  } catch {
    return null;
  }
}

/** `null` = sem tabela válida: o roteador usa os priors. Relida quando mtime/tamanho mudam. */
export function readDecisionQualityTable(): DecisionQualityTable | null {
  const file = qualityTableFile();
  if (!file) return null;
  const at = clock();
  if (cache?.file === file && at - cache.checkedAt >= 0 && at - cache.checkedAt < QUALITY_TABLE_TTL_MS) return cache.table;
  let stamp: string;
  try {
    const stat = fs.statSync(file);
    stamp = `${stat.mtimeMs}:${stat.size}`;
  } catch {
    cache = { file, stamp: 'missing', checkedAt: at, table: null };
    return null;
  }
  if (cache?.file === file && cache.stamp === stamp) {
    cache.checkedAt = at;
    return cache.table;
  }
  let table: DecisionQualityTable | null = null;
  try {
    const parsed = decisionQualityTableSchema.safeParse(JSON.parse(fs.readFileSync(file, 'utf8')));
    table = parsed.success ? parsed.data : null;
  } catch {
    table = null;
  }
  cache = { file, stamp, checkedAt: at, table };
  return table;
}

function percentile50(values: readonly number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.5) - 1)];
}

/**
 * Falha que é indisponibilidade (rede, limite, credencial, queda) não mede
 * qualidade: sai do denominador. Só resposta inválida/recusa/ambígua conta como erro.
 */
const QUALITY_FAILURES: ReadonlySet<JevNoAnswerReason> = new Set<JevNoAnswerReason>(['malformed', 'refusal', 'ambiguous', 'divergent']);

export function isQualityObservation(row: DecisionEvalReport['observations'][number]): boolean {
  if (row.status === 'unsupported') return false;
  if (row.status === 'answered') return true;
  return row.failureReason !== undefined && QUALITY_FAILURES.has(row.failureReason);
}

function cellOf(rows: DecisionEvalReport['observations']): DecisionQualityCell | undefined {
  const eligible = rows.filter(isQualityObservation);
  if (!eligible.length) return undefined;
  const correct = eligible.filter(row => row.correct === true).length;
  return { accuracy: correct / eligible.length, cases: eligible.length,
    p50Ms: percentile50(eligible.flatMap(row => row.status === 'answered' && row.durationMs !== null ? [row.durationMs] : [])) };
}

/** Falha de qualidade conta como erro; indisponibilidade e caso sem suporte ficam fora. */
export function buildDecisionQualityTable(report: DecisionEvalReport, now = Date.now()): DecisionQualityTable {
  const models: DecisionQualityTable['models'] = {};
  const surfaces: DecisionQualityTable['surfaces'] = {};
  for (const model of DECISION_MODEL_KEYS) {
    const rows = report.observations.filter(row => row.requestedModel === model);
    const cell = cellOf(rows);
    if (cell) models[model] = cell;
    for (const surface of new Set(rows.map(row => row.surface))) {
      const surfaceCell = cellOf(rows.filter(row => row.surface === surface));
      if (surfaceCell) (surfaces[surface] ??= {})[model] = surfaceCell;
    }
  }
  return { version: DECISION_QUALITY_TABLE_VERSION, generatedAt: now, source: 'evaluateDecisionCases', models, surfaces };
}

/** Grava a tabela (tmp + rename). `false` = sem userData ou erro de fs; nunca lança. */
export function writeDecisionQualityTable(report: DecisionEvalReport, deps?: { file?: string; now?: number }): boolean {
  const file = deps?.file ?? qualityTableFile();
  if (!file) return false;
  try {
    const table = decisionQualityTableSchema.parse(buildDecisionQualityTable(report, deps?.now));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(table, null, 2));
    fs.renameSync(tmp, file);
    cache = undefined;
    return true;
  } catch (error) {
    console.warn(`[decision-models] quality table write failed (${error instanceof Error ? error.name : 'unknown'})`);
    return false;
  }
}
