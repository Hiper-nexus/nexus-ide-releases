import type {
  HandoffStatus,
  Mission,
  MissionStatus,
} from '../../shared/orch-types';
import type { MissionLane } from '../../shared/mission-intent';
import {
  hasAutomaticTechnicalRecovery,
  wasMissionRuntimeClosedByOperator,
} from '../../shared/mission-recovery-policy';
import { wasMissionLeftoverParked } from '../../shared/mission-leftover-isolation';
import {
  SESSION_DEAD_REASON_LABEL,
  SESSION_INTERRUPTED_REASON_LABEL,
} from '../../shared/session-restore-liveness';
import type { RailSectionId } from './mission-rail-prefs';

export interface RailSection {
  id: RailSectionId;
  label: string;
  missions: Mission[];
}

/** Missão “em andamento” pelo status do orquestrador (não só pelo grid). */
export function isInFlightStatus(status: MissionStatus): boolean {
  return status === 'running' || status === 'blocked';
}

/**
 * Runtime FÍSICO da missão, não o rótulo durável. Uma missão bloqueada cujo
 * orquestrador já morreu (ou que o operador acabou de encerrar) não tem
 * processo algum: ela está parada, não “em progresso”. Sem esta distinção o
 * rail nunca esvaziava — encerrar preservava a linha e a lista seguia cheia.
 */
export function missionHasLiveRuntime(
  mission: Mission,
  hasVisiblePanes: boolean,
): boolean {
  // Main persists the operator stop before awaiting physical exit. From that
  // instant the mission is no longer active work, even if the retired session
  // pointer and transcript panes remain visible during teardown.
  if (wasMissionRuntimeClosedByOperator(mission)) return false;
  if (wasMissionLeftoverParked(mission)) return false;
  // Durable completion is authoritative even while transcripts remain in the
  // grid or a stale orchestratorSessionId is still on the row. Main refuses
  // Encerrar on done ("não possui execução encerrável"), so treating leftover
  // panes as live runtime trapped the operator behind Encerrar forever —
  // Remover never appeared and the missão concluída could not be deleted.
  if (mission.status === 'done') return false;
  // Physical evidence first.
  if (hasVisiblePanes) return true;
  if (mission.orchestratorSessionId !== undefined) return true;
  if (mission.status === 'running') return true;
  // Field trap (28/07): a stale intent state is not evidence of life. A
  // mission left at `blocked` + `dispatched` with no session and no panes
  // still claimed a runtime, so the rail offered "Encerrar" forever and never
  // "Remover" — clicking it closed nothing ("nenhum processo restava vivo")
  // and the mission could never be deleted. A blocked mission with no session
  // has nothing to terminate, whatever its intent state says.
  if (mission.status === 'blocked') return false;
  // Otherwise the intent state still covers a mission whose pane bind failed
  // while its terminal is genuinely running.
  return (
    mission.intentState === 'dispatched' ||
    mission.intentState === 'executing' ||
    mission.intentState === 'validating'
  );
}

/**
 * Operational ownership extends across the short no-PTY interval between
 * technical retry attempts. This is intentionally broader than physical
 * liveness: the Main coordinator still owns the backoff and must keep the
 * mission in the active surface until it resumes or asks for a human.
 */
export function missionIsOperationallyActive(
  mission: Mission,
  hasVisiblePanes: boolean,
): boolean {
  return (
    missionHasLiveRuntime(mission, hasVisiblePanes) ||
    hasAutomaticTechnicalRecovery(mission)
  );
}

/**
 * Group missions into rail sections:
 * - pinned
 * - active ("Em progresso"): panes ao vivo no grid **ou** status running/blocked
 * - queue ("Na fila"): só pending (ainda não começou de verdade)
 * - done: done/failed e sem panes ao vivo
 *
 * Antes, só panes ao vivo iam para "Em progresso". Se o bind pane↔missão
 * falhasse (ou o layout mudasse), a missão com terminal rodando caía em
 * "Na fila" ou parecia sumir — bug de UX.
 */
