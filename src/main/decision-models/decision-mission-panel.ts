/**
 * F-1167: painel "Motor de decisão" da missão. Junta o gasto cobrado (livro
 * de orçamento em memória; para missão já esquecida pelo livro, o agregado do
 * diário), as chamadas por provedor (agregado assíncrono do diário, com cache
 * por mtime+tamanho), o orçamento efetivo e as dicas consultivas (F-1166).
 * Nada síncrono pesado: a autorização (missão do workspace do renderer) fica
 * no handler IPC. Nunca lança: falha vira `{ ok: false, reason: 'error' }`.
 */
import { missionDecisionBudgetUsd, type DecisionSettings } from '../../shared/decision-models';
import type { DecisionMissionPanelResult } from '../../shared/decision-engine-ui';
import type { MissionDecisionHints } from '../../shared/orch-types';
import type { JevMissionStats } from '../jev/jev-decision-log';

export interface DecisionMissionPanelDeps {
  readonly settings: () => DecisionSettings;
  /** Agregado do diário por missão (assíncrono, com cache). */
  readonly missionUsage: (missionId: string) => Promise<JevMissionStats | undefined>;
  /** Livro de orçamento em memória (já aquecido): cobrado e reservado em voo. */
  readonly budgetBook: (missionId: string, budgetUsd: number) => Promise<{ spentUsd: number; reservedUsd: number }>;
  readonly hints: (missionId: string) => MissionDecisionHints | undefined;
}

function finite(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

export async function buildDecisionMissionPanel(missionId: string, deps: DecisionMissionPanelDeps): Promise<DecisionMissionPanelResult> {
  try {
    const settings = deps.settings();
    const budgetUsd = missionDecisionBudgetUsd(settings);
    const [stats, book] = await Promise.all([deps.missionUsage(missionId), deps.budgetBook(missionId, budgetUsd)]);
    // O livro é a fonte do cobrado; missão concluída sai dele, e aí vale o que o diário registrou.
    const chargedUsd = Math.max(finite(book.spentUsd), finite(stats?.chargedUsd));
    const reservedUsd = finite(book.reservedUsd);
    const byProvider: Record<string, { calls: number; noAnswer: number; usd: number }> = {};
    for (const [provider, row] of Object.entries(stats?.byProvider ?? {})) {
      byProvider[provider] = { calls: row.calls, noAnswer: row.noAnswer, usd: finite(row.usd) };
    }
    return {
      ok: true, missionId, mode: settings.mode, budgetUsd, chargedUsd, reservedUsd, usd: finite(stats?.usd),
      calls: stats?.calls ?? 0, noAnswer: stats?.noAnswer ?? 0, budgetRefusals: stats?.budgetRefusals ?? 0,
      ratio: budgetUsd > 0 ? (chargedUsd + reservedUsd) / budgetUsd : 0, byProvider, hints: deps.hints(missionId) ?? null,
    };
  } catch {
    return { ok: false, reason: 'error' };
  }
}
