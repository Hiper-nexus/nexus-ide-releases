import { describe, expect, it } from 'vitest';
import {
  BLOCKED_RESUME_NOTICE,
  DEAD_PANE_MISSION_RELIVED_NOTICE,
  DEAD_PANE_REVIVE_ATTEMPT_NOTICE,
  DEAD_PANE_REVIVE_CHECK_NOTICE,
  DEAD_PANE_REVIVE_COOLDOWN_NOTICE,
  deadHelperPaneHistoryNotice,
  deadMaestroKeyRequestsAdjustment,
  deadPaneReviveCooldownNoticeDue,
  decideDeadPaneReviveRespawn,
  decideExitedPaneKey,
  decideTerminalMissionDeadPaneKey,
  decideOrchestratorProcessExit,
  decideStaleAuthorityRecovery,
  decideUnlockRetiredMissionPane,
  shouldInjectResumeContinuation,
  shouldInterruptBusyWorkerAfterMaestroTurnEnd,
  shouldKickMissionEngineOnDeadPaneKey,
  shouldPrintMissionPaneExitNotice,
  terminalDeadPaneFastPathApplies,
  latestCivilianDeliverySummary,
  MISSION_HOLD_NOTICE,
  MISSION_OWNED_EXIT_NOTICE,
  missionOwnedExitNotice,
  orchestratorOwnedExitLines,
  pruneWouldLeaveOperatorMute,
  shouldReviveDeadMissionFromPane,
  STANDALONE_HOLD_NOTICE,
  STALE_AUTHORITY_SYNC_NOTICE,
  STALE_AUTHORITY_UNLOCK_NOTICE,
} from './mission-owned-pane-policy';

describe('decideStaleAuthorityRecovery — uma sincronização, não um ciclo', () => {
  it('a primeira recusa de autoridade persistida pede UMA sync', () => {
    expect(
      decideStaleAuthorityRecovery({
        restorePersistedAuthority: false,
        autoResumeAlreadySpent: false,
      }),
    ).toBe('sync-once');
  });

  it('o spawn que JÁ era a sync não dispara outra onda', () => {
    expect(
      decideStaleAuthorityRecovery({
        restorePersistedAuthority: true,
        autoResumeAlreadySpent: false,
      }),
    ).toBe('unlock-keyboard');
  });

  it('a cota de auto-resume gasta corta o loop sync → block → retire', () => {
    expect(
      decideStaleAuthorityRecovery({
        restorePersistedAuthority: false,
        autoResumeAlreadySpent: true,
      }),
    ).toBe('unlock-keyboard');
    expect(
      decideStaleAuthorityRecovery({
        restorePersistedAuthority: true,
        autoResumeAlreadySpent: true,
      }),
    ).toBe('unlock-keyboard');
  });
});

describe('decideUnlockRetiredMissionPane — missão viva não vira shell', () => {
  it('pending, running e blocked preservam o pane', () => {
    expect(
      decideUnlockRetiredMissionPane({ missionStatus: 'pending' }),
    ).toBe('keep-paused');
    expect(
      decideUnlockRetiredMissionPane({ missionStatus: 'running' }),
    ).toBe('keep-paused');
    expect(
      decideUnlockRetiredMissionPane({ missionStatus: 'blocked' }),
    ).toBe('keep-paused');
  });

  it('done, failed ou missão ausente podem virar shell', () => {
    expect(
      decideUnlockRetiredMissionPane({ missionStatus: 'done' }),
    ).toBe('reclaim-shell');
    expect(
      decideUnlockRetiredMissionPane({ missionStatus: 'failed' }),
    ).toBe('reclaim-shell');
    expect(decideUnlockRetiredMissionPane({})).toBe('reclaim-shell');
  });

  it('falha ao consultar o status é fail-closed: não destrói o pane', () => {
    expect(
      decideUnlockRetiredMissionPane({ lookupFailed: true }),
    ).toBe('keep-paused');
  });
});