export function groupMissionsForRail(opts: {
  missions: Mission[];
  openMissionIds: ReadonlySet<string>;
  pinnedIds: readonly string[];
  /** Escondidas pelo operador — histórico intacto, fora do caminho. */
  archivedIds?: readonly string[];
  query: string;
}): RailSection[] {
  const q = opts.query.trim().toLowerCase();
  const filtered = q
    ? opts.missions.filter(
        (m) =>
          m.title.toLowerCase().includes(q) ||
          m.description.toLowerCase().includes(q) ||
          m.status.toLowerCase().includes(q),
      )
    : opts.missions;

  const pinnedSet = new Set(opts.pinnedIds);
  const byUpdated = (a: Mission, b: Mission) => b.updatedAt - a.updatedAt;

  const isLive = (m: Mission): boolean =>
    missionHasLiveRuntime(m, opts.openMissionIds.has(m.id));
  const isOperationallyActive = (m: Mission): boolean =>
    missionIsOperationallyActive(m, opts.openMissionIds.has(m.id));

  // Uma missão arquivada que voltou a rodar ou entrou em retry técnico não
  // pode ficar escondida. Entre tentativas pode não existir um PTY físico por
  // alguns segundos, mas o Main ainda é dono do trabalho e do backoff.
  const archivedSet = new Set(
    (opts.archivedIds ?? []).filter((id) => {
      const mission = opts.missions.find((m) => m.id === id);
      return mission ? !isOperationallyActive(mission) : true;
    }),
  );
  const archived = filtered
    .filter((m) => archivedSet.has(m.id))
    .sort(byUpdated);
  const visible = filtered.filter((m) => !archivedSet.has(m.id));

  const pinned = visible
    .filter((m) => pinnedSet.has(m.id))
    .sort(byUpdated);

  const active = visible
    .filter((m) => isOperationallyActive(m) && !pinnedSet.has(m.id))
    .sort(byUpdated);

  const terminal: MissionStatus[] = ['done', 'failed'];
  const done = visible
    .filter(
      (m) =>
        terminal.includes(m.status) &&
        !isLive(m) &&
        !pinnedSet.has(m.id),
    )
    .sort(byUpdated);

  // Na fila = ainda não começou (pending) e sem runtime vivo.
  const queue = visible
    .filter(
      (m) => !pinnedSet.has(m.id) && !isLive(m) && m.status === 'pending',
    )
    .sort(byUpdated);

  // Encerradas = já despachadas, sem processo vivo. É aqui que a missão cai
  // quando o operador encerra: a linha e os receipts continuam, o rail limpa.
  const stopped = visible
    .filter(
      (m) =>
        !pinnedSet.has(m.id) &&
        !isOperationallyActive(m) &&
        m.status !== 'pending' &&
        !terminal.includes(m.status),
    )
    .sort(byUpdated);

  return [
    { id: 'pinned', label: 'Fixadas', missions: pinned },
    { id: 'active', label: 'Em progresso', missions: active },
    { id: 'queue', label: 'Na fila', missions: queue },
    { id: 'stopped', label: 'Encerradas', missions: stopped },
    { id: 'done', label: 'Concluídas', missions: done },
    { id: 'archived', label: 'Arquivadas', missions: archived },
  ] as const satisfies RailSection[];
}

export function statusLabel(s: MissionStatus): string {
  return (
    {
      pending: 'na fila',
      running: 'rodando',
      blocked: 'bloqueada',
      done: 'concluída',
      failed: 'falhou',
    }[s] ?? s
  );
}

/** Pill curta no card da rail — legível em 1 olhar. */
export type RailStatusTone =
  | 'live'
  | 'running'
  | 'blocked'
  | 'done'
  | 'failed'
  | 'pending';

export interface MissionRuntimeEvidence {
  /**
   * Physical process truth for the mission. `false` means the panes may still
   * be visible as preserved transcripts, but no agent can currently act.
   */
  readonly hasActiveRuntime?: boolean;
  /**
   * Whether this mission EVER materialized runtime (panes, workers, worktrees)
   * — independent of whether any of it is alive now. It is what separates a
   * mission parked before it ever started from one that ran, delivered work
   * and then stopped. Both can sit in `awaiting_approval`; only the second has
   * a plan and commits to lose.
   */
  readonly hasObservedRuntime?: boolean;
  /** Most recent worker report; informative, never enough to claim success. */
  readonly latestHandoffStatus?: HandoffStatus | null;
  /** Whether Main still owns a retry or already exhausted it. */
  readonly technicalRecovery?: 'recovering' | 'exhausted';
  /** leftover-park persist — rail shows Dormindo, never Precisa de você. */
  readonly leftoverParked?: boolean;
  /** Encerrar persist — rail shows Parou from SQLite, not session-dead. */
  readonly runtimeClosedByOperator?: boolean;
}

