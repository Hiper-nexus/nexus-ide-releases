/**
 * Route decision log — a short, inspectable history of what the router chose
 * and WHY, so a mission's adapter selection stops being invisible. Pure logic
 * (no electron/sqlite): the MCP handler records each nexus_route_task result
 * here; a debug/inspect surface (and the orchestration panel) can read it back.
 *
 * "Ver para crer" (Onda 1): before this, the reason existed only in the
 * router's return value the LLM consumed — the user could never see why Kimi
 * lost to Codex. Now the last N decisions are queryable with their tier,
 * pick, effort and human-readable reason.
 *
 * F-773 (G6): a memória (teto 50) sumia a cada boot. Quem chama passa um
 * `RouteLogSink` (a tabela `route_decisions` do checkout, ver
 * route-decision-ledger.ts) e a linha também persiste; sem coletor, ou com
 * ele falhando, fica a memória de sempre.
 */

import {
  parseSpawnRouteConfidence,
  parseSpawnRuleChoice,
  type SpawnRouteConfidence,
  type SpawnRuleChoiceReceipt,
} from '../../shared/spawn-route';
import { redactSecretText } from '../terminal/command-redaction';

export interface RouteLogEntry {
  /** Monotonic ordinal (no Date in pure logic); higher = newer. */
  seq: number;
  taskPreview: string;
  tier: string;
  adapterId: string;
  model?: string;
  effort?: string;
  reason: string;
  /** jev | mixed | heuristic — de onde veio tier/especialidade. */
  classifierSource?: string;
  /** Motivo da queda para a heurística quando o Jev não respondeu. */
  jevUnavailable?: string;
  /** Confiança do Jev só nas dimensões que ele decidiu (números 0..1). */
  confidence?: SpawnRouteConfidence;
  /** O que a regra teria escolhido sem o Jev ('same' = a mesma coisa). */
  ruleChoice?: SpawnRuleChoiceReceipt;
  /** F-773: missão da decisão (rota sem missão = fan-out do operador). */
  missionId?: string;
  /** F-773: quem disputou e perdeu, na ordem do ranking — só ids. */
  alternatives?: RouteLogAlternative[];
  /** F-773: instante gravado pelo coletor persistente (a memória não tem relógio). */
  at?: number;
}

export interface RouteLogAlternative {
  adapterId: string;
  model?: string;
}

export interface RouteLogInput {
  task: string;
  tier: string;
  adapterId: string;
  model?: string;
  effort?: string;
  reason: string;
  /** jev | mixed | heuristic — de onde veio tier/especialidade. */
  classifierSource?: string;
  /** Motivo da queda para a heurística quando o Jev não respondeu. */
  jevUnavailable?: string;
  /** Confiança do Jev só nas dimensões que ele decidiu (números 0..1). */
  confidence?: SpawnRouteConfidence;
  /** O que a regra teria escolhido sem o Jev ('same' = a mesma coisa). */
  ruleChoice?: SpawnRuleChoiceReceipt;
  missionId?: string;
  alternatives?: ReadonlyArray<{ adapterId?: unknown; model?: unknown }>;
}

/**
 * F-773 (G6): destino durável da mesma linha. `append` grava; `recent` lê as
 * mais novas primeiro. Erros do coletor nunca derrubam a rota.
 */
export interface RouteLogSink {
  append(entry: RouteLogEntry): void;
  recent(limit: number): RouteLogEntry[];
}

const LOG_CAP = 50;
const ALTERNATIVES_CAP = 12;
const ALTERNATIVE_ID_MAX_CHARS = 256;
const TASK_PREVIEW_CHARS = 120;
/** Redact before clipping; the extra fixed window covers a token crossing the
 * visible preview boundary without scanning arbitrary prompt lengths. */
export function routeTaskPreview(task: string): string {
  // Preview truncation may hide the signature of a JWT. Conservatively mask
  // its recognizable encoded JSON prefix even when the token is incomplete.
  const window = task.slice(0, TASK_PREVIEW_CHARS + 512)
    .replace(/\beyJ[A-Za-z0-9_-]{7,}(?:\.[A-Za-z0-9_-]*){0,2}/g, '[REDACTED]');
  return redactSecretText(window).text.slice(0, TASK_PREVIEW_CHARS);
}

let log: RouteLogEntry[] = [];
let seq = 0;

export function clearRouteLog(): void {
  log = [];
  seq = 0;
}

/** Só ids de CLI/modelo, na ordem do ranking, com teto — nunca texto livre. */
export function parseRouteLogAlternatives(raw: unknown): RouteLogAlternative[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const id = (value: unknown): string | undefined =>
    typeof value === 'string' && value.length > 0 && value.length <= ALTERNATIVE_ID_MAX_CHARS
      ? value
      : undefined;
  const picked: RouteLogAlternative[] = [];
  for (const item of raw.slice(0, ALTERNATIVES_CAP)) {
    if (!item || typeof item !== 'object') continue;
    const source = item as Record<string, unknown>;
    const adapterId = id(source.adapterId);
    if (!adapterId) continue;
    const model = id(source.model);
    picked.push({ adapterId, ...(model ? { model } : {}) });
  }
  return picked.length > 0 ? picked : undefined;
}

export function recordRouteLog(
  input: RouteLogInput,
  sink?: RouteLogSink | null,
): RouteLogEntry {
  seq += 1;
  // Passa pelos sanitizadores do recibo: só ids e números entram no diário.
  const confidence = parseSpawnRouteConfidence(input.confidence);
  const ruleChoice = parseSpawnRuleChoice(input.ruleChoice);
  const alternatives = parseRouteLogAlternatives(input.alternatives);
  const entry: RouteLogEntry = {
    seq,
    taskPreview: routeTaskPreview(input.task),
    tier: input.tier,
    adapterId: input.adapterId,
    model: input.model,
    effort: input.effort,
    reason: input.reason,
    ...(input.classifierSource ? { classifierSource: input.classifierSource } : {}),
    ...(input.jevUnavailable ? { jevUnavailable: input.jevUnavailable } : {}),
    ...(confidence ? { confidence } : {}),
    ...(ruleChoice ? { ruleChoice } : {}),
    ...(input.missionId ? { missionId: input.missionId } : {}),
    ...(alternatives ? { alternatives } : {}),
  };
  log = [...log.slice(-(LOG_CAP - 1)), entry];
  if (sink) {
    try {
      sink.append(entry);
    } catch (error) {
      console.warn('[route-log] persistência falhou (fica só a memória):', error);
    }
  }
  return entry;
}

/**
 * Most-recent-first snapshot, capped at `limit` (default all retained). Com
 * coletor legível, a fonte é a persistida — sobrevive ao restart.
 */
export function recentRouteLog(
  limit = LOG_CAP,
  sink?: RouteLogSink | null,
): RouteLogEntry[] {
  const capped = Math.max(0, limit);
  if (sink) {
    try {
      return sink.recent(capped).slice(0, capped);
    } catch (error) {
      console.warn('[route-log] leitura persistida falhou (usando a memória):', error);
    }
  }
  return [...log].reverse().slice(0, capped);
}