describe('decideExitedPaneKey — posse de missão não é mudez', () => {
  it('pane Encerrado com missão viva retoma o teclado', () => {
    expect(
      decideExitedPaneKey({
        hasSession: false,
        spawnStarted: false,
        paneState: 'exited',
        missionOwns: true,
      }),
    ).toBe('resume-keyboard');
  });

  it('Agente em pausa (hold/hibernated) de missão também retoma no teclado', () => {
    expect(
      decideExitedPaneKey({
        hasSession: false,
        spawnStarted: false,
        paneState: 'hibernated',
        missionOwns: true,
        spawnHeld: true,
      }),
    ).toBe('resume-keyboard');
  });

  it('cadáver sem missão vira shell', () => {
    expect(
      decideExitedPaneKey({
        hasSession: false,
        spawnStarted: false,
        paneState: 'exited',
        missionOwns: false,
      }),
    ).toBe('reclaim-shell');
  });

  it('sessão viva ou spawn em curso não compete com o teclado', () => {
    expect(
      decideExitedPaneKey({
        hasSession: true,
        spawnStarted: false,
        paneState: 'exited',
        missionOwns: true,
      }),
    ).toBe('ignore');
    expect(
      decideExitedPaneKey({
        hasSession: false,
        spawnStarted: true,
        paneState: 'exited',
        missionOwns: true,
      }),
    ).toBe('ignore');
  });
});

describe('decideDeadPaneReviveRespawn — tecla em pane morto de missão', () => {
  it('pane de missão viva nunca renasce no próprio xterm', () => {
    expect(
      decideDeadPaneReviveRespawn({
        missionOwnsPane: true,
        hasOrchRequestId: false,
      }),
    ).toBe('main-only');
  });

  it('token de grant no pane é lifecycle do main, mesmo sem vínculo vivo', () => {
    expect(
      decideDeadPaneReviveRespawn({
        missionOwnsPane: false,
        hasOrchRequestId: true,
      }),
    ).toBe('main-only');
  });

  it('pane avulso do operador religa a própria CLI na mesma conta', () => {
    expect(
      decideDeadPaneReviveRespawn({
        missionOwnsPane: false,
        hasOrchRequestId: false,
      }),
    ).toBe('same-pane-resume');
  });

  it('coordenador done revive no MESMO pane — não abre outro e aposenta este', () => {
    expect(
      decideDeadPaneReviveRespawn({
        missionOwnsPane: true,
        hasOrchRequestId: false,
        isOrchestrator: true,
      }),
    ).toBe('same-pane-resume');
  });
});

