/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const holdSpawnUntilApproved = vi.fn();
const markResumeOnSpawn = vi.fn();
const releaseHeldSpawns = vi.fn();
const discardPaneSpawnState = vi.fn();
const unlockRetiredMissionPane = vi.fn();
const askConfirm = vi.fn();
const setRestoredPanesHandler = vi.fn();
const closePane = vi.fn();
const pruneMissionBindings = vi.fn();
const orchGet = vi.fn();
const canRestoreMissionPane = vi.fn();
const layoutRoot = vi.hoisted(() => ({
  current: {
    kind: 'leaf' as const,
    id: 'leaf-shell',
    pane: {
      id: 'sh-1',
      kind: 'shell' as const,
      title: 'shell',
      cwd: '/ws',
    } as { id: string; kind: string; title: string; cwd: string; missionId?: string; role?: string },
  },
}));

vi.mock('../terminal/terminal-host', () => ({
  holdSpawnUntilApproved: (...args: unknown[]) => holdSpawnUntilApproved(...args),
  markResumeOnSpawn: (...args: unknown[]) => markResumeOnSpawn(...args),
  releaseHeldSpawns: (...args: unknown[]) => releaseHeldSpawns(...args),
  discardPaneSpawnState: (...args: unknown[]) =>
    discardPaneSpawnState(...args),
  unlockRetiredMissionPane: (...args: unknown[]) =>
    unlockRetiredMissionPane(...args),
}));

vi.mock('../state/confirm-store', () => ({
  askConfirm: (...args: unknown[]) => askConfirm(...args),
}));

vi.mock('../state/layout-store', () => ({
  setRestoredPanesHandler: (...args: unknown[]) => setRestoredPanesHandler(...args),
  useLayoutStore: {
    getState: () => ({
      close: (...args: unknown[]) => closePane(...args),
      root: layoutRoot.current,
    }),
  },
}));

vi.mock('../state/orch-store', () => ({
  useOrchStore: {
    getState: () => ({
      pruneMissionBindings: (...args: unknown[]) =>
        pruneMissionBindings(...args),
    }),
  },
}));

import {
  gateRestoredAgents,
  installRestoredAgentsGate,
  resetRestoredAgentsGate,
  resolveAgentRestoreAction,
} from './restore-agents-gate';
import { setActiveWorkspacePath } from '../state/active-workspace';

const agent = (id: string, title: string) =>
  ({
    id,
    kind: 'cli-agent' as const,
    title,
    adapterId: 'claude',
    cwd: '/ws',
  }) as const;

const missionAgent = (id: string, title: string) =>
  ({
    ...agent(id, title),
    missionId: 'mission-a',
    role: 'orchestrator' as const,
  }) as const;

const shell = {
  id: 'sh-1',
  kind: 'shell' as const,
  title: 'shell',
  cwd: '/ws',
} as const;

describe('resolveAgentRestoreAction (multi-OS policy)', () => {
  it('defaults unknown values to ask (safe on every platform)', () => {
    expect(resolveAgentRestoreAction('ask')).toBe('ask');
    expect(resolveAgentRestoreAction('pause')).toBe('pause');
    expect(resolveAgentRestoreAction('resume')).toBe('resume');
    expect(resolveAgentRestoreAction('nope' as 'ask')).toBe('ask');
  });
});

