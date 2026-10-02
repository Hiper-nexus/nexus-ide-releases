/** @vitest-environment jsdom */
import { buildGridTree } from '../lib/split-tree';
import { useAccessStore } from '../state/access-store';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const holdSpawnUntilApproved = vi.fn();
const markResumeOnSpawn = vi.fn();
const releaseHeldSpawns = vi.fn();
const discardPaneSpawnState = vi.fn();
const isSpawnHeld = vi.fn();
const unlockRetiredMissionPane = vi.fn();
const askConfirm = vi.fn();
const askChoice = vi.fn();
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
  isSpawnHeld: (...args: unknown[]) => isSpawnHeld(...args),
  unlockRetiredMissionPane: (...args: unknown[]) =>
    unlockRetiredMissionPane(...args),
}));

vi.mock('../state/confirm-store', () => ({
  askConfirm: (...args: unknown[]) => askConfirm(...args),
}));

vi.mock('../state/choice-store', () => ({
  askChoice: (...args: unknown[]) => askChoice(...args),
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
    useAccessStore.setState({ canUseApp: true });
    setActiveWorkspacePath('/workspace-a');
    resetRestoredAgentsGate();
    holdSpawnUntilApproved.mockReset();
    markResumeOnSpawn.mockReset();
    releaseHeldSpawns.mockReset();
    discardPaneSpawnState.mockReset();
    isSpawnHeld.mockReset();
    isSpawnHeld.mockReturnValue(true);
    unlockRetiredMissionPane.mockReset();
    askConfirm.mockReset();
    askChoice.mockReset();
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

  it('policy ask: holds agents and offers resume / pause / close', async () => {
    askChoice.mockResolvedValue('pause');
    await gateRestoredAgents([agent('a1', 'Orquestrador'), shell]);

    expect(holdSpawnUntilApproved).toHaveBeenCalledWith('a1');
    expect(askConfirm).not.toHaveBeenCalled();
    expect(askChoice).toHaveBeenCalledOnce();
    const request = askChoice.mock.calls[0]?.[0] as {
      title: string;
      options: Array<{ value: string; label: string }>;
      cancelLabel?: string;
    };
    expect(request.title).toBe('Retomar agentes da sessão anterior?');
    expect(request.options.map((option) => option.value).sort()).toEqual([
      'close',
      'pause',
      'resume',
    ]);
    expect(request.options.find((o) => o.value === 'close')?.label).toMatch(
      /fechar/i,
    );
    // O foco nasce na 1ª opção: tem de ser a que não faz nada irreversível.
    expect(request.options[0]?.value).toBe('pause');
    expect(request.cancelLabel).toBeTruthy();
    expect(releaseHeldSpawns).toHaveBeenCalledWith(['a1'], { resume: false });
  });

  it('on ask+cancel (Esc / clique fora / Cancelar), pauses and never closes', async () => {
    askChoice.mockResolvedValue(null);
    await gateRestoredAgents([agent('a1', 'Orq'), agent('a2', 'Worker')]);
    expect(releaseHeldSpawns).toHaveBeenCalledWith(['a1', 'a2'], {
      resume: false,
    });
    expect(closePane).not.toHaveBeenCalled();
    expect(discardPaneSpawnState).not.toHaveBeenCalled();
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

  it('on ask+resume, resumes agents', async () => {
    askChoice.mockResolvedValue('resume');
    await gateRestoredAgents([agent('a1', 'Orq'), agent('a2', 'Worker')]);
    expect(releaseHeldSpawns).toHaveBeenCalledWith(['a1', 'a2'], {
      resume: true,
    });
    expect(closePane).not.toHaveBeenCalled();
  });

  it('on ask+close, discards the loose agents: no spawn, panes leave the layout', async () => {
    const a1 = agent('a1', 'Orq');
    const a2 = agent('a2', 'Worker');
    layoutRoot.current = buildGridTree([a1, a2]) as never;
    askChoice.mockResolvedValue('close');
    await gateRestoredAgents([a1, a2]);

    const resumedIds = releaseHeldSpawns.mock.calls
      .filter(([, opts]) => (opts as { resume: boolean }).resume)
      .flatMap(([ids]) => ids as string[]);
    expect(resumedIds).toEqual([]);
    expect(discardPaneSpawnState).toHaveBeenCalledWith('a1');
    expect(discardPaneSpawnState).toHaveBeenCalledWith('a2');
    expect(closePane).toHaveBeenCalledWith('a1', 'restore-gate-discard');
    expect(closePane).toHaveBeenCalledWith('a2', 'restore-gate-discard');
  });

  it('on ask+close, leaves mission agents and shells alone', async () => {
    const loose = agent('loose', 'Avulso');
    const mission = missionAgent('m1', 'Maestro');
    layoutRoot.current = buildGridTree([loose, mission, shell]) as never;
    askChoice.mockResolvedValue('close');
    await gateRestoredAgents([loose, mission, shell]);

    expect(closePane).toHaveBeenCalledTimes(1);
    expect(closePane).toHaveBeenCalledWith('loose', 'restore-gate-discard');
    expect(closePane).not.toHaveBeenCalledWith('m1', expect.anything());
    expect(closePane).not.toHaveBeenCalledWith('sh-1', expect.anything());
  });

  it('on ask+close, never closes a pane whose hold was cleared while the dialog was open (adopted / started)', async () => {
    const adopted = agent('adopted', 'Adotado');
    const held = agent('held', 'Retido');
    layoutRoot.current = buildGridTree([adopted, held]) as never;
    askChoice.mockImplementation(async () => {
      // Main adotou o PTY vivo: o hold cai (markPersistedAuthorityOnSpawn).
      isSpawnHeld.mockImplementation((id: string) => id !== 'adopted');
      return 'close';
    });
    await gateRestoredAgents([adopted, held]);

    expect(closePane).toHaveBeenCalledTimes(1);
    expect(closePane).toHaveBeenCalledWith('held', 'restore-gate-discard');
    expect(discardPaneSpawnState).not.toHaveBeenCalledWith('adopted');
  });

  it('on ask+close, never closes a pane that became a mission agent while the dialog was open', async () => {
    const promoted = agent('promoted', 'Virou missão');
    const loose = agent('loose', 'Avulso');
    layoutRoot.current = buildGridTree([promoted, loose]) as never;
    askChoice.mockImplementation(async () => {
      layoutRoot.current = buildGridTree([
        { ...promoted, missionId: 'mission-z', role: 'orchestrator' as const },
        loose,
      ]) as never;
      return 'close';
    });
    await gateRestoredAgents([promoted, loose]);

    expect(closePane).toHaveBeenCalledTimes(1);
    expect(closePane).toHaveBeenCalledWith('loose', 'restore-gate-discard');
  });

  it('on ask+close, skips panes that already left the layout while the dialog was open', async () => {
    const gone = agent('gone', 'Já fechado');
    const kept = agent('kept', 'Ainda aqui');
    layoutRoot.current = buildGridTree([gone, kept]) as never;
    askChoice.mockImplementation(async () => {
      layoutRoot.current = buildGridTree([kept]) as never;
      return 'close';
    });
    await gateRestoredAgents([gone, kept]);

    expect(closePane).toHaveBeenCalledTimes(1);
    expect(closePane).toHaveBeenCalledWith('kept', 'restore-gate-discard');
  });

  it('holds restored agents while blocked, preserving layout and policy', async () => {
    useAccessStore.setState({ canUseApp: false });
    await gateRestoredAgents([agent('locked', 'Guardado')]);
    expect(holdSpawnUntilApproved).toHaveBeenCalledWith('locked');
    expect(releaseHeldSpawns).not.toHaveBeenCalled();
    expect(closePane).not.toHaveBeenCalled();
    expect(orchGet).not.toHaveBeenCalled();
  });

  it('rechecks access after asynchronous policy loading', async () => {
    orchGet.mockImplementation(async () => {
      useAccessStore.setState({ canUseApp: false });
      return { agentRestorePolicy: 'resume' };
    });
    await gateRestoredAgents([agent('late', 'Pendente')]);
    expect(releaseHeldSpawns).not.toHaveBeenCalledWith(['late'], { resume: true });
    expect(closePane).not.toHaveBeenCalled();
  });

  it('resumes access-held agents after unlock without dropping layout', async () => {
    installRestoredAgentsGate();
    const pane = agent('unlock', 'Guardado');
    layoutRoot.current = { kind: 'leaf', id: 'leaf-unlock', pane };
    useAccessStore.setState({ canUseApp: false });
    await gateRestoredAgents([pane]);
    orchGet.mockResolvedValue({ agentRestorePolicy: 'resume' });
    useAccessStore.setState({ canUseApp: true });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(releaseHeldSpawns).toHaveBeenCalledWith(['unlock'], { resume: true });
    expect(closePane).not.toHaveBeenCalled();
  });

  it('defers every pane in a coalesced restore prompt when access is revoked', async () => {
    installRestoredAgentsGate();
    const panes = [agent('batch-a', 'A'), agent('batch-b', 'B')];
    layoutRoot.current = buildGridTree(panes) as never;
    let decide!: (value: string | null) => void;
    askChoice.mockImplementation(() => new Promise<string | null>(resolve => { decide = resolve; }));
    const a = gateRestoredAgents([panes[0]]);
    const b = gateRestoredAgents([panes[1]]);
    for (let i = 0; i < 8; i++) await Promise.resolve();
    useAccessStore.setState({ canUseApp: false });
    decide('resume');
    await Promise.all([a, b]);
    orchGet.mockResolvedValue({ agentRestorePolicy: 'resume' });
    useAccessStore.setState({ canUseApp: true });
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(releaseHeldSpawns).toHaveBeenCalledWith(['batch-a', 'batch-b'], { resume: true });
  });

  it('installRestoredAgentsGate wires the layout restore handler', () => {
    installRestoredAgentsGate();
    expect(setRestoredPanesHandler).toHaveBeenCalledOnce();
  });
});
