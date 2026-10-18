import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import type { Mission, MissionPaneSpec } from '../../../shared/orch-types';
import type { MissionStateReason } from '../../../shared/mission-engine-contract';
import {
  hasNamedMissionBlockCause,
  missionBlockCause,
} from '../../../shared/mission-block-cause';
import { wasMissionLeftoverParked } from '../../../shared/mission-leftover-isolation';
import { wasMissionRuntimeClosedByOperator } from '../../../shared/mission-recovery-policy';
import {
  RUNTIME_CLOSED_REASON_CODE,
  isMissionInterruptedReasonCode,
} from '../../../shared/session-restore-liveness';
import {
  confirmAndReopenMission,
  reportMissionReopen,
} from '../../orch/confirm-reopen-mission';
import { missionStopReason } from '../../lib/mission-stop-reason';
import { routeMissionAttention } from '../../lib/mission-attention-route';
import { useOrchStore } from '../../state/orch-store';
import { getPaneSessionId } from '../../terminal/terminal-host';
import { AgentAvatar, resolveAgentCategory } from '../AgentAvatar';
import { ActionCard, EmptyState } from '../ActionCard';
import { ProviderLogo } from '../ProviderLogo';

/**
 * Missão interrompida: o Nexus fechou (restart, crash, quit), o operador
 * encerrou a execução ou o bloqueio técnico derrubou o runtime — e a resposta
 * visual era "Dormindo" sem caminho claro de volta. Um card só, uma primária
 * só: Retomar missão. Nada religa sem o clique.
 */

const MAX_ROSTER = 12;

type InterruptedMissionLike = Pick<
  Mission,
  'status' | 'intentState' | 'description'
>;

/** O predicado compartilhado: interrompida é retomável, nunca needsAnswer. */
export function missionIsInterrupted(
  mission: InterruptedMissionLike | null | undefined,
  reasonCode?: string,
  state?: string,
): boolean {
  if (!mission) return false;
  if (mission.status !== 'running' && mission.status !== 'blocked') {
    return false;
  }
  const needsAnswer =
    mission.status === 'blocked' &&
    mission.intentState === 'blocked_user' &&
    !wasMissionLeftoverParked(mission) &&
    !wasMissionRuntimeClosedByOperator(mission);
  if (needsAnswer) return false;
  return (
    isMissionInterruptedReasonCode(reasonCode) ||
    reasonCode === RUNTIME_CLOSED_REASON_CODE ||
    state === 'blocked_technical' ||
    wasMissionLeftoverParked(mission) ||
    wasMissionRuntimeClosedByOperator(mission)
  );
}

type MissionReasonCarrier = Pick<
  Mission,
  'status' | 'intentState' | 'description'
>;

/** Uma frase civil por código — nunca o token do motor. */
export function missionInterruptedReason(
  mission: MissionReasonCarrier,
  stateReason?: Pick<MissionStateReason, 'code' | 'label'>,
): string {
  if (
    isMissionInterruptedReasonCode(stateReason?.code) ||
    wasMissionLeftoverParked(mission)
  ) {
    return 'O Nexus fechou com a missão em andamento.';
  }
  if (
    stateReason?.code === RUNTIME_CLOSED_REASON_CODE ||
    wasMissionRuntimeClosedByOperator(mission)
  ) {
    return 'Você encerrou a execução. O histórico continua guardado.';
  }
  const cause = missionBlockCause({
    status: mission.status,
    intentState: mission.intentState ?? null,
    description: mission.description ?? null,
  });
  if (hasNamedMissionBlockCause(cause)) return cause.headline;
  // Códigos com rótulo civil próprio (leader-drift, restore-failed, …).
  if (stateReason?.label) return stateReason.label;
  // Sem causa nomeada: o silêncio do agente também é uma resposta.
  const stop = missionStopReason({
    status: mission.status,
    hasObservedRuntime: true,
  });
  return stop?.reason ?? 'A missão parou.';
}

type RowState = 'waiting' | 'live' | 'reopening' | 'back' | 'failed';

const ROW_COPY: Record<RowState, string> = {
  waiting: 'volta ao retomar',
  live: 'já está rodando',
  reopening: 'Reabrindo…',
  back: 'De volta',
  failed: 'não confirmou a sessão',
};

export interface MissionInterruptedCardProps {
  readonly missionId: string;
  /**
   * Ação primária do hospedeiro — o Quadro reusa a sua, sem criar uma
   * segunda. Ausente, o card renderiza a própria ("Retomar missão").
   */
  readonly action?: ReactNode;
  /** Foca a primária ao montar — a vinda do rail ("Abrir para retomar"). */
  readonly focusAction?: boolean;
  /** Destino de "Ver o que aconteceu"; default: Quadro, aba Atividade. */
  readonly onOpenWhy?: () => void;
}

