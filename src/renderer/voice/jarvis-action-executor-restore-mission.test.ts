import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { JarvisContext, JarvisReply } from '../../shared/voice-ipc';
import type { MissionPickRequest, MissionPickResult } from '../../shared/mission-pick';

const { layoutState, missionPick, orchState, voiceState } = vi.hoisted(() => ({
  layoutState: { focusedPaneId: null as string | null, panes: [] as unknown[] },
  missionPick: vi.fn(),
  orchState: {
    workspaceEpoch: 0,
    squads: [] as unknown[],
    missionSummaries: [] as Array<{
      id: string;
      title: string;
      state: string;
      needsAttention: boolean;
      updatedAt: number;
    }>,
  },
  voiceState: { settingsOpen: false, closeSettings: vi.fn(), openSettings: vi.fn() },
}));

vi.mock('../state/layout-store', () => ({
  useLayoutStore: {
    getState: () => ({
      root: layoutState.panes,
      focusedPaneId: layoutState.focusedPaneId,
      focus: vi.fn(),
      addShellPane: vi.fn(() => 'pane-added'),
    }),
  },
}));
vi.mock('../lib/split-tree', () => ({ listPanes: () => layoutState.panes }));
vi.mock('../state/workspace-store', () => ({
  useWorkspaceStore: { getState: () => ({ current: null }) },
}));
vi.mock('../state/orch-store', () => ({
  useOrchStore: { getState: () => orchState },
}));
vi.mock('./voice-store', () => ({
  useVoiceStore: { getState: () => voiceState },
}));
vi.mock('../terminal/terminal-host', () => ({
  submitPromptToPane: vi.fn(),
  waitForSession: vi.fn(),
  writeToPane: vi.fn(),
}));
vi.mock('../browser/browser-host', () => ({ waitForBrowserPaneCreated: vi.fn() }));
vi.mock('../lib/credential-errors', () => ({ isMissingModelKeyError: () => false }));
vi.mock('./voice-playback', () => ({
  playAudioBase64: vi.fn(),
  stopAllPlayback: vi.fn(),
  bindWakeSuppressor: vi.fn(),
}));
vi.mock('../services/mcp-bridge', async (importActual) => ({
  ...(await importActual<Record<string, unknown>>()),
  invokeMcpWithConfirm: vi.fn(),
}));
vi.mock('./delegation-confirm', () => ({
  delegationConfirmPrompt: vi.fn(),
  setPendingDelegation: vi.fn(),
}));
vi.mock('./send-to-pane-target', () => ({
  isOrchestratorPane: () => false,
  resolveSendToPaneTarget: vi.fn(),
}));
vi.mock('../terminal/pane-close-guard', () => ({ requestPaneClose: vi.fn() }));

import { executeJarvisAction } from './jarvis-action-executor';
import { useProductNavigationStore } from '../state/product-navigation-store';
import { useAccessStore } from '../state/access-store';

const context: JarvisContext = {
  workspace: '/tmp/nexus',
  recents: [],
  squads: [],
  panes: [],
  focusedPane: null,
  orchestrator: null,
  missions: [],
};

function summary(id: string, title: string, updatedAt = 1_700_000_000_000) {
  return { id, title, state: 'running', needsAttention: false, updatedAt };
}

function restore(alvo?: string): JarvisReply {
  return { say: '', action: { type: 'restore_mission_panes', ...(alvo ? { alvo } : {}) } };
}

function openedMissionId(): string | null {
  const destination = useProductNavigationStore.getState().destination;
  return destination.kind === 'mission' ? destination.missionId : null;
}