describe('Maestro no fim do turno (F-006) — pane vivo, sem recado, sem restart', () => {
  it('exit 0 do orquestrador religa a CLI no mesmo pane, sem banner', () => {
    expect(
      decideOrchestratorProcessExit({
        isOrchestrator: true,
        exitCode: 0,
      }),
    ).toBe('relive-cli-quietly');
  });

  it('worker e crash continuam no aviso curto', () => {
    expect(
      decideOrchestratorProcessExit({
        isOrchestrator: false,
        exitCode: 0,
      }),
    ).toBe('print-notice');
    expect(
      decideOrchestratorProcessExit({
        isOrchestrator: true,
        exitCode: 1,
      }),
    ).toBe('print-notice');
  });

  it('tecla no Maestro morto NÃO dispara o motor (não reinicia a missão)', () => {
    expect(
      shouldKickMissionEngineOnDeadPaneKey({ isOrchestrator: true }),
    ).toBe(false);
    expect(
      shouldKickMissionEngineOnDeadPaneKey({ isOrchestrator: false }),
    ).toBe(true);
  });

  it('tecla no Maestro morto de missão concluída pede ajuste (F-167)', () => {
    // O main recusa religar CLI de missão fora de running; religar no pane
    // era beco sem saída. A tecla faz o mesmo que "Pedir um ajuste".
    expect(
      deadMaestroKeyRequestsAdjustment({ isOrchestrator: true, missionDone: true }),
    ).toBe(true);
    expect(
      deadMaestroKeyRequestsAdjustment({ isOrchestrator: true, missionDone: false }),
    ).toBe(false);
    expect(
      deadMaestroKeyRequestsAdjustment({ isOrchestrator: false, missionDone: true }),
    ).toBe(false);
  });

  it('exit 0 de worker não imprime recado no PTY — o quadro avisa', () => {
    expect(shouldPrintMissionPaneExitNotice(0)).toBe(false);
    expect(shouldPrintMissionPaneExitNotice(1)).toBe(true);
  });

  it('Maestro no fim do turno interrompe worker ainda busy (F-007)', () => {
    expect(
      shouldInterruptBusyWorkerAfterMaestroTurnEnd({
        workerIsOrchestrator: false,
        paneState: 'busy',
        hasSuccessHandoff: true,
        hasQueuedHandoffs: false,
      }),
    ).toBe(true);
    expect(
      shouldInterruptBusyWorkerAfterMaestroTurnEnd({
        workerIsOrchestrator: false,
        paneState: 'idle',
        hasSuccessHandoff: true,
        hasQueuedHandoffs: false,
      }),
    ).toBe(false);
    expect(
      shouldInterruptBusyWorkerAfterMaestroTurnEnd({
        workerIsOrchestrator: true,
        paneState: 'busy',
        hasSuccessHandoff: true,
        hasQueuedHandoffs: false,
      }),
    ).toBe(false);
  });

  it('turn-end no kickoff NÃO manda Ctrl+C (worker spawning / sem handoff)', () => {
    expect(
      shouldInterruptBusyWorkerAfterMaestroTurnEnd({
        workerIsOrchestrator: false,
        paneState: 'spawning',
        hasSuccessHandoff: false,
        hasQueuedHandoffs: false,
      }),
    ).toBe(false);
    expect(
      shouldInterruptBusyWorkerAfterMaestroTurnEnd({
        workerIsOrchestrator: false,
        paneState: 'busy',
        hasSuccessHandoff: false,
        hasQueuedHandoffs: false,
      }),
    ).toBe(false);
  });

  it('handoff ainda na fila: Maestro saiu, worker continua entregando', () => {
    expect(
      shouldInterruptBusyWorkerAfterMaestroTurnEnd({
        workerIsOrchestrator: false,
        paneState: 'busy',
        hasSuccessHandoff: true,
        hasQueuedHandoffs: true,
      }),
    ).toBe(false);
  });

  it('relive silencioso não injeta Continue the current mission (F-006)', () => {
    expect(
      shouldInjectResumeContinuation({
        quietSpawn: true,
        hasContinuityPack: false,
        resume: true,
        adopted: false,
        resumeMode: 'exact',
      }),
    ).toBe(false);
    expect(
      shouldInjectResumeContinuation({
        quietSpawn: false,
        hasContinuityPack: false,
        resume: true,
        adopted: false,
        resumeMode: 'exact',
      }),
    ).toBe(true);
    expect(
      shouldInjectResumeContinuation({
        quietSpawn: false,
        hasContinuityPack: false,
        resume: true,
        adopted: false,
        resumeMode: 'exact',
        skipContinuation: true,
      }),
    ).toBe(false);
  });
});

describe('pruneWouldLeaveOperatorMute', () => {
  it('o único pane do coordenador não pode ser apagado sem teclado', () => {
    expect(
      pruneWouldLeaveOperatorMute(
        [{ id: 'pane-6', kind: 'cli-agent' }],
        'pane-6',
      ),
    ).toBe(true);
  });

  it('vacancy ao lado não conta como leaf digitável', () => {
    expect(
      pruneWouldLeaveOperatorMute(
        [
          { id: 'pane-6', kind: 'cli-agent' },
          { id: 'vacancy', kind: 'shell', isStructuralPlaceholder: true },
        ],
        'pane-6',
      ),
    ).toBe(true);
  });

  it('um shell real do operador mantém a grade digitável', () => {
    expect(
      pruneWouldLeaveOperatorMute(
        [
          { id: 'pane-6', kind: 'cli-agent' },
          { id: 'shell-1', kind: 'shell' },
        ],
        'pane-6',
      ),
    ).toBe(false);
  });

  it('browser ao lado não conta como teclado — o único CLI não pode sumir', () => {
    expect(
      pruneWouldLeaveOperatorMute(
        [
          { id: 'pane-6', kind: 'cli-agent' },
          { id: 'web-1', kind: 'browser' },
        ],
        'pane-6',
      ),
    ).toBe(true);
  });
});

