import { describe, expect, it } from 'vitest';
import {
  classifySessionRestore,
  isolationStopLabel,
  isIsolationStopReasonCode,
  isSessionDeadReasonCode,
  leftoverRunningOrPendingIsDead,
  persistClosedReason,
  leftoverScrollbackLooksUnreadable,
  scrollbackLooksLikeRecoveredMarkdown,
  missionHasLivePlan,
  processIsRunning,
  restoreLooksWorking,
  sessionDeadReason,
  sessionSleepingReason,
  shouldHideDeadRecoveredPane,
  shouldRestoreAsWorkingGridCell,
  shouldShowPetReadyChrome,
  shouldShowRailWorking,
  wasUpdatedBeforeThisProcess,
  type SessionRestoreEvidence,
} from './session-restore-liveness';

function evidence(
  patch: Partial<SessionRestoreEvidence> = {},
): SessionRestoreEvidence {
  return {
    paneKind: 'cli-agent',
    processState: 'absent',
    hasLivePlan: false,
    isRestoreResume: false,
    isEmptyLeftoverShell: false,
    isPlanOnlyLeftover: false,
    updatedBeforeAppBoot: true,
    ...patch,
  };
}

describe('classifySessionRestore', () => {
  it('live: processo rodando E plano/objetivo vivo', () => {
    expect(
      classifySessionRestore(
        evidence({
          processState: 'busy',
          hasLivePlan: true,
        }),
      ),
    ).toBe('live');
    expect(
      classifySessionRestore(
        evidence({
          processState: 'spawning',
          hasLivePlan: true,
        }),
      ),
    ).toBe('live');
  });

  it('dead-idle: PTY vazio, AGY idle, plan-only leftover', () => {
    expect(
      classifySessionRestore(
        evidence({
          paneKind: 'shell',
          isEmptyLeftoverShell: true,
        }),
      ),
    ).toBe('dead-idle');
    expect(
      classifySessionRestore(
        evidence({
          processState: 'idle',
          hasLivePlan: false,
        }),
      ),
    ).toBe('dead-idle');
    expect(
      classifySessionRestore(
        evidence({
          isPlanOnlyLeftover: true,
          processState: 'absent',
        }),
      ),
    ).toBe('dead-idle');
  });

  it('religado-without-plan: restore/resume sem plano vivo', () => {
    expect(
      classifySessionRestore(
        evidence({
          isRestoreResume: true,
          hasLivePlan: false,
          processState: 'idle',
        }),
      ),
    ).toBe('religado-without-plan');
    expect(
      classifySessionRestore(
        evidence({
          isRestoreResume: true,
          hasLivePlan: false,
          processState: 'absent',
        }),
      ),
    ).toBe('religado-without-plan');
  });

  it('processo idle com plano NÃO é live — idle não é Trabalhando', () => {
    expect(
      classifySessionRestore(
        evidence({
          processState: 'idle',
          hasLivePlan: true,
        }),
      ),
    ).toBe('dead-idle');
  });

  it('processo busy sem plano NÃO é live', () => {
    expect(
      classifySessionRestore(
        evidence({
          processState: 'busy',
          hasLivePlan: false,
          isRestoreResume: false,
        }),
      ),
    ).toBe('dead-idle');
  });
});

describe('restore grid / rail / pet gates', () => {
  it('só célula live volta como grid de trabalho', () => {
    expect(
      shouldRestoreAsWorkingGridCell(
        evidence({ processState: 'busy', hasLivePlan: true }),
      ),
    ).toBe(true);
    expect(
      shouldRestoreAsWorkingGridCell(
        evidence({
          paneKind: 'shell',
          isEmptyLeftoverShell: true,
        }),
      ),
    ).toBe(false);
    expect(
      shouldRestoreAsWorkingGridCell(
        evidence({
          isRestoreResume: true,
          hasLivePlan: false,
        }),
      ),
    ).toBe(false);
  });

  it('shell leftover nunca é a workspace, mesmo com placeholder fresco de browser', () => {
    expect(
      shouldRestoreAsWorkingGridCell(
        evidence({
          paneKind: 'browser',
          processState: 'absent',
        }),
      ),
    ).toBe(true);
    expect(
      shouldRestoreAsWorkingGridCell(
        evidence({
          paneKind: 'shell',
          isEmptyLeftoverShell: true,
          processState: 'idle',
        }),
      ),
    ).toBe(false);
  });

  it('rail Trabalhando só na classe live', () => {
    expect(shouldShowRailWorking('live')).toBe(true);
    expect(shouldShowRailWorking('dead-idle')).toBe(false);
    expect(shouldShowRailWorking('religado-without-plan')).toBe(false);
    expect(restoreLooksWorking('live')).toBe(true);
    expect(restoreLooksWorking('dead-idle')).toBe(false);
  });

  it('pet PRONTA/working só com missão live', () => {
    expect(shouldShowPetReadyChrome(true)).toBe(true);
    expect(shouldShowPetReadyChrome(false)).toBe(false);
  });
});