describe('restore-agents-gate', () => {
  beforeEach(() => {
    setActiveWorkspacePath('/workspace-a');
    resetRestoredAgentsGate();
    holdSpawnUntilApproved.mockReset();
    markResumeOnSpawn.mockReset();
    releaseHeldSpawns.mockReset();
    discardPaneSpawnState.mockReset();
    unlockRetiredMissionPane.mockReset();
    askConfirm.mockReset();
    setRestoredPanesHandler.mockReset();
    closePane.mockReset();
    pruneMissionBindings.mockReset();
    orchGet.mockReset();
    canRestoreMissionPane.mockReset();
    orchGet.mockResolvedValue({ agentRestorePolicy: 'ask' });
    canRestoreMissionPane.mockResolvedValue(true);
    layoutRoot.current = {
      kind: 'leaf',
      id: 'leaf-shell',
      pane: shell,
    };
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: {
        settings: { orchGet },
        orch: { canRestoreMissionPane },
      },
    });
  });

  it('does nothing when the layout has no agents', async () => {
    await gateRestoredAgents([shell]);
    expect(holdSpawnUntilApproved).not.toHaveBeenCalled();
    expect(askConfirm).not.toHaveBeenCalled();
  });

  it('policy ask: holds agents and requires confirm (safe default)', async () => {
    askConfirm.mockResolvedValue(false);
    await gateRestoredAgents([agent('a1', 'Orquestrador'), shell]);

    expect(holdSpawnUntilApproved).toHaveBeenCalledWith('a1');
    expect(askConfirm).toHaveBeenCalledOnce();
    expect(askConfirm.mock.calls[0]?.[0]).toMatchObject({
      confirmLabel: 'Retomar agentes',
      cancelLabel: 'Deixar em pausa',
      danger: true,
    });
    expect(releaseHeldSpawns).toHaveBeenCalledWith(['a1'], { resume: false });
  });

  it('policy pause: never asks, never auto-resumes', async () => {
    orchGet.mockResolvedValue({ agentRestorePolicy: 'pause' });
    await gateRestoredAgents([agent('a1', 'Orq'), agent('a2', 'Worker')]);
    expect(askConfirm).not.toHaveBeenCalled();
    expect(releaseHeldSpawns).toHaveBeenCalledWith(['a1', 'a2'], {
      resume: false,
    });
    expect(holdSpawnUntilApproved).toHaveBeenCalled();
  });

  it('policy resume: silent resume (legacy / power user)', async () => {
    orchGet.mockResolvedValue({ agentRestorePolicy: 'resume' });
    await gateRestoredAgents([agent('a1', 'Orq')]);
    expect(askConfirm).not.toHaveBeenCalled();
    expect(releaseHeldSpawns).toHaveBeenCalledWith(['a1'], { resume: true });
  });

  it('default policy (no explicit preference): resumes without a dialog', async () => {
    orchGet.mockResolvedValue({});
    await gateRestoredAgents([agent('a1', 'Orq')]);
    expect(askConfirm).not.toHaveBeenCalled();
    expect(releaseHeldSpawns).toHaveBeenCalledWith(['a1'], { resume: true });
  });

  it('always resumes mission panes through their persisted main authority', async () => {
    orchGet.mockResolvedValue({ agentRestorePolicy: 'resume' });
    await gateRestoredAgents([
      missionAgent('mission-orch', 'Orquestrador'),
      agent('solo', 'Agente avulso'),
    ]);

    expect(holdSpawnUntilApproved).toHaveBeenCalledWith('mission-orch');
    expect(releaseHeldSpawns).toHaveBeenCalledWith(['mission-orch'], {
      resume: true,
    });
    expect(releaseHeldSpawns).toHaveBeenCalledWith(['solo'], {
      resume: true,
    });
    expect(canRestoreMissionPane).toHaveBeenCalledWith({
      missionId: 'mission-a',
      paneId: 'mission-orch',
    });
  });

  it('auto-resumes an all-mission layout without opening the generic dialog', async () => {
    await gateRestoredAgents([
      missionAgent('mission-orch', 'Orquestrador'),
    ]);

    expect(holdSpawnUntilApproved).toHaveBeenCalledWith('mission-orch');
    expect(askConfirm).not.toHaveBeenCalled();
    expect(releaseHeldSpawns).toHaveBeenCalledWith(['mission-orch'], {
      resume: true,
    });
  });

  it('aposenta o pane legado só-de-papel em vez de apagá-lo do layout', async () => {
    // `role` NÃO é autoridade de missão — mas negar autoridade nunca pode
    // significar APAGAR. O pane fica, inerte e legível, e quem fecha é o
    // operador ("Limpar projeto → Fechar todos os panes").
    const roleOnly = {
      ...agent('role-only', 'Orquestrador antigo'),
      role: 'orchestrator' as const,
    };

    await gateRestoredAgents([roleOnly]);

    expect(canRestoreMissionPane).not.toHaveBeenCalled();
    expect(releaseHeldSpawns).not.toHaveBeenCalledWith(
      ['role-only'],
      { resume: true },
    );
    expect(closePane).not.toHaveBeenCalled();
    expect(unlockRetiredMissionPane).not.toHaveBeenCalled();
    expect(askConfirm).not.toHaveBeenCalled();
  });

  it('aposenta o pane de missão sem autoridade em vez de apagá-lo do layout', async () => {
    canRestoreMissionPane.mockResolvedValue(false);

    const orphan = missionAgent('orphan-pane', 'Orquestrador órfão');
    await gateRestoredAgents([orphan]);

    expect(canRestoreMissionPane).toHaveBeenCalledWith({
      missionId: 'mission-a',
      paneId: 'orphan-pane',
    });
    expect(releaseHeldSpawns).not.toHaveBeenCalledWith(
      ['orphan-pane'],
      { resume: true },
    );
    // A linha que apagava e PERSISTIA — a que destruiu 7 panes em campo.
    expect(closePane).not.toHaveBeenCalled();
    // E não pode virar shell: `reclaim-shell` spawna processo novo e descarta
    // o histórico, que é justamente o que o operador perdeu.
    expect(unlockRetiredMissionPane).not.toHaveBeenCalled();
  });

  it('nunca deixa o operador mudo: o último pane também é aposentado, não apagado', async () => {
    // O guard de "operador mudo" existia porque apagar o último leaf tirava o
    // teclado dele. Com a aposentadoria nada é removido, então o guard deixou
    // de ser um caso especial: o último pane segue exatamente o mesmo caminho.
    canRestoreMissionPane.mockResolvedValue(false);
    const last = missionAgent('pane-6', 'Coordenar e revisar');
    layoutRoot.current = {
      kind: 'leaf',
      id: 'leaf-last',
      pane: last,
    };

    await gateRestoredAgents([last]);

    expect(closePane).not.toHaveBeenCalled();
    // `unlockRetiredMissionPane` mandaria um worker de missão encerrada para
    // `reclaim-shell` — spawn novo, histórico descartado. Aposentar não passa
    // por ele, nem para o coordenador.
    expect(unlockRetiredMissionPane).not.toHaveBeenCalled();
  });

  it('coalesces duplicate HMR gates and retires an orphan only once', async () => {
    let resolveAuthority!: (allowed: boolean) => void;
    canRestoreMissionPane.mockReturnValue(
      new Promise<boolean>((resolve) => {
        resolveAuthority = resolve;
      }),
    );
    const orphan = missionAgent('hmr-orphan', 'Pane persistido órfão');

    const first = gateRestoredAgents([orphan]);
    const second = gateRestoredAgents([orphan]);
    resolveAuthority(false);
    await Promise.all([first, second]);

    expect(canRestoreMissionPane).toHaveBeenCalledOnce();
    expect(closePane).not.toHaveBeenCalled();
    expect(unlockRetiredMissionPane).not.toHaveBeenCalled();
    expect(releaseHeldSpawns).not.toHaveBeenCalledWith(
      ['hmr-orphan'],
      { resume: true },
    );
  });

  it('ignores a stale workspace A decision after the same pane id is restored in workspace B', async () => {
    let resolveWorkspaceA!: (allowed: boolean) => void;
    canRestoreMissionPane
      .mockReturnValueOnce(
        new Promise<boolean>((resolve) => {
          resolveWorkspaceA = resolve;
        }),
      )
      .mockResolvedValueOnce(true);
    const pane = missionAgent('shared-pane-id', 'Pane homônimo');

    const workspaceARestore = gateRestoredAgents([pane]);
    await vi.waitFor(() => {
      expect(canRestoreMissionPane).toHaveBeenCalledOnce();
    });

    setActiveWorkspacePath('/workspace-b');
    const workspaceBRestore = gateRestoredAgents([pane]);
    await workspaceBRestore;

    resolveWorkspaceA(false);
    await workspaceARestore;

    expect(canRestoreMissionPane).toHaveBeenCalledTimes(2);
    expect(releaseHeldSpawns).toHaveBeenCalledTimes(1);
    expect(releaseHeldSpawns).toHaveBeenCalledWith(['shared-pane-id'], {
      resume: true,
    });
    expect(closePane).not.toHaveBeenCalled();
    expect(discardPaneSpawnState).not.toHaveBeenCalled();
  });

  it('keeps a mission pane held while Main is unavailable without treating errors as false', async () => {
    vi.useFakeTimers();
    canRestoreMissionPane.mockRejectedValue(new Error('main restarting'));

    try {
      const restoring = gateRestoredAgents([
        missionAgent('held-pane', 'Pane aguardando Main'),
      ]);
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(1_500);

      expect(canRestoreMissionPane.mock.calls.length).toBeGreaterThan(4);
      expect(holdSpawnUntilApproved).toHaveBeenCalledWith('held-pane');
      expect(discardPaneSpawnState).not.toHaveBeenCalled();
      expect(closePane).not.toHaveBeenCalled();
      expect(releaseHeldSpawns).not.toHaveBeenCalledWith(
        ['held-pane'],
        { resume: true },
      );

      resetRestoredAgentsGate();
      await vi.runAllTimersAsync();
      await restoring;
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries a transient authority failure and releases the pane when Main recovers', async () => {
    vi.useFakeTimers();
    canRestoreMissionPane
      .mockRejectedValueOnce(new Error('main warming up'))
      .mockResolvedValueOnce(true);

    try {
      const restoring = gateRestoredAgents([
        missionAgent('retry-pane', 'Pane aguardando Main'),
      ]);
      await Promise.resolve();

      expect(canRestoreMissionPane).toHaveBeenCalledOnce();

      await vi.runAllTimersAsync();
      await restoring;

      expect(canRestoreMissionPane).toHaveBeenCalledTimes(2);
      expect(releaseHeldSpawns).toHaveBeenCalledWith(['retry-pane'], {
        resume: true,
      });
      expect(closePane).not.toHaveBeenCalled();
      expect(discardPaneSpawnState).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps retrying beyond four failures until Main confirms authority', async () => {
    vi.useFakeTimers();
    for (let attempt = 0; attempt < 6; attempt += 1) {
      canRestoreMissionPane.mockRejectedValueOnce(
        new Error(`main warming up ${attempt}`),
      );
    }
    canRestoreMissionPane.mockResolvedValueOnce(true);

    try {
      const restoring = gateRestoredAgents([
        missionAgent('slow-main-pane', 'Pane aguardando Main lento'),
      ]);
      await Promise.resolve();
      await vi.runAllTimersAsync();
      await restoring;

      expect(canRestoreMissionPane).toHaveBeenCalledTimes(7);
      expect(releaseHeldSpawns).toHaveBeenCalledWith(['slow-main-pane'], {
        resume: true,
      });
      expect(closePane).not.toHaveBeenCalled();
      expect(discardPaneSpawnState).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels a pending authority retry when the restore generation resets', async () => {
    vi.useFakeTimers();
    canRestoreMissionPane.mockRejectedValue(new Error('main warming up'));

    try {
      const restoring = gateRestoredAgents([
        missionAgent('reset-pane', 'Pane da geração anterior'),
      ]);
      await Promise.resolve();

      expect(canRestoreMissionPane).toHaveBeenCalledOnce();
      resetRestoredAgentsGate();
      await vi.runAllTimersAsync();
      await restoring;

      expect(canRestoreMissionPane).toHaveBeenCalledOnce();
      expect(releaseHeldSpawns).not.toHaveBeenCalledWith(
        ['reset-pane'],
        { resume: true },
      );
      expect(closePane).not.toHaveBeenCalled();
      expect(discardPaneSpawnState).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('never restores process-local or legacy PREVC reviewer panes', async () => {
    const reviewerSuffix = 'a1b2c3d4e5f6';
    const legacyReviewer = {
      ...agent('legacy-reviewer', `review-mission-a-1-${reviewerSuffix}`),
      missionId: 'mission-a',
      role: 'worker' as const,
      agentName: `reviewer-claude-1-${reviewerSuffix}`,
    };
    const transientReviewer = {
      ...missionAgent('transient-reviewer', 'PREVC reviewer'),
      transient: true as const,
    };

    await gateRestoredAgents([legacyReviewer, transientReviewer]);

    expect(holdSpawnUntilApproved).not.toHaveBeenCalled();
    expect(releaseHeldSpawns).not.toHaveBeenCalled();
    expect(askConfirm).not.toHaveBeenCalled();
    expect(orchGet).not.toHaveBeenCalled();
  });

  it('on ask+approve, resumes agents', async () => {
    askConfirm.mockResolvedValue(true);
    await gateRestoredAgents([agent('a1', 'Orq'), agent('a2', 'Worker')]);
    expect(releaseHeldSpawns).toHaveBeenCalledWith(['a1', 'a2'], {
      resume: true,
    });
  });

  it('installRestoredAgentsGate wires the layout restore handler', () => {
    installRestoredAgentsGate();
    expect(setRestoredPanesHandler).toHaveBeenCalledOnce();
  });
});
