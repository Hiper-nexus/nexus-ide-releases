import {
  BOOTSTRAP_PROGRESS_STEPS,
  type BootstrapProgressStep,
} from '../../shared/mission-intent-projection';

/**
 * The live bootstrap step shown on the vacancy card.
 *
 * Pure: no store, no React, no IPC. The journal events arrive over IPC as
 * `unknown`, so parsing is defensive here and the component only renders the
 * result. Absence of events is never an error — the card falls back to the
 * static copy it always had.
 */
export interface PaneVacancyProgress {
  readonly missionId: string;
  readonly step: BootstrapProgressStep;
  readonly occurredAt: number;
}

const STEP_LABELS: Record<BootstrapProgressStep, string> = {
  authority_checked: 'Autoridade da missão verificada',
  subscription_auth: 'Confirmando sua assinatura',
  plan_baseline: 'Plano base selado',
  squad_sealed: 'Squad selado',
  prevc_freeze: 'Congelando o contexto preventivo',
  runtime_checked: 'Runtime do orquestrador confirmado',
  drift_retired: 'Sessões antigas aposentadas',
  attachments_verified: 'Anexos verificados',
  pane_spawned: 'Agente orquestrador iniciado',
  kickoff_submitted: 'Kickoff enviado ao orquestrador',
  kickoff_accepted: 'Kickoff aceito',
};

export function bootstrapStepLabel(step: BootstrapProgressStep): string {
  return STEP_LABELS[step];
}

/** "há 12s" / "há 3 min" — clock skew never renders a negative age. */
export function progressAgeLabel(occurredAt: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - occurredAt) / 1000));
  if (seconds < 60) return `há ${seconds}s`;
  return `há ${Math.floor(seconds / 60)} min`;
}

const KNOWN_STEPS: ReadonlySet<string> = new Set(BOOTSTRAP_PROGRESS_STEPS);

/**
 * Latest `bootstrap_progress` journal event for the mission, or null. The
 * renderer polls `missionEventsRecent`; picking the highest sequence makes
 * out-of-order pages harmless, and an unknown step name is dropped instead
 * of rendered raw.
 */
export function latestBootstrapProgress(
  events: readonly unknown[],
  missionId: string,
): PaneVacancyProgress | null {
  let best: PaneVacancyProgress | null = null;
  let bestSequence = -1;
  for (const raw of events) {
    if (!raw || typeof raw !== 'object') continue;
    const event = raw as Record<string, unknown>;
    if (event.missionId !== missionId) continue;
    const payload = event.payload;
    if (!payload || typeof payload !== 'object') continue;
    const record = payload as Record<string, unknown>;
    if (record.kind !== 'bootstrap_progress') continue;
    const step = record.step;
    if (typeof step !== 'string' || !KNOWN_STEPS.has(step)) continue;
    const sequence = typeof event.sequence === 'number' ? event.sequence : 0;
    if (sequence < bestSequence) continue;
    bestSequence = sequence;
    best = {
      missionId,
      step: step as BootstrapProgressStep,
      occurredAt:
        typeof event.occurredAt === 'number' ? event.occurredAt : 0,
    };
  }
  return best;
}