describe('voice: restore_mission_panes picks the right mission or opens nothing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    useAccessStore.setState({ canUseApp: true, maxAgents: null });
    orchState.workspaceEpoch = 0;
    orchState.missionSummaries = [
      summary('mission-a', 'Site da loja'),
      summary('mission-b', 'Site da loja v2'),
      summary('mission-c', 'API de pagamento'),
    ];
    useProductNavigationStore.setState({
      destination: { kind: 'terminal' },
      settingsReturnDestination: null,
    });
    missionPick.mockReset();
    vi.stubGlobal('window', {
      nexus: {
        adapters: { list: vi.fn(async () => []) },
        voice: { confirmCommand: vi.fn(), logVoice: vi.fn() },
        jev: { missionPick },
      },
    });
  });

  it('opens the mission whose name was said, without asking the Jev', async () => {
    const onEffectMayHaveCommitted = vi.fn();
    const execution = await executeJarvisAction(restore('site da loja'), context, { onEffectMayHaveCommitted });
    expect(openedMissionId()).toBe('mission-a');
    expect(execution.sayText).toBe('Abrindo os terminais da missão Site da loja.');
    expect(execution.toolResult).toMatchObject({ ok: true, output: { missionId: 'mission-a' } });
    expect(onEffectMayHaveCommitted).toHaveBeenCalledOnce();
    expect(missionPick).not.toHaveBeenCalled();
  });

  it('opens the most recent mission when no name was said', async () => {
    await executeJarvisAction(restore(), context);
    expect(openedMissionId()).toBe('mission-a');
    expect(missionPick).not.toHaveBeenCalled();
  });

  it('does NOT open the first mission when no name matches: says so, lists what exists, opens nothing', async () => {
    missionPick.mockResolvedValue({ decision: 'undecided', reason: 'none' } satisfies MissionPickResult);
    const onEffectMayHaveCommitted = vi.fn();
    const execution = await executeJarvisAction(restore('banana'), context, { onEffectMayHaveCommitted });
    expect(openedMissionId()).toBeNull();
    expect(useProductNavigationStore.getState().destination).toEqual({ kind: 'terminal' });
    expect(execution.sayText).toBe(
      'Não achei nenhuma missão com esse nome. Você tem: Site da loja, Site da loja v2, API de pagamento.',
    );
    expect(execution.toolResult).toMatchObject({ tool: 'restore_mission_panes', ok: false });
    expect(execution.toolResult?.output).toBeUndefined();
    expect(execution.expectReply).toBe(true);
    expect(onEffectMayHaveCommitted).not.toHaveBeenCalled();
  });

  describe('nothing matches the spoken name (it may have been misheard)', () => {
    it('opens the mission the Jev read through the noise, and says it was an interpretation', async () => {
      missionPick.mockResolvedValue({ decision: 'picked', index: 0, confidence: 0.95 } satisfies MissionPickResult);
      const onEffectMayHaveCommitted = vi.fn();
      const execution = await executeJarvisAction(restore('sait da lója'), context, { onEffectMayHaveCommitted });
      expect(openedMissionId()).toBe('mission-a');
      expect(execution.sayText).toBe('Abrindo a missão Site da loja. Entendi assim o que você disse.');
      expect(execution.toolResult).toMatchObject({ ok: true, output: { missionId: 'mission-a' } });
      expect(onEffectMayHaveCommitted).toHaveBeenCalledOnce();
      const request = missionPick.mock.calls[0]![0] as MissionPickRequest;
      expect(request.kind).toBe('noMatch');
      expect(request.candidates).toHaveLength(3);
      expect(JSON.stringify(request)).not.toContain('mission-');
    });

    it('keeps "não achei" and opens nothing without a decision, without the bridge, or with nine missions', async () => {
      missionPick.mockResolvedValue({ decision: 'undecided', reason: 'low-confidence' } satisfies MissionPickResult);
      const undecided = await executeJarvisAction(restore('sait da lója'), context);
      expect(undecided.sayText).toMatch(/^Não achei nenhuma missão com esse nome\./);
      expect(openedMissionId()).toBeNull();

      vi.stubGlobal('window', {
        nexus: { adapters: { list: vi.fn(async () => []) }, voice: { confirmCommand: vi.fn(), logVoice: vi.fn() } },
      });
      const noBridge = await executeJarvisAction(restore('sait da lója'), context);
      expect(noBridge.sayText).toMatch(/^Não achei nenhuma missão com esse nome\./);

      vi.stubGlobal('window', {
        nexus: {
          adapters: { list: vi.fn(async () => []) },
          voice: { confirmCommand: vi.fn(), logVoice: vi.fn() },
          jev: { missionPick },
        },
      });
      missionPick.mockClear();
      missionPick.mockResolvedValue({ decision: 'picked', index: 0, confidence: 0.99 });
      orchState.missionSummaries = Array.from({ length: 9 }, (_, i) => summary(`mission-${i}`, `Missão ${i + 1}`));
      const nine = await executeJarvisAction(restore('sait da lója'), context);
      expect(nine.sayText).toMatch(/^Não achei nenhuma missão com esse nome\./);
      expect(missionPick).not.toHaveBeenCalled();
      expect(openedMissionId()).toBeNull();
    });
  });

  it('still says there is nothing to open when no mission is saved', async () => {
    orchState.missionSummaries = [];
    const execution = await executeJarvisAction(restore('loja'), context);
    expect(execution.sayText).toBe('Não tem nenhuma missão salva para abrir.');
    expect(execution.toolResult).toMatchObject({ ok: false, summary: 'sem missões' });
    expect(openedMissionId()).toBeNull();
  });

  describe('two similar names', () => {
    it('opens the mission the Jev picked and says which one it was', async () => {
      missionPick.mockResolvedValue({ decision: 'picked', index: 1, confidence: 0.9 } satisfies MissionPickResult);
      const onEffectMayHaveCommitted = vi.fn();
      const execution = await executeJarvisAction(restore('site'), context, { onEffectMayHaveCommitted });
      expect(openedMissionId()).toBe('mission-b');
      expect(execution.sayText).toBe('Abrindo a missão Site da loja v2, a mais parecida com o que você disse.');
      expect(execution.toolResult).toMatchObject({ ok: true, output: { missionId: 'mission-b' } });
      expect(onEffectMayHaveCommitted).toHaveBeenCalledOnce();
      const request = missionPick.mock.calls[0]![0] as MissionPickRequest;
      expect(request.candidates.map((c) => c.title)).toEqual(['Site da loja', 'Site da loja v2']);
      expect(JSON.stringify(request)).not.toContain('mission-');
    });

    it('opens nothing and asks which one when the Jev has no decision', async () => {
      missionPick.mockResolvedValue({ decision: 'undecided', reason: 'low-confidence' } satisfies MissionPickResult);
      const onEffectMayHaveCommitted = vi.fn();
      const execution = await executeJarvisAction(restore('site'), context, { onEffectMayHaveCommitted });
      expect(openedMissionId()).toBeNull();
      expect(execution.sayText).toBe('Achei 2 missões parecidas: Site da loja e Site da loja v2. Qual delas?');
      expect(execution.expectReply).toBe(true);
      expect(execution.toolResult).toMatchObject({ tool: 'restore_mission_panes', ok: false });
      expect(onEffectMayHaveCommitted).not.toHaveBeenCalled();
    });

    it('opens nothing and asks when the Jev call fails or the bridge is missing', async () => {
      missionPick.mockRejectedValue(new Error('ipc down'));
      const failed = await executeJarvisAction(restore('site'), context);
      expect(failed.sayText).toContain('Qual delas?');
      expect(openedMissionId()).toBeNull();

      vi.stubGlobal('window', {
        nexus: { adapters: { list: vi.fn(async () => []) }, voice: { confirmCommand: vi.fn(), logVoice: vi.fn() } },
      });
      const missing = await executeJarvisAction(restore('site'), context);
      expect(missing.sayText).toContain('Qual delas?');
      expect(openedMissionId()).toBeNull();
    });

    it('opens nothing when the Jev answers with an index outside the list', async () => {
      missionPick.mockResolvedValue({ decision: 'picked', index: 9, confidence: 0.99 });
      const execution = await executeJarvisAction(restore('site'), context);
      expect(openedMissionId()).toBeNull();
      expect(execution.toolResult).toMatchObject({ ok: false });
    });

    it('does not sit out the Jev wait when the turn is cancelled: the abort surfaces right away', async () => {
      missionPick.mockImplementation(() => new Promise(() => {}));
      const abort = new AbortController();
      const running = executeJarvisAction(restore('site'), context, { signal: abort.signal });
      abort.abort();
      const outcome = await Promise.race([
        running.then(
          () => 'resolved',
          (error: unknown) => (error as { name?: string }).name ?? 'error',
        ),
        new Promise<string>((resolve) => setTimeout(() => resolve('still waiting'), 1_000)),
      ]);
      expect(outcome).toBe('AbortError');
      expect(openedMissionId()).toBeNull();
    });

    it('honours a cancellation that arrives while the Jev is thinking: nothing opens', async () => {
      const abort = new AbortController();
      missionPick.mockImplementation(async () => {
        abort.abort();
        return { decision: 'picked', index: 1, confidence: 0.9 };
      });
      const onEffectMayHaveCommitted = vi.fn();
      await expect(
        executeJarvisAction(restore('site'), context, { signal: abort.signal, onEffectMayHaveCommitted }),
      ).rejects.toMatchObject({ name: 'AbortError' });
      expect(openedMissionId()).toBeNull();
      expect(onEffectMayHaveCommitted).not.toHaveBeenCalled();
    });
  });

  it('opens nothing when the project changed while the Jev was deciding (F-634/F-635)', async () => {
    missionPick.mockImplementation(async () => {
      // A pessoa trocou de projeto durante a espera: o resumo de missões é outro.
      orchState.workspaceEpoch += 1;
      orchState.missionSummaries = [summary('mission-z', 'Outro projeto')];
      return { decision: 'picked', index: 0, confidence: 0.95 } satisfies MissionPickResult;
    });
    const onEffectMayHaveCommitted = vi.fn();
    const execution = await executeJarvisAction(restore('site'), context, { onEffectMayHaveCommitted });
    expect(openedMissionId()).toBeNull();
    expect(onEffectMayHaveCommitted).not.toHaveBeenCalled();
    expect(execution.toolResult).toMatchObject({ ok: false });
    expect(execution.sayText).toMatch(/projeto mudou/i);
  });

  it('opens nothing when the chosen mission was removed while the Jev was deciding', async () => {
    missionPick.mockImplementation(async () => {
      orchState.missionSummaries = orchState.missionSummaries.filter((entry) => entry.id !== 'mission-a');
      return { decision: 'picked', index: 0, confidence: 0.95 } satisfies MissionPickResult;
    });
    const execution = await executeJarvisAction(restore('site'), context);
    expect(openedMissionId()).toBeNull();
    expect(execution.toolResult).toMatchObject({ ok: false });
  });

  it('keeps control and bidi characters of a hostile title out of the tool result summary (revisão de segurança, B2)', async () => {
    orchState.missionSummaries = [summary('mission-h', 'Loja\u202eevil\u0000 \u200bnome')];
    const execution = await executeJarvisAction(restore('loja'), context);
    expect(openedMissionId()).toBe('mission-h');
    expect(JSON.stringify(execution.toolResult)).not.toMatch(/[\u202a-\u202e\u2066-\u2069\u200b-\u200f\u0000]/);
  });
});
