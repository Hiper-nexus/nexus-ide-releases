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
 */

import {
  parseSpawnRouteConfidence,
  parseSpawnRuleChoice,
  type SpawnRouteConfidence,
  type SpawnRuleChoiceReceipt,
} from '../../shared/spawn-route';

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
}

const LOG_CAP = 50;
const TASK_PREVIEW_CHARS = 120;

let log: RouteLogEntry[] = [];
let seq = 0;

export function clearRouteLog(): void {
  log = [];
  seq = 0;
}

export function recordRouteLog(input: RouteLogInput): RouteLogEntry {
  seq += 1;
  // Passa pelos sanitizadores do recibo: só ids e números entram no diário.
  const confidence = parseSpawnRouteConfidence(input.confidence);
  const ruleChoice = parseSpawnRuleChoice(input.ruleChoice);
  const entry: RouteLogEntry = {
    seq,
    taskPreview: input.task.slice(0, TASK_PREVIEW_CHARS),
    tier: input.tier,
    adapterId: input.adapterId,
    model: input.model,
    effort: input.effort,
    reason: input.reason,
    ...(input.classifierSource ? { classifierSource: input.classifierSource } : {}),
    ...(input.jevUnavailable ? { jevUnavailable: input.jevUnavailable } : {}),
    ...(confidence ? { confidence } : {}),
    ...(ruleChoice ? { ruleChoice } : {}),
  };
  log = [...log.slice(-(LOG_CAP - 1)), entry];
  return entry;
}

/** Most-recent-first snapshot, capped at `limit` (default all retained). */
export function recentRouteLog(limit = LOG_CAP): RouteLogEntry[] {
  return [...log].reverse().slice(0, Math.max(0, limit));
}