export function MissionInterruptedCard({
  missionId,
  action,
  focusAction = false,
  onOpenWhy,
}: MissionInterruptedCardProps) {
  const mission = useOrchStore((state) =>
    state.missions.find((entry) => entry.id === missionId),
  );
  const summary = useOrchStore((state) =>
    state.missionSummaries.find((entry) => entry.id === missionId),
  );
  const squads = useOrchStore((state) => state.squads);
  const show =
    mission != null &&
    missionIsInterrupted(
      mission,
      summary?.stateReason?.code,
      summary?.state,
    );

  const [specs, setSpecs] = useState<readonly MissionPaneSpec[] | null>(null);
  const [rows, setRows] = useState<ReadonlyMap<string, RowState>>(new Map());
  const [busy, setBusy] = useState(false);
  const [partial, setPartial] = useState<readonly string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const inFlight = useRef(false);
  const actionRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!show) return;
    let cancelled = false;
    const list = window.nexus?.orch?.listMissionPanes?.(missionId);
    void Promise.resolve(list ?? [])
      .then((list) => {
        if (!cancelled) setSpecs(list.slice(0, MAX_ROSTER));
      })
      .catch(() => {
        if (!cancelled) setSpecs([]);
      });
    return () => {
      cancelled = true;
    };
  }, [missionId, show]);

  useEffect(() => {
    if (!focusAction) return;
    actionRef.current
      ?.querySelector('button')
      ?.focus();
  }, [focusAction]);

  const rowState = useCallback(
    (spec: MissionPaneSpec): RowState => {
      const override = rows.get(spec.paneId ?? spec.id);
      if (override) return override;
      const sessionId = spec.paneId ? getPaneSessionId(spec.paneId) : null;
      return sessionId ? 'live' : 'waiting';
    },
    [rows],
  );

  const openWhy = useCallback(() => {
    if (onOpenWhy) {
      onOpenWhy();
      return;
    }
    routeMissionAttention({ missionId, cause: 'technical-failure' });
  }, [missionId, onOpenWhy]);

  const restore = useCallback(async () => {
    const current = useOrchStore
      .getState()
      .missions.find((entry) => entry.id === missionId);
    if (inFlight.current || !current) return;
    inFlight.current = true;
    setBusy(true);
    setPartial([]);
    setError(null);
    setDone(false);
    setRows(
      new Map(
        (specs ?? [])
          .filter((spec) => !(spec.paneId && getPaneSessionId(spec.paneId)))
          .map((spec) => [spec.paneId ?? spec.id, 'reopening' as const]),
      ),
    );
    try {
      const result = await confirmAndReopenMission(current, {
        onPaneReady: (paneId, sessionId) => {
          setRows((previous) => {
            const next = new Map(previous);
            next.set(paneId, sessionId ? 'back' : 'failed');
            return next;
          });
        },
      });
      reportMissionReopen(current, result);
      if (result.ok) {
        const failed = result.partialPanes ?? [];
        if (failed.length > 0) {
          setPartial(failed.map((pane) => pane.title || pane.paneId));
        } else {
          setDone(true);
        }
      } else {
        setRows(new Map());
        setError(result.error ?? 'A retomada falhou.');
      }
    } catch (cause: unknown) {
      setRows(new Map());
      setError(
        cause instanceof Error ? cause.message : 'A retomada falhou.',
      );
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }, [missionId, specs]);

  if (!show || mission == null) return null;

  const total = specs?.length ?? 0;
  const backCount = specs
    ? specs.filter((spec) => rowState(spec) === 'back' || rowState(spec) === 'live')
        .length
    : 0;
  const statusLine = done
    ? total > 0
      ? `Missão retomada · ${backCount} de ${total} de volta`
      : 'Missão retomada'
    : busy
      ? `Retomando… ${backCount} de ${total} de volta`
      : partial.length > 0
        ? `${backCount} de ${total} voltaram — ${partial.join(', ')}: não confirmou a sessão`
        : null;

  const defaultAction = (
    <ActionCard
      variant="primary"
      icon="restart"
      title={busy ? 'Retomando…' : 'Retomar missão'}
      disabled={busy}
      aria-busy={busy}
      onClick={() => void restore()}
    />
  );

  return (
    <div className="mission-interrupted" data-mission-id={missionId}>
      <EmptyState
        icon="interrupted"
        title="Missão interrompida"
        body={
          <>
            <p>{missionInterruptedReason(mission, summary?.stateReason)}</p>
            <p className="mission-interrupted__kept">
              O plano e o trabalho feito continuam salvos.
            </p>
            {specs && specs.length > 0 ? (
              <ul className="mission-interrupted__roster">
                {specs.map((spec) => {
                  const state = rowState(spec);
                  const label =
                    spec.agentName ?? spec.title ?? spec.adapterId;
                  return (
                    <li
                      key={spec.paneId ?? spec.id}
                      className="mission-interrupted__member"
                      data-state={state}
                    >
                      <AgentAvatar
                        category={resolveAgentCategory(
                          squads,
                          spec.agentName,
                          spec.role,
                        )}
                        state={state === 'live' || state === 'back' ? 'idle' : 'offline'}
                        size="compact"
                        label={label}
                      />
                      <ProviderLogo
                        adapterId={spec.adapterId}
                        label={label}
                        size="sm"
                      />
                      <span className="mission-interrupted__member-name">
                        {label}
                      </span>
                      <span className="mission-interrupted__member-model">
                        {spec.model ?? spec.adapterId}
                      </span>
                      <span className="mission-interrupted__member-state">
                        {ROW_COPY[state]}
                      </span>
                    </li>
                  );
                })}
              </ul>
            ) : null}
            {error != null ? (
              <p className="mission-interrupted__status" role="alert">
                {error}
              </p>
            ) : statusLine ? (
              <p className="mission-interrupted__status" role="status">
                {statusLine}
              </p>
            ) : null}
          </>
        }
        action={
          <div className="mission-interrupted__actions" ref={actionRef}>
            {action ?? defaultAction}
            {partial.length > 0 ? (
              <button
                type="button"
                className="mission-interrupted__why"
                disabled={busy}
                onClick={() => void restore()}
              >
                Tentar de novo
              </button>
            ) : null}
            <button
              type="button"
              className="mission-interrupted__why"
              onClick={openWhy}
            >
              Ver o que aconteceu
            </button>
          </div>
        }
      />
    </div>
  );
}