describe('copy alinhada ao caminho real', () => {
  it('missão em pausa não pede um diálogo que não existe', () => {
    expect(MISSION_HOLD_NOTICE).toMatch(/Retomar/);
    expect(MISSION_HOLD_NOTICE).toMatch(/rail/);
    expect(MISSION_HOLD_NOTICE).not.toMatch(/Digite para retomar o teclado/);
    expect(MISSION_HOLD_NOTICE).not.toMatch(/Confirme o diálogo/);
  });

  it('agente avulso continua pedindo o diálogo', () => {
    expect(STANDALONE_HOLD_NOTICE).toMatch(/Confirme o diálogo/);
  });

  it('rodapé e retire apontam para o Maestro, não para ctrl fictício nem shell mentiroso', () => {
    expect(MISSION_OWNED_EXIT_NOTICE).toMatch(/Digite no Maestro/);
    expect(MISSION_OWNED_EXIT_NOTICE).toMatch(/não encerrou/);
    expect(MISSION_OWNED_EXIT_NOTICE).not.toMatch(/ctrl/i);
    expect(STALE_AUTHORITY_SYNC_NOTICE).toMatch(/uma vez/);
    expect(STALE_AUTHORITY_UNLOCK_NOTICE).toMatch(/Digite para um shell/);
    expect(BLOCKED_RESUME_NOTICE).toMatch(/autoridade principal/);
  });

  it('exit NORMAL de worker não diz que a missão encerrou', () => {
    // C-194.1: worker code 0 a cada entrega. "turno encerrado" em 4 panes
    // lia como missão fechada (print 24/08: 2+2=4 no JSON, Maestro morto).
    const normal = missionOwnedExitNotice(0);
    expect(normal).toMatch(/agente entregou/);
    expect(normal).toMatch(/Maestro/);
    expect(normal).not.toMatch(/turno encerrado/);
    expect(normal).not.toMatch(/Digite/i);
    expect(normal).not.toMatch(/Reinici/i);
  });

  it('Maestro no exit 0 mostra o resultado e diz que a missão NÃO encerrou', () => {
    const lines = orchestratorOwnedExitLines({
      exitCode: 0,
      deliverySummary: 'Resposta calculada: 2+2 = 4.',
    });
    expect(lines.join('\n')).toMatch(/2\+2 = 4/);
    expect(lines.join('\n')).toMatch(/NÃO encerrou/);
    expect(lines.join('\n')).toMatch(/Digite/i);
    expect(lines.join('\n')).not.toMatch(/turno encerrado/);
  });

  it('Maestro sem resumo ainda deixa o canal de ajuste aberto', () => {
    const lines = orchestratorOwnedExitLines({ exitCode: 0 });
    expect(lines.join('\n')).toMatch(/NÃO encerrou/);
    expect(lines.join('\n')).not.toMatch(/resultado:/);
  });

  it('pega o resumo civil da missão, senão o último handoff de sucesso', () => {
    expect(
      latestCivilianDeliverySummary({
        missionId: 'm1',
        resultSummary: 'Pronto: 4.',
        handoffs: [
          {
            missionId: 'm1',
            status: 'success',
            summary: 'Resposta calculada: 2+2 = 4.',
            createdAt: 2,
          },
        ],
      }),
    ).toBe('Pronto: 4.');
    expect(
      latestCivilianDeliverySummary({
        missionId: 'm1',
        handoffs: [
          {
            missionId: 'm1',
            status: 'failed',
            summary: 'caiu',
            createdAt: 3,
          },
          {
            missionId: 'm1',
            status: 'success',
            summary: 'Resposta calculada: 2+2 = 4.',
            createdAt: 2,
          },
          {
            missionId: 'm0',
            status: 'success',
            summary: 'outra missão',
            createdAt: 9,
          },
        ],
      }),
    ).toBe('Resposta calculada: 2+2 = 4.');
    expect(
      latestCivilianDeliverySummary({
        missionId: 'm1',
        resultSummary: '{"ok":true}',
        handoffs: [],
      }),
    ).toBeNull();
  });

  it('processo que CAIU (code ≠ 0) mantém a instrução acionável', () => {
    const crashed = missionOwnedExitNotice(1);
    expect(crashed).toMatch(/code 1/);
    expect(crashed).toMatch(/Digite para religar/);
    expect(crashed).toMatch(/rail/);
  });
});

