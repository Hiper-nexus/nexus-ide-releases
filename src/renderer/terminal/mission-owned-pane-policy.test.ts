import { describe, expect, it } from 'vitest';
import {
  BLOCKED_RESUME_NOTICE,
  decideDeadPaneReviveRespawn,
  decideExitedPaneKey,
  decideStaleAuthorityRecovery,
  decideUnlockRetiredMissionPane,
  MISSION_HOLD_NOTICE,
  MISSION_OWNED_EXIT_NOTICE,
  missionOwnedExitNotice,
  pruneWouldLeaveOperatorMute,
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

  it('rodapé e retire apontam para o rail, não para ctrl fictício nem shell mentiroso', () => {
    expect(MISSION_OWNED_EXIT_NOTICE).toMatch(/Digite para religar/);
    expect(MISSION_OWNED_EXIT_NOTICE).toMatch(/rail/);
    expect(MISSION_OWNED_EXIT_NOTICE).not.toMatch(/ctrl/i);
    expect(STALE_AUTHORITY_SYNC_NOTICE).toMatch(/uma vez/);
    expect(STALE_AUTHORITY_UNLOCK_NOTICE).toMatch(/Digite para um shell/);
    expect(BLOCKED_RESUME_NOTICE).toMatch(/autoridade principal/);
  });

  it('exit NORMAL de turno (code 0) é silêncio — nenhuma instrução ao operador', () => {
    // C-194.1: worker encerra o turno com code 0 a cada entrega. Gritar
    // "Digite para religar" em cada worker (4 panes ao mesmo tempo, 19/08)
    // era o atrito que o operador leu como quebra.
    const normal = missionOwnedExitNotice(0);
    expect(normal).toMatch(/turno encerrado/);
    expect(normal).toMatch(/rail/);
    expect(normal).not.toMatch(/Digite/i);
    expect(normal).not.toMatch(/Reinici/i);
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
    expect(
      decideUnlockRetiredMissionPane({
        missionStatus: 'done',
        isOrchestrator: true,
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
