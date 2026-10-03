// F-773 (G6): o log de decisões de rota (`nexus_route_log`) vivia só em
// memória, com teto de 50, e voltava vazio a cada boot. A mesma linha agora
// persiste na tabela `route_decisions` do checkout (migração 042), com as
// alternativas que disputaram — a auditoria "por que X perdeu" sobrevive ao
// restart. Uma escrita por decisão de rota (operação discreta, nunca por
// chunk de PTY); retenção de 30 dias / 5.000 linhas aplicada na mesma escrita.
import { z } from 'zod';
import {
  parseSpawnRouteConfidence,
  parseSpawnRuleChoice,
} from '../../shared/spawn-route';
import {
  parseRouteLogAlternatives,
  type RouteLogEntry,
  type RouteLogSink,
} from './route-log';
import type { ScopedStoreBinding } from './scoped-store';

export const ROUTE_DECISION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const ROUTE_DECISION_MAX_ROWS = 5_000;
const ROUTE_DECISION_REASON_MAX_CHARS = 16_384;

const rowSchema = z
  .object({
    seq: z.number().int().positive(),
    mission_id: z.string().nullable(),
    task_preview: z.string(),
    tier: z.string(),
    adapter_id: z.string().min(1),
    model: z.string().nullable(),
    effort: z.string().nullable(),
    reason: z.string(),
    classifier_source: z.string().nullable(),
    jev_unavailable: z.string().nullable(),
    confidence_json: z.string().nullable(),
    rule_choice_json: z.string().nullable(),
    alternatives_json: z.string().nullable(),
    created_at: z.number().int().nonnegative(),
  })
  .strict();

function parseJson(raw: string | null): unknown {
  if (raw === null) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

/** Linha que não passa no schema é pulada: um registro ruim não cega a auditoria. */
function entryFromRow(raw: unknown): RouteLogEntry | null {
  const parsed = rowSchema.safeParse(raw);
  if (!parsed.success) return null;
  const row = parsed.data;
  const confidence = parseSpawnRouteConfidence(parseJson(row.confidence_json));
  const ruleChoice = parseSpawnRuleChoice(parseJson(row.rule_choice_json));
  const alternatives = parseRouteLogAlternatives(parseJson(row.alternatives_json));
  return {
    seq: row.seq,
    taskPreview: row.task_preview,
    tier: row.tier,
    adapterId: row.adapter_id,
    ...(row.model !== null ? { model: row.model } : {}),
    ...(row.effort !== null ? { effort: row.effort } : {}),
    reason: row.reason,
    ...(row.classifier_source !== null ? { classifierSource: row.classifier_source } : {}),
    ...(row.jev_unavailable !== null ? { jevUnavailable: row.jev_unavailable } : {}),
    ...(confidence ? { confidence } : {}),
    ...(ruleChoice ? { ruleChoice } : {}),
    ...(row.mission_id !== null ? { missionId: row.mission_id } : {}),
    ...(alternatives ? { alternatives } : {}),
    at: row.created_at,
  };
}

const clip = (value: string | undefined, max: number): string | null =>
  value === undefined || value.length === 0 ? null : value.slice(0, max);

/**
 * Coletor durável do route-log, no binding do store de missões (mesmo banco,
 * relógio e transação). Não emite `change`: a decisão de rota não muda nada
 * que a tela da missão mostre.
 */
export class RouteDecisionLedger implements RouteLogSink {
  readonly #binding: ScopedStoreBinding;

  constructor(binding: ScopedStoreBinding) {
    this.#binding = binding;
  }

  append(entry: RouteLogEntry): void {
    const now = this.#binding.now();
    const db = this.#binding.writeDatabase();
    db.transaction(() => {
      db.prepare(
        `INSERT INTO route_decisions
           (mission_id, task_preview, tier, adapter_id, model, effort, reason,
            classifier_source, jev_unavailable, confidence_json,
            rule_choice_json, alternatives_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        clip(entry.missionId, 256),
        entry.taskPreview.slice(0, 120),
        entry.tier.slice(0, 32),
        entry.adapterId.slice(0, 128),
        clip(entry.model, 256),
        clip(entry.effort, 64),
        entry.reason.slice(0, ROUTE_DECISION_REASON_MAX_CHARS),
        clip(entry.classifierSource, 32),
        clip(entry.jevUnavailable, 64),
        entry.confidence ? JSON.stringify(entry.confidence) : null,
        entry.ruleChoice ? JSON.stringify(entry.ruleChoice) : null,
        entry.alternatives ? JSON.stringify(entry.alternatives) : null,
        now,
      );
      db.prepare(`DELETE FROM route_decisions WHERE created_at < ?`).run(
        now - ROUTE_DECISION_RETENTION_MS,
      );
      db.prepare(
        `DELETE FROM route_decisions
          WHERE seq <= (SELECT MAX(seq) FROM route_decisions) - ?`,
      ).run(ROUTE_DECISION_MAX_ROWS);
    })();
  }

  recent(limit: number): RouteLogEntry[] {
    const capped = Math.max(0, Math.min(ROUTE_DECISION_MAX_ROWS, Math.floor(limit)));
    if (capped === 0) return [];
    const rows = this.#binding
      .readDatabase()
      .prepare(
        `SELECT seq, mission_id, task_preview, tier, adapter_id, model, effort,
                reason, classifier_source, jev_unavailable, confidence_json,
                rule_choice_json, alternatives_json, created_at
           FROM route_decisions
          ORDER BY seq DESC
          LIMIT ?`,
      )
      .all(capped);
    return rows.flatMap((row) => {
      const entry = entryFromRow(row);
      return entry ? [entry] : [];
    });
  }
}