describe('coordenador de missão concluída continua sendo o canal da revisão', () => {
  it('não troca o pane do coordenador por shell no done', () => {
    // A entrega ainda espera revisão humana e o operador pode não aprovar:
    // virar shell apagaria o histórico da coordenação bem na hora da revisão.
    // Sem gesto do operador o pane fica como histórico; com gesto, revive.
    expect(
      decideUnlockRetiredMissionPane({
        missionStatus: 'done',
        isOrchestrator: true,
      }),
    ).not.toBe('reclaim-shell');
    expect(
      decideUnlockRetiredMissionPane({
        missionStatus: 'done',
        isOrchestrator: true,
        operatorInitiated: true,
      }),
    ).toBe('keep-paused');
  });

  it('worker de missão concluída ainda pode virar shell', () => {
    expect(
      decideUnlockRetiredMissionPane({
        missionStatus: 'done',
        isOrchestrator: false,
      }),
    ).toBe('reclaim-shell');
  });

  it('a tecla no coordenador do done religa o agente em vez de abrir shell', () => {
    expect(
      decideExitedPaneKey({
        hasSession: false,
        spawnStarted: false,
        paneState: 'exited',
        // missionOwns é falso em missão terminal — era por isso que caía em shell.
        missionOwns: false,
        doneOrchestrator: true,
      }),
    ).toBe('resume-keyboard');
  });

  it('pane sem missão continua virando shell', () => {
    expect(
      decideExitedPaneKey({
        hasSession: false,
        spawnStarted: false,
        paneState: 'exited',
        missionOwns: false,
      }),
    ).toBe('reclaim-shell');
  });
});

describe('deadPaneReviveCooldownNoticeDue — F-367: um aviso por janela', () => {
  it('a primeira tecla dentro da janela avisa; as seguintes calam', () => {
    expect(
      deadPaneReviveCooldownNoticeDue({
        windowStart: 1_000,
        lastNotifiedWindowStart: undefined,
      }),
    ).toBe(true);
    expect(
      deadPaneReviveCooldownNoticeDue({
        windowStart: 1_000,
        lastNotifiedWindowStart: 1_000,
      }),
    ).toBe(false);
  });

  it('uma janela NOVA (outro carimbo) pode avisar de novo', () => {
    expect(
      deadPaneReviveCooldownNoticeDue({
        windowStart: 16_500,
        lastNotifiedWindowStart: 1_000,
      }),
    ).toBe(true);
  });
});

describe('shouldReviveDeadMissionFromPane', () => {
  it('montagem automática não revive leftover/Encerrar', () => {
    expect(shouldReviveDeadMissionFromPane({})).toBe(false);
    expect(shouldReviveDeadMissionFromPane({ operatorInitiated: false })).toBe(
      false,
    );
  });

  it('tecla do operador ainda pode religar', () => {
    expect(shouldReviveDeadMissionFromPane({ operatorInitiated: true })).toBe(
      true,
    );
  });
});