describe('session-dead copy', () => {
  it('Parou-as-stop é Encerrar; leftover session-dead é Interrompida', () => {
    expect(sessionDeadReason()).toEqual({
      code: 'session-dead',
      label: 'Interrompida',
    });
    expect(isSessionDeadReasonCode('session-dead')).toBe(true);
    expect(isSessionDeadReasonCode('restore-failed')).toBe(true);
    expect(isSessionDeadReasonCode('never-started-draft')).toBe(true);
    expect(isSessionDeadReasonCode('open-question')).toBe(false);
    expect(persistClosedReason()).toEqual({
      code: 'runtime-closed',
      label: 'Parou',
    });
    expect(isIsolationStopReasonCode('runtime-closed')).toBe(true);
    expect(isIsolationStopReasonCode('session-sleeping')).toBe(true);
    expect(isIsolationStopReasonCode('session-dead')).toBe(true);
    expect(isIsolationStopReasonCode('open-question')).toBe(false);
    expect(isolationStopLabel('session-sleeping')).toBe('Interrompida');
    expect(isolationStopLabel('runtime-closed')).toBe('Parou');
    expect(isolationStopLabel('session-dead')).toBe('Interrompida');
    expect(isolationStopLabel('open-question')).toBeNull();
  });

  it('updatedAt anterior ao boot é leftover desta sessão', () => {
    expect(wasUpdatedBeforeThisProcess(10, 20)).toBe(true);
    expect(wasUpdatedBeforeThisProcess(20, 20)).toBe(false);
    expect(wasUpdatedBeforeThisProcess(21, 20)).toBe(false);
  });

  it('plano vivo exige objetivo em execução — plan-only e awaiting_goal não', () => {
    expect(
      missionHasLivePlan({
        title: 'Login',
        status: 'running',
        intentState: 'executing',
        intentContract: { goal: 'Entregar o login' },
      }),
    ).toBe(true);
    expect(
      missionHasLivePlan({
        title: 'Só o plano',
        status: 'pending',
        intentState: 'ready_to_start',
        intentContract: { goal: 'Planejar', lane: 'plan' },
      }),
    ).toBe(false);
    expect(
      missionHasLivePlan({
        title: 'Codex',
        status: 'running',
        intentState: 'awaiting_goal',
      }),
    ).toBe(false);
  });

  it('busy/spawning são processo rodando; idle e ausente não', () => {
    expect(processIsRunning('busy')).toBe(true);
    expect(processIsRunning('spawning')).toBe(true);
    expect(processIsRunning('idle')).toBe(false);
    expect(processIsRunning('exited')).toBe(false);
    expect(processIsRunning('absent')).toBe(false);
  });

  it('leftover running/pending sem PTY e sem arquivos é morto — waitlist 3/4', () => {
    expect(
      leftoverRunningOrPendingIsDead({
        status: 'running',
        hasLivePty: false,
        hasFiles: false,
      }),
    ).toBe(true);
    expect(
      leftoverRunningOrPendingIsDead({
        status: 'pending',
        hasLivePty: false,
        hasFiles: false,
      }),
    ).toBe(true);
    expect(
      leftoverRunningOrPendingIsDead({
        status: 'running',
        hasLivePty: true,
        hasFiles: false,
      }),
    ).toBe(false);
    expect(
      leftoverRunningOrPendingIsDead({
        status: 'running',
        hasLivePty: false,
        hasFiles: true,
      }),
    ).toBe(false);
    expect(
      leftoverRunningOrPendingIsDead({
        status: 'running',
        hasLivePty: false,
        hasFiles: false,
        isFreshKickoff: true,
      }),
    ).toBe(false);
    expect(
      leftoverRunningOrPendingIsDead({
        status: 'pending',
        hasLivePty: false,
        hasFiles: false,
        isFreshPending: true,
      }),
    ).toBe(false);
  });
});

describe('dead recovered pane + Dormindo', () => {
  it('hides leftover leftover leftover markdown when no process is live', () => {
    expect(
      shouldHideDeadRecoveredPane({
        processRunning: false,
        hasLeftoverScrollback: true,
      }),
    ).toBe(true);
    expect(
      shouldHideDeadRecoveredPane({
        processRunning: true,
        hasLeftoverScrollback: true,
      }),
    ).toBe(false);
    expect(
      leftoverScrollbackLooksUnreadable(
        '[Nexus skipped terminal output that could not be recovered.]',
      ),
    ).toBe(true);
    expect(
      leftoverScrollbackLooksUnreadable('adopted pane vazio pós-reset'),
    ).toBe(true);
    expect(
      leftoverScrollbackLooksUnreadable(
        '### Implementation Summary\n\nThe worker finished the waitlist.',
      ),
    ).toBe(true);
    expect(
      leftoverScrollbackLooksUnreadable('$ ls\nREADME.md\n'),
    ).toBe(false);
    expect(
      scrollbackLooksLikeRecoveredMarkdown(
        '### Implementation Summary\nNo CLI attached.',
      ),
    ).toBe(true);
    expect(
      scrollbackLooksLikeRecoveredMarkdown('$ echo hi\n### notes\n'),
    ).toBe(false);
  });

  it('Interrompida is a stopped rail class, not Trabalhando', () => {
    expect(sessionSleepingReason()).toEqual({
      code: 'session-sleeping',
      label: 'Interrompida',
    });
    expect(isSessionDeadReasonCode('session-sleeping')).toBe(true);
    expect(shouldShowRailWorking('dead-idle')).toBe(false);
  });
});
