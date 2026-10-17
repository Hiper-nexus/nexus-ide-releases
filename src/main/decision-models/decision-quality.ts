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
export const MIN_QUALITY_CASES = 20;

const cellSchema = z.object({
  accuracy: z.number().finite().min(0).max(1),
  cases: z.number().int().min(0),
  p50Ms: z.number().finite().min(0).nullable().optional(),
  /** F-1167: quando ESTA célula foi medida (a mescla preserva células de calibrações antigas). */
  generatedAt: z.number().finite().optional(),
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

/**
 * `local-evaluation` = célula medida DA PRÓPRIA surface com casos suficientes;
 * `blended` = medição global do modelo misturada ao prior da surface;
 * `prior` = só o embutido. `surfaceCases` = casos medidos na própria surface.
 */
export interface DecisionQualityEstimate {
  quality: number; source: 'local-evaluation' | 'blended' | 'prior'; p50Ms: number | null; surfaceCases: number;
}

/**
 * Peso do prior da surface (em "casos") ao misturar com a medição global: um
 * conjunto pequeno de calibração não apaga sozinho o conhecimento da surface.
 */
export const PRIOR_WEIGHT_CASES = 30;

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
 * Medição local da PRÓPRIA surface (≥ MIN_QUALITY_CASES) substitui o prior.
 * Sem ela, a medição global do modelo (só texto) é MISTURADA ao prior da
 * surface, ponderada pelo nº de casos (o prior pesa PRIOR_WEIGHT_CASES): poucos
 * casos de outras surfaces não decidem sozinhos esta. Imagem/áudio só usam
 * medição da surface. Acurácia medida 0 é suspeita (credencial, endpoint): ignorada.
 */
export function decisionQuality(
  table: DecisionQualityTable | null, surface: string | undefined, model: DecisionModelKey, modality: QualityModality,
): DecisionQualityEstimate {
  const local = surface ? table?.surfaces[surface]?.[model] : undefined;
  const surfaceCases = local && local.accuracy > 0 ? local.cases : 0;
  if (local && local.cases >= MIN_QUALITY_CASES && local.accuracy > 0) {
    return { quality: local.accuracy, source: 'local-evaluation', p50Ms: local.p50Ms ?? null, surfaceCases };
  }
  const prior = decisionQualityPrior(surface, model, modality);
  const global = modality === 'text' ? table?.models[model] : undefined;
  if (global && global.cases >= MIN_QUALITY_CASES && global.accuracy > 0) {
    const quality = (prior * PRIOR_WEIGHT_CASES + global.accuracy * global.cases) / (PRIOR_WEIGHT_CASES + global.cases);
    return { quality, source: 'blended', p50Ms: global.p50Ms ?? null, surfaceCases };
  }
  return { quality: prior, source: 'prior', p50Ms: null, surfaceCases };
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

function cellOf(rows: DecisionEvalReport['observations'], now: number): DecisionQualityCell | undefined {
  const eligible = rows.filter(isQualityObservation);
  if (!eligible.length) return undefined;
  const correct = eligible.filter(row => row.correct === true).length;
  return { accuracy: correct / eligible.length, cases: eligible.length,
    p50Ms: percentile50(eligible.flatMap(row => row.status === 'answered' && row.durationMs !== null ? [row.durationMs] : [])),
    generatedAt: now };
}

/**
 * Falha de qualidade conta como erro; indisponibilidade e caso sem suporte
 * ficam fora. Só ganha célula o par (surface, modelo) medido de fato.
 */
export function buildDecisionQualityTable(report: DecisionEvalReport, now = Date.now()): DecisionQualityTable {
  const models: DecisionQualityTable['models'] = {};
  const surfaces: DecisionQualityTable['surfaces'] = {};
  for (const model of DECISION_MODEL_KEYS) {
    const rows = report.observations.filter(row => row.requestedModel === model);
    const cell = cellOf(rows, now);
    if (cell) models[model] = cell;
    for (const surface of new Set(rows.map(row => row.surface))) {
      const surfaceCell = cellOf(rows.filter(row => row.surface === surface), now);
      if (surfaceCell) (surfaces[surface] ??= {})[model] = surfaceCell;
    }
  }
  return { version: DECISION_QUALITY_TABLE_VERSION, generatedAt: now, source: 'evaluateDecisionCases', models, surfaces };
}

/**
 * F-1167: mescla uma calibração nova na tabela atual. Só as células que a
 * nova mediu de fato são trocadas; as demais (modelo sem credencial agora,
 * indisponível, surface fora do conjunto) ficam com a medição antiga e a
 * data dela (`generatedAt` da célula, ou o da tabela antiga).
 */
export function mergeDecisionQualityTables(previous: DecisionQualityTable | null, next: DecisionQualityTable): DecisionQualityTable {
  if (!previous) return next;
  const dated = (cell: DecisionQualityCell): DecisionQualityCell => ({ ...cell, generatedAt: cell.generatedAt ?? previous.generatedAt });
  const models: DecisionQualityTable['models'] = {};
  for (const model of DECISION_MODEL_KEYS) {
    const cell = next.models[model] ?? (previous.models[model] ? dated(previous.models[model]!) : undefined);
    if (cell) models[model] = cell;
  }
  const surfaces: DecisionQualityTable['surfaces'] = {};
  for (const surface of new Set([...Object.keys(previous.surfaces), ...Object.keys(next.surfaces)])) {
    for (const model of DECISION_MODEL_KEYS) {
      const fresh = next.surfaces[surface]?.[model];
      const old = previous.surfaces[surface]?.[model];
      const cell = fresh ?? (old ? dated(old) : undefined);
      if (cell) (surfaces[surface] ??= {})[model] = cell;
    }
  }
  return { ...next, models, surfaces };
}

/** Lê o arquivo agora (sem cache): base da mescla. Ausente/ilegível = sem tabela. */
function readTableFile(file: string): DecisionQualityTable | null {
  try {
    const parsed = decisionQualityTableSchema.safeParse(JSON.parse(fs.readFileSync(file, 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Mescla e grava (tmp + rename). Devolve a tabela gravada; `null` = sem
 * userData ou erro de fs. Nunca lança.
 */
export function mergeAndWriteDecisionQualityTable(
  report: DecisionEvalReport, deps?: { file?: string; now?: number },
): DecisionQualityTable | null {
  const file = deps?.file ?? qualityTableFile();
  if (!file) return null;
  try {
    const table = decisionQualityTableSchema.parse(
      mergeDecisionQualityTables(readTableFile(file), buildDecisionQualityTable(report, deps?.now)));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(table, null, 2));
    fs.renameSync(tmp, file);
    cache = undefined;
    return table;
  } catch (error) {
    console.warn(`[decision-models] quality table write failed (${error instanceof Error ? error.name : 'unknown'})`);
    return null;
  }
}

/** Grava a tabela mesclando com a atual. `false` = sem userData ou erro de fs; nunca lança. */
export function writeDecisionQualityTable(report: DecisionEvalReport, deps?: { file?: string; now?: number }): boolean {
  return mergeAndWriteDecisionQualityTable(report, deps) !== null;
}

/** Quando a medição de um modelo foi feita (global de texto), para a UI marcar medição antiga. */
export function decisionQualityMeasuredAt(table: DecisionQualityTable | null, model: DecisionModelKey): number | null {
  const cell = table?.models[model];
  return cell ? cell.generatedAt ?? table!.generatedAt : null;
}