describe('abrir Terminais numa missão pronta NÃO pode relançar a missão', () => {
  it('sem gesto do operador o pane do coordenador vira histórico', () => {
    // Bug de campo 23/08: clicar em "Terminais" numa missão Pronta montava o
    // pane, o restore chamava unlockRetiredMissionPane e a missão voltava
    // para "Trabalhando" sozinha — a "revival surpresa" que a casa removeu.
    expect(
      decideUnlockRetiredMissionPane({
        missionStatus: 'done',
        isOrchestrator: true,
      }),
    ).toBe('keep-history');
  });

  it('com gesto do operador (tecla no pane) revive para o ajuste', () => {
    expect(
      decideUnlockRetiredMissionPane({
        missionStatus: 'done',
        isOrchestrator: true,
        operatorInitiated: true,
      }),
    ).toBe('keep-paused');
  });

  it('histórico nunca vira shell — o registro da coordenação fica', () => {
    expect(
      decideUnlockRetiredMissionPane({
        missionStatus: 'done',
        isOrchestrator: true,
      }),
    ).not.toBe('reclaim-shell');
  });

  it('missão viva segue pausada, com ou sem gesto', () => {
    for (const operatorInitiated of [true, false]) {
      expect(
        decideUnlockRetiredMissionPane({
          missionStatus: 'running',
          isOrchestrator: true,
          operatorInitiated,
        }),
      ).toBe('keep-paused');
    }
  });
});

describe('decideTerminalMissionDeadPaneKey — pós-missão nunca é mudez', () => {
  it('spawn em curso continua ignorando a tecla (transiente)', () => {
    expect(
      decideTerminalMissionDeadPaneKey({
        spawnStarted: true,
        keepReviewChannel: true,
      }),
    ).toBe('ignore');
    expect(
      decideTerminalMissionDeadPaneKey({
        spawnStarted: true,
        keepReviewChannel: false,
      }),
    ).toBe('ignore');
  });

  it('coordenador de missão concluída mantém o canal de revisão', () => {
    expect(
      decideTerminalMissionDeadPaneKey({
        spawnStarted: false,
        keepReviewChannel: true,
      }),
    ).toBe('resume-keyboard');
  });

  it('worker e demais panes de missão terminal viram shell digitável', () => {
    expect(
      decideTerminalMissionDeadPaneKey({
        spawnStarted: false,
        keepReviewChannel: false,
      }),
    ).toBe('reclaim-shell');
  });
});

