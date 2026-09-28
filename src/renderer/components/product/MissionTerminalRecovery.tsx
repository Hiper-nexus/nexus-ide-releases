import { useRef, useState } from 'react';
import { wasMissionLeftoverParked } from '../../../shared/mission-leftover-isolation';
import { wasMissionRuntimeClosedByOperator } from '../../../shared/mission-recovery-policy';
import { confirmAndReopenMission } from '../../orch/confirm-reopen-mission';
import { useOrchStore } from '../../state/orch-store';
import { useProductNavigationStore } from '../../state/product-navigation-store';
import { ActionCard, EmptyState } from '../ActionCard';

/** Navigation never starts work. The operator explicitly restores this mission. */
export function MissionTerminalRecovery({ missionId }: { missionId: string }) {
  const mission = useOrchStore((state) =>
    state.missions.find((m) => m.id === missionId),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const active = mission?.status === 'running' || mission?.status === 'blocked';
  const parked = mission && active ? wasMissionLeftoverParked(mission) : false;
  const stopped =
    mission && active ? wasMissionRuntimeClosedByOperator(mission) : false;
  const needsAnswer =
    mission?.status === 'blocked' &&
    mission.intentState === 'blocked_user' &&
    !parked &&
    !stopped;
  const canRestore =
    mission &&
    !needsAnswer &&
    (mission.status === 'running' || mission.status === 'blocked');

  const restore = async () => {
    if (inFlight.current || !canRestore) return;
    const current = useOrchStore
      .getState()
      .missions.find((m) => m.id === missionId);
    if (!current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await confirmAndReopenMission(current);
      if (!result.ok)
        setError(
          result.error ??
            'Não foi possível reabrir o terminal. Tente novamente.',
        );
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : 'Não foi possível reabrir o terminal. Tente novamente.',
      );
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  return (
    <EmptyState
      icon="terminal"
      title="Terminal da missão fechado"
      body={
        <>
          <p>
            {stopped
              ? 'A execução foi encerrada. Retome a missão para continuar no terminal.'
              : parked
                ? 'Esta missão está dormindo. Retome para continuar de onde parou.'
                : needsAnswer
                  ? 'Esta missão aguarda sua resposta. Abra o Quadro para responder.'
                  : canRestore
                    ? 'Reabra o terminal desta missão para continuar a conversa.'
                    : 'Abra o Quadro para consultar o histórico e as ações desta missão.'}
          </p>
          {error ? <p role="alert">{error}</p> : null}
        </>
      }
      action={
        canRestore ? (
          <ActionCard
            variant="primary"
            size="sm"
            disabled={busy}
            aria-busy={busy}
            onClick={() => void restore()}
            title={
              busy
                ? 'Reabrindo terminal…'
                : mission.status === 'blocked'
                  ? 'Retomar missão'
                  : 'Reabrir terminal'
            }
          />
        ) : (
          <ActionCard
            variant="primary"
            size="sm"
            onClick={() =>
              useProductNavigationStore.getState().openMission(missionId)
            }
            title={needsAnswer ? 'Responder no Quadro' : 'Abrir Quadro'}
          />
        )
      }
    />
  );
}
