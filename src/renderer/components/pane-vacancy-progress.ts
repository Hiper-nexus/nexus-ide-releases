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

/**
 * Este é o único texto que se move na tela entre "Iniciar missão" e o primeiro
 * agente — o momento de maior ansiedade de quem não programa. As etiquetas são
 * escritas em português de gente. O identificador cru da etapa não aparece
 * na tela: para diagnosticar um bootstrap preso, use o journal da missão, não
 * o screenshot do usuário.
 */
const STEP_LABELS: Record<BootstrapProgressStep, string> = {
  authority_checked: 'Conferindo permissões',
  subscription_auth: 'Confirmando sua assinatura',
  plan_baseline: 'Fechando o plano de trabalho',
  squad_sealed: 'Equipe definida',
  prevc_freeze: 'Lendo o projeto',
  runtime_checked: 'Preparando o coordenador',
  drift_retired: 'Limpando execuções antigas',
  attachments_verified: 'Conferindo os anexos',
  pane_spawned: 'Abrindo o coordenador',
  kickoff_submitted: 'Enviando o objetivo à equipe',
  kickoff_accepted: 'A equipe recebeu o objetivo',
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

/** Live chef-idle state: orchestrator idle while workers are present. */
export interface ChefIdleProgress {
  readonly missionId: string;
  readonly workerCount: number;
  readonly occurredAt: number;
}

/**
 * Latest `chef_idle_awaiting_workers` journal event for the mission, or null.
 * Out-of-order pages are handled by picking the highest sequence.
 */
export function latestChefIdleProgress(
  events: readonly unknown[],
  missionId: string,
): ChefIdleProgress | null {
  let best: ChefIdleProgress | null = null;
  let bestSequence = -1;
  for (const raw of events) {
    if (!raw || typeof raw !== 'object') continue;
    const event = raw as Record<string, unknown>;
    if (event.missionId !== missionId) continue;
    const payload = event.payload;
    if (!payload || typeof payload !== 'object') continue;
    const record = payload as Record<string, unknown>;
    if (record.kind !== 'chef_idle_awaiting_workers') continue;
    const sequence = typeof event.sequence === 'number' ? event.sequence : 0;
    if (sequence < bestSequence) continue;
    bestSequence = sequence;
    best = {
      missionId,
      workerCount:
        typeof record.workerCount === 'number' ? record.workerCount : 0,
      occurredAt:
        typeof event.occurredAt === 'number' ? event.occurredAt : 0,
    };
  }
  return best;
}

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