describe('terminalDeadPaneFastPathApplies — F-347', () => {
  it('NÃO atropela a posse de missão done que ainda aguarda revisão', () => {
    // O caso exato do F-347: missão concluída sem carimbo do humano, pane de
    // worker. missionStillOwnsPane responde true (F-108), então a tecla tem que
    // cair na rota antiga, que devolve 'resume-keyboard'. Antes desta guarda a
    // rota rápida disparava e reclaimAsOperatorShell apagava
    // paneMissions[pane.id] de forma irreversível pela UI.
    expect(
      terminalDeadPaneFastPathApplies({
        link: 'done',
        paneState: 'exited',
        missionOwns: true,
      }),
    ).toBe(false);
  });

  it('não atropela posse de missão independentemente do estado do pane', () => {
    for (const paneState of ['busy', 'exited', 'spawning', undefined] as const) {
      expect(
        terminalDeadPaneFastPathApplies({ link: 'done', paneState, missionOwns: true }),
      ).toBe(false);
      expect(
        terminalDeadPaneFastPathApplies({ link: 'failed', paneState, missionOwns: true }),
      ).toBe(false);
    }
  });

  it('aplica quando a missão terminal já não é dona do pane', () => {
    // Missão done e APROVADA: o operador pode reclamar.
    expect(
      terminalDeadPaneFastPathApplies({
        link: 'done',
        paneState: 'exited',
        missionOwns: false,
      }),
    ).toBe(true);
    expect(
      terminalDeadPaneFastPathApplies({
        link: 'failed',
        paneState: 'exited',
        missionOwns: false,
      }),
    ).toBe(true);
  });

  it('aplica no estado preso, que é o único caso para o qual a rota existe', () => {
    // Missão terminal, pane sem posse, estado que a rota antiga silenciaria
    // ('ignore' porque paneState !== 'exited'). Sem a rota rápida o teclado
    // ficava mudo para sempre.
    for (const paneState of ['busy', 'spawning', undefined] as const) {
      expect(
        terminalDeadPaneFastPathApplies({ link: 'done', paneState, missionOwns: false }),
      ).toBe(true);
    }
  });

  it('não converte pane hibernado em shell na primeira tecla', () => {
    // Pane hibernado tem botão de acordar e não é estado preso. Vale também
    // para pane sem vínculo nenhum, que é o caso secundário do F-347.
    expect(
      terminalDeadPaneFastPathApplies({
        link: 'none',
        paneState: 'hibernated',
        missionOwns: false,
      }),
    ).toBe(false);
    expect(
      terminalDeadPaneFastPathApplies({
        link: 'done',
        paneState: 'hibernated',
        missionOwns: false,
      }),
    ).toBe(false);
  });

  it('nunca aplica a missão viva ou desconhecida', () => {
    for (const paneState of ['busy', 'exited', 'hibernated', undefined] as const) {
      expect(
        terminalDeadPaneFastPathApplies({
          link: 'live-or-unknown',
          paneState,
          missionOwns: false,
        }),
      ).toBe(false);
      expect(
        terminalDeadPaneFastPathApplies({
          link: 'live-or-unknown',
          paneState,
          missionOwns: true,
        }),
      ).toBe(false);
    }
  });

  it('aplica a pane livre sem vínculo, que é digitável por definição', () => {
    expect(
      terminalDeadPaneFastPathApplies({
        link: 'none',
        paneState: 'exited',
        missionOwns: false,
      }),
    ).toBe(true);
  });
});

describe('avisos de revive — nenhuma tecla pós-done cai no silêncio', () => {
  it('a tentativa anuncia recebimento sem prometer aceite', () => {
    expect(DEAD_PANE_REVIVE_ATTEMPT_NOTICE.length).toBeGreaterThan(0);
    expect(DEAD_PANE_REVIVE_ATTEMPT_NOTICE).toContain('[nexus]');
    expect(DEAD_PANE_REVIVE_ATTEMPT_NOTICE).not.toMatch(
      /religado|concluído|pronto/i,
    );
  });

  it('o cooldown repetido orienta em vez de engolir a tecla', () => {
    expect(DEAD_PANE_REVIVE_COOLDOWN_NOTICE).toContain('[nexus]');
    expect(DEAD_PANE_REVIVE_COOLDOWN_NOTICE).toContain('Reiniciar');
  });

  it('helper morto não promete religar o Maestro NESTE pane (F-368)', () => {
    expect(DEAD_PANE_REVIVE_CHECK_NOTICE).toContain('[nexus]');
    expect(DEAD_PANE_REVIVE_CHECK_NOTICE).toContain('verificando a missão');
    expect(DEAD_PANE_REVIVE_CHECK_NOTICE).not.toMatch(/religar o Maestro/);
  });

  it('pane histórico aponta o Maestro vivo pelo título', () => {
    const notice = deadHelperPaneHistoryNotice('Maestro · nexus-ide');
    expect(notice).toContain('histórico');
    expect(notice).toContain('«Maestro · nexus-ide»');
    expect(notice).toContain('escreva lá');
    expect(deadHelperPaneHistoryNotice(undefined)).toContain('«Maestro»');
    expect(deadHelperPaneHistoryNotice('  ')).toContain('«Maestro»');
  });

  it('missão religada sem Maestro fala em REABRIR, não em abrir (F-368)', () => {
    expect(DEAD_PANE_MISSION_RELIVED_NOTICE).toContain('reabre em outro pane');
    expect(DEAD_PANE_MISSION_RELIVED_NOTICE).toContain('histórico');
    expect(DEAD_PANE_MISSION_RELIVED_NOTICE).not.toMatch(/\babre em outro pane/);
  });
});