/** Cor do ponto segue o estado operacional, não só o status persistido. */
export function railDotStatus(
  status: MissionStatus,
  tone: RailStatusTone,
  liveInGrid: boolean,
): MissionStatus {
  if (tone === 'blocked' || tone === 'failed' || tone === 'done') return tone;
  if (tone === 'running' || tone === 'live') return 'running';
  return liveInGrid || status === 'running' ? 'running' : status;
}

export function railStatusDisplay(
  status: MissionStatus,
  liveInGrid: boolean,
  intentState?: Mission['intentState'],
  /** Delivery lane — plan mode needs a glanceable pill so ▶ promote is obvious. */
  lane?: MissionLane | null,
  evidence: MissionRuntimeEvidence = {},
): { label: string; tone: RailStatusTone } {
  // Durable terminal outcomes are authoritative even while their transcripts
  // remain visible in the grid. "No grid" is layout, not liveness.
  // Persisted legacy rows may still carry terminal labels even though the
  // current domain union models them through the separate rail section.
  const terminalStatus = status as string;
  if (terminalStatus === 'done') return { label: 'Concluída', tone: 'done' };
  if (terminalStatus === 'failed') return { label: 'Falhou', tone: 'failed' };
  // Isolamento leftover / Encerrar: persist blocked_user não é um pedido
  // humano. A rail diz Dormindo ou Parou — nunca "Precisa de você".
  if (evidence.runtimeClosedByOperator) {
    return { label: SESSION_DEAD_REASON_LABEL, tone: 'blocked' };
  }
  if (evidence.leftoverParked) {
    return { label: SESSION_INTERRUPTED_REASON_LABEL, tone: 'blocked' };
  }
  // Espera humana merece pill própria: "Na fila" esconde que a missão está
  // parada esperando VOCÊ (aprovar, dar objetivo, retomar) — o glance mais
  // importante do rail é exatamente esse.
  switch (intentState) {
    case 'awaiting_goal':
      return { label: 'Sem objetivo', tone: 'pending' };
    case 'intent_compiling':
      return { label: 'Processando', tone: 'pending' };
    case 'ready_to_start':
      return { label: 'Pronta', tone: 'pending' };
    case 'awaiting_approval':
      // Uma missão que JÁ rodou e voltou para awaiting_approval não está
      // esperando aprovação inicial: ela PAROU no meio (voo real 05/08,
      // mission-3be48989 — worker mandou handoff `blocked`, dispatch ficou
      // terminal, panes fecharam). Dar a ela o mesmo rótulo de uma missão
      // nova esconde que existe plano selado e trabalho commitado atrás.
      return evidence.hasObservedRuntime
        ? { label: 'Parou — aguarda você', tone: 'blocked' }
        : { label: 'Aguarda você', tone: 'blocked' };
    case 'blocked_user':
      return { label: 'Aguarda você', tone: 'blocked' };
    case 'blocked_technical':
      return evidence.technicalRecovery === 'exhausted'
        ? { label: 'Falha técnica', tone: 'failed' }
        : { label: 'Recuperando', tone: 'running' };
    default:
      break;
  }
  if (status === 'blocked') {
    return { label: 'Bloqueada', tone: 'blocked' };
  }

  // A preserved exited pane must never paint the mission as live. Failed and
  // blocked are reporter claims here (not completion authority), but they are
  // the clearest available reason for a fully stopped runtime.
  if (evidence.hasActiveRuntime === false) {
    if (evidence.latestHandoffStatus === 'failed') {
      return { label: 'Falhou', tone: 'failed' };
    }
    if (
      evidence.latestHandoffStatus === 'blocked' ||
      evidence.latestHandoffStatus === 'stalled'
    ) {
      return { label: 'Bloqueada', tone: 'blocked' };
    }
    if (status === 'running') {
      return { label: 'Execução encerrada', tone: 'blocked' };
    }
  }

  if (liveInGrid) {
    if (lane === 'plan') return { label: 'Plano ao vivo', tone: 'live' };
    if (lane === 'consult') return { label: 'Consulta ao vivo', tone: 'live' };
    if (lane === 'ops') return { label: 'Operação ao vivo', tone: 'live' };
    return { label: 'Ao vivo', tone: 'live' };
  }
  // After intent shells: plan/consult/ops lanes are not "Em curso" de código.
  if (lane === 'plan') return { label: 'Em plano', tone: 'running' };
  if (lane === 'consult') return { label: 'Consulta', tone: 'running' };
  if (lane === 'ops') return { label: 'Operação', tone: 'running' };
  switch (status) {
    case 'running':
      return { label: 'Em curso', tone: 'running' };
    case 'done':
      return { label: 'Concluída', tone: 'done' };
    case 'failed':
      return { label: 'Falhou', tone: 'failed' };
    case 'pending':
    default:
      return { label: 'Na fila', tone: 'pending' };
  }
}

