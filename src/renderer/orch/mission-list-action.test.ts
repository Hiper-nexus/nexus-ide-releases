import { describe, expect, it } from 'vitest';

describe('missionListAction — missão encalhada', () => {
  const wedged = {
    id: 'mission-a',
    title: 'teste panes',
    status: 'blocked',
    intentState: 'dispatched',
    orchestratorSessionId: undefined,
  } as unknown as Mission;

  it('offers Remover for a blocked mission with nothing alive', () => {
    // Field trap (28/07): `intentState=dispatched` alone claimed a live
    // runtime, so the rail showed "Encerrar" forever. Clicking it closed
    // nothing and the mission could never be deleted.
    expect(missionListAction(wedged, false)).toBe('remove');
  });

  it('still offers Encerrar while a pane is really on screen', () => {
    expect(missionListAction(wedged, true)).toBe('close-runtime');
  });

  it('still offers Encerrar when the orchestrator session is alive', () => {
    const live = {
      ...wedged,
      orchestratorSessionId: 'session-a',
    } as unknown as Mission;
    expect(missionListAction(live, false)).toBe('close-runtime');
  });
});
import type { Mission } from '../../shared/orch-types';
import {
  canDiscardMission,
  discardMissionPrompt,
  missionActionCopy,
  missionBoardLifecycleAction,
  missionListAction,
} from './mission-list-action';
import { MISSION_RUNTIME_CLOSED_MARKER } from '../../shared/mission-recovery-policy';

function mission(patch: Partial<Mission> = {}): Mission {
  return {
    id: 'mission-a',
    title: 'A',
    description: '',
    status: 'pending',
    milestones: [],
    learnings: '',
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  };
}

const automaticRecoveryAuthority: Pick<
  Mission,
  'intentVersion' | 'intentContract'
> = {
  intentVersion: 1,
  intentContract: {
    goal: 'Recuperar missão',
    intentVersion: 1,
    approvedAt: 1,
  } as Mission['intentContract'],
};

describe('mission list action policy', () => {
  it('nunca oferece remoção enquanto existe runtime vivo', () => {
    expect(canDiscardMission(mission({ intentState: 'awaiting_goal' }))).toBe(
      true,
    );
    expect(
      canDiscardMission(mission({ orchestratorSessionId: 'pty-live' })),
    ).toBe(false);
    expect(canDiscardMission(mission({ status: 'running' }))).toBe(false);
    expect(canDiscardMission(mission({ status: 'done' }))).toBe(false);
  });

  it('encerrar só aparece enquanto há runtime físico para encerrar', () => {
    const live = mission({
      status: 'blocked',
      intentState: 'blocked_user',
      orchestratorSessionId: 'pty-stuck',
    });
    expect(missionListAction(live, false)).toBe('close-runtime');
    expect(
      missionListAction(
        mission({ status: 'blocked', intentState: 'blocked_user' }),
        true,
      ),
    ).toBe('close-runtime');
  });

  it('após encerrar, a ação vira marcar concluída — Encerrar não é Concluir', () => {
    const closed = mission({
      status: 'blocked',
      intentState: 'blocked_user',
      description: MISSION_RUNTIME_CLOSED_MARKER,
    });
    expect(missionListAction(closed, false)).toBe('complete');
    expect(missionListAction(closed, true)).toBe('complete');
    expect(missionActionCopy('complete')).toEqual({
      verb: 'Marcar concluída',
      title: 'Arquivar esta missão como concluída. Histórico permanece.',
    });
  });

  it('após encerrar, Encerrar volta se o session pointer ainda está vivo', () => {
    const closedLive = mission({
      status: 'blocked',
      intentState: 'blocked_user',
      description: MISSION_RUNTIME_CLOSED_MARKER,
      orchestratorSessionId: 'pty-leftover',
    });
    expect(missionListAction(closedLive, false)).toBe('close-runtime');
  });

  it('keeps a user-blocked active mission when there is no runtime that can be closed safely', () => {
    const awaitingOperator = mission({
      status: 'blocked',
      intentState: 'blocked_user',
      intentVersion: 1,
      intentContract: {
        goal: 'Aguardar uma decisão do operador',
        intentVersion: 1,
        approvedAt: 1,
      } as Mission['intentContract'],
    });

    expect(missionListAction(awaitingOperator, false)).toBe('none');
  });

  it('oferece parar sem apagar enquanto o Main prepara um retry técnico', () => {
    const recovering = mission({
      status: 'blocked',
      intentState: 'blocked_technical',
      ...automaticRecoveryAuthority,
    });

    expect(missionListAction(recovering, false)).toBe('stop-recovery');
    expect(missionActionCopy('stop-recovery')).toEqual({
      verb: 'Parar',
      title: 'Parar a recuperação automática e preservar o histórico',
    });
  });

  it('permite remover bloqueio técnico sem autoridade de retry', () => {
    const stale = mission({
      status: 'blocked',
      intentState: 'blocked_technical',
    });

    expect(missionListAction(stale, false)).toBe('remove');
  });

  it('missão concluída também pode ser removida quando parada', () => {
    expect(missionListAction(mission({ status: 'done' }), false)).toBe(
      'remove',
    );
    expect(canDiscardMission(mission({ status: 'done' }))).toBe(false);
  });

  it('missão concluída oferece Remover mesmo com transcripts ou session pointer', () => {
    // Field trap: leftover grid panes and orch_session_id made Encerrar the
    // only action. Clicking it failed ("não possui execução encerrável") and
    // Remover never appeared.
    expect(missionListAction(mission({ status: 'done' }), true)).toBe('remove');
    expect(
      missionListAction(
        mission({
          status: 'done',
          intentState: 'done',
          orchestratorSessionId: 'pty-stale',
        }),
        true,
      ),
    ).toBe('remove');
  });

  it('rascunho nunca despachado segue descartável com cópia própria', () => {
    const draft = mission({ intentState: 'awaiting_goal' });
    expect(missionListAction(draft, false)).toBe('discard');
    expect(discardMissionPrompt(draft).confirmLabel).toBe('Descartar missão');
  });
});

describe('missionBoardLifecycleAction', () => {
  it('quadro Concluída oferece Remover mesmo com orch row ainda viva', () => {
    const stale = mission({
      status: 'running',
      intentState: 'executing',
      orchestratorSessionId: 'pty-stale',
    });
    expect(missionBoardLifecycleAction('completed', stale, true)).toBe(
      'remove',
    );
    expect(missionBoardLifecycleAction('completed', stale, false)).toBe(
      'remove',
    );
    expect(missionBoardLifecycleAction('completed', null, true)).toBe(
      'remove',
    );
  });

  it('quadro Falhou também oferece Remover em vez de Encerrar', () => {
    const stale = mission({
      status: 'running',
      orchestratorSessionId: 'pty-stale',
    });
    expect(missionBoardLifecycleAction('failed', stale, true)).toBe('remove');
  });

  it('quadro em execução continua Encerrar quando o runtime está vivo', () => {
    const live = mission({
      status: 'running',
      intentState: 'executing',
      orchestratorSessionId: 'pty-live',
    });
    expect(missionBoardLifecycleAction('running', live, true)).toBe(
      'close-runtime',
    );
    expect(missionBoardLifecycleAction(null, live, true)).toBe(
      'close-runtime',
    );
  });
});