/** Operational copy must distinguish focusing a live pane from restoring one. */
export function missionRailResumeCopy(
  status: MissionStatus,
  liveInGrid: boolean,
  intentState?: Mission['intentState'],
  lane?: MissionLane | null,
  technicalRecovery: 'recovering' | 'exhausted' = 'recovering',
  evidence: MissionRuntimeEvidence = {},
): { meta: string | null; title: string } {
  if (status === 'blocked' && intentState === 'blocked_technical') {
    if (technicalRecovery === 'exhausted') {
      return {
        meta: 'Falha técnica',
        title: 'Ver diagnóstico e tentar novamente',
      };
    }
    return {
      meta: 'Recuperação automática',
      title: 'O Nexus está preparando uma nova tentativa',
    };
  }
  if (liveInGrid) {
    return {
      meta: null,
      title:
        lane === 'plan'
          ? 'Missão em plan mode no grid — ▶ no rail promove para PREVC'
          : 'Missão aberta no grid — clique para focar',
    };
  }
  if (
    lane === 'plan' &&
    status !== 'done' &&
    status !== 'failed' &&
    intentState !== 'awaiting_goal' &&
    intentState !== 'draft'
  ) {
    return {
      meta: '▶ Executar plano',
      title:
        'Lane plan (só plan.md) — clique ▶ para promover a código PREVC',
    };
  }
  // Perda-de-trabalho-por-UI (voo real 05/08, mission-3be48989): a premissa
  // "no panes yet" do bloco abaixo é FALSA para uma missão que já rodou e
  // parou. Ela tem plano selado, worktree e commits; convidá-la ao wizard de
  // objetivo — a tela de quem nunca planejou — é oferecer recomeço do zero
  // como se fosse retomada. O convite tem que dizer que ela parou e que o
  // trabalho continua lá.
  if (intentState === 'awaiting_approval' && evidence.hasObservedRuntime) {
    return {
      meta: 'Ver por que parou',
      title:
        'A missão parou no meio — clique para ver o motivo; plano e trabalho já feito continuam preservados',
    };
  }
  // Intent-first / agêntico: no panes yet — click reopens the goal wizard.
  if (
    intentState === 'awaiting_goal' ||
    intentState === 'draft' ||
    intentState === 'intent_compiling' ||
    intentState === 'ready_to_start' ||
    intentState === 'awaiting_approval'
  ) {
    return {
      meta:
        intentState === 'awaiting_goal' || intentState === 'draft'
          ? 'Definir objetivo'
          : 'Continuar plano',
      title:
        intentState === 'awaiting_goal' || intentState === 'draft'
          ? 'Sem panes ainda — clique para descrever o objetivo'
          : 'Plano armado — clique para revisar e começar',
    };
  }
  if (status === 'running') {
    return {
      meta: 'Retomar panes salvos',
      title: 'Panes salvos — clique para retomar',
    };
  }
  if (status === 'blocked') {
    return {
      meta: 'Clique para retomar',
      title: 'Missão bloqueada — clique para retomar',
    };
  }
  return {
    meta: null,
    title: 'Retomar esta missão',
  };
}
