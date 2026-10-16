import { useAccessStore } from '../state/access-store';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { JarvisContext, JarvisReply } from '../../shared/voice-ipc';
import type { SquadAgent } from '../../shared/orch-types';
import { PET_STUDIO_SQUAD } from '../../shared/pet-studio';

const {
  confirmCommand,
  credentialState,
  focusPane,
  invokeMcpWithConfirm,
  layoutState,
  orchState,
  resolveSendToPaneTarget,
  setPendingDelegation,
  submitPromptToPane,
  voiceState,
  waitForSession,
  workspaceState,
  writeToPane,
} = vi.hoisted(() => ({
  confirmCommand: vi.fn(),
  credentialState: { missingModelKey: false },
  focusPane: vi.fn(),
  invokeMcpWithConfirm: vi.fn(),
  resolveSendToPaneTarget: vi.fn(),
  setPendingDelegation: vi.fn(),
  submitPromptToPane: vi.fn(),
  waitForSession: vi.fn(),
  writeToPane: vi.fn(),
  voiceState: {
    settingsOpen: false,
    closeSettings: vi.fn(),
    openSettings: vi.fn(),
  },
  orchState: {
    squads: [] as Array<{ id: string; name: string; agents: SquadAgent[] }>,
    missionSummaries: [] as Array<{
      id: string;
      title: string;
      state: string;
      needsAttention: boolean;
      updatedAt: number;
    }>,
  },
  workspaceState: {
    current: null as { path: string; name: string } | null,
  },
  layoutState: {
    focusedPaneId: null as string | null,
    panes: [] as Array<{
      id: string;
      kind: 'shell' | 'cli-agent' | 'browser';
      title: string;
      missionId?: string;
    }>,
  },
}));

vi.mock('../state/layout-store', () => ({
  useLayoutStore: {
    getState: () => ({
      root: layoutState.panes,
      focusedPaneId: layoutState.focusedPaneId,
      focus: focusPane,
      addShellPane: vi.fn(() => 'pane-added'),
    }),
  },
}));
vi.mock('../lib/split-tree', () => ({ listPanes: () => layoutState.panes }));
vi.mock('../state/workspace-store', () => ({
  useWorkspaceStore: { getState: () => workspaceState },
}));
vi.mock('../state/orch-store', () => ({
  useOrchStore: { getState: () => orchState },
}));
vi.mock('./voice-store', () => ({
  useVoiceStore: { getState: () => voiceState },
}));
vi.mock('../terminal/terminal-host', () => ({
  submitPromptToPane,
  waitForSession,
  writeToPane,
}));
vi.mock('../browser/browser-host', () => ({
  waitForBrowserPaneCreated: vi.fn(),
}));
vi.mock('../lib/credential-errors', () => ({
  isMissingModelKeyError: () => credentialState.missingModelKey,
}));
vi.mock('./voice-playback', () => ({
  playAudioBase64: vi.fn(),
  stopAllPlayback: vi.fn(),
  bindWakeSuppressor: vi.fn(),
}));
vi.mock('../services/mcp-bridge', async (importActual) => ({
  ...(await importActual<Record<string, unknown>>()),
  invokeMcpWithConfirm,
}));
vi.mock('./delegation-confirm', () => ({
  delegationConfirmPrompt: vi.fn(),
  setPendingDelegation,
}));
vi.mock('./send-to-pane-target', () => ({
  isOrchestratorPane: () => false,
  resolveSendToPaneTarget,
}));
vi.mock('../terminal/pane-close-guard', () => ({
  requestPaneClose: vi.fn(),
}));

import { executeJarvisAction } from './jarvis-action-executor';
import {
  createEmptyMissionSetupDraft,
  useMissionSetupStore,
} from '../state/mission-setup-store';
import { useProductNavigationStore } from '../state/product-navigation-store';

const context: JarvisContext = {
  workspace: '/tmp/nexus',
  recents: [],
  squads: [],
  panes: [],
  focusedPane: null,
  orchestrator: null,
  missions: [],
};

const TEST_AGENT: SquadAgent = {
  id: 'mission-coordinator',
  agentName: 'Coordenar missão',
  category: 'orchestrator',
  cli: 'claude',
  model: 'sonnet',
  allowedSkills: [],
  allowedTools: null,
};

function mcpReply(tool: string): JarvisReply {
  return {
    say: '',
    action: { type: 'mcp_tool', tool, args: {} },
  };
}

describe('Jarvis MCP result propagation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    credentialState.missingModelKey = false;
    layoutState.focusedPaneId = null;
    layoutState.panes = [];
    focusPane.mockImplementation((paneId: string) => {
      layoutState.focusedPaneId = paneId;
    });
    voiceState.settingsOpen = false;
    orchState.squads = [];
    orchState.missionSummaries = [];
    workspaceState.current = null;
    useMissionSetupStore.setState({
      workspacePath: null,
      draft: createEmptyMissionSetupDraft(),
      persistence: { status: 'idle' },
      workspaceDrafts: {},
    });
    useProductNavigationStore.setState({
      destination: { kind: 'terminal' },
      settingsReturnDestination: null,
    });
    vi.stubGlobal('window', {
      nexus: {
        adapters: { list: vi.fn(async () => []) },
        voice: { confirmCommand, logVoice: vi.fn() },
      },
    });
  });

  it('restores a saved mission through its canonical mission context', async () => {
    orchState.missionSummaries = [
      {
        id: 'mission-a',
        title: 'Checkout',
        state: 'running',
        needsAttention: false,
        updatedAt: 2,
      },
    ];

    const execution = await executeJarvisAction(
      { say: '', action: { type: 'restore_mission_panes', alvo: 'checkout' } },
      context,
    );

    expect(execution.sayText).toBe('Abrindo os terminais da missão Checkout.');
    expect(execution.toolResult).toMatchObject({
      ok: true,
      output: { missionId: 'mission-a' },
    });
    expect(useProductNavigationStore.getState().destination).toEqual({
      kind: 'mission',
      missionId: 'mission-a',
      surface: 'terminals',
    });
  });

  it('reroutes natural-language prose mislabeled as run_command to agent delegation', async () => {
    resolveSendToPaneTarget.mockReturnValue({
      kind: 'delegation',
      orchestratorPaneId: 'pane-orq',
    });
    waitForSession.mockResolvedValue('session-orq');
    submitPromptToPane.mockReturnValue(true);

    const execution = await executeJarvisAction(
      {
        say: '',
        action: { type: 'run_command', command: 'análise completa de UX' },
      },
      context,
    );

    expect(confirmCommand).not.toHaveBeenCalled();
    expect(writeToPane).not.toHaveBeenCalled();
    expect(submitPromptToPane).toHaveBeenCalledWith(
      'pane-orq',
      expect.stringContaining('Objective: análise completa de UX'),
    );
    expect(execution.toolResult).toMatchObject({
      tool: 'send_to_pane',
      ok: true,
    });
  });

  it('keeps a shell command with accented arguments in the confirmed shell path', async () => {
    layoutState.focusedPaneId = 'pane-shell';
    layoutState.panes = [
      { id: 'pane-shell', kind: 'shell', title: 'Terminal principal' },
    ];
    waitForSession.mockResolvedValue('session-shell');
    confirmCommand.mockResolvedValue(true);
    writeToPane.mockReturnValue(true);

    const execution = await executeJarvisAction(
      {
        say: '',
        action: { type: 'run_command', command: 'git commit -m "correção do bug"' },
      },
      context,
    );

    expect(confirmCommand).toHaveBeenCalledWith('git commit -m "correção do bug"');
    expect(writeToPane).toHaveBeenCalledWith(
      'pane-shell',
      'git commit -m "correção do bug"\n',
    );
    expect(submitPromptToPane).not.toHaveBeenCalled();
    expect(execution.toolResult).toMatchObject({ tool: 'run_command', ok: true });
  });

  it('rejects a multiline shell payload before opening a terminal or requesting approval', async () => {
    const execution = await executeJarvisAction(
      {
        say: '',
        action: { type: 'run_command', command: 'echo seguro\nrm -rf /' },
      },
      context,
    );

    expect(confirmCommand).not.toHaveBeenCalled();
    expect(writeToPane).not.toHaveBeenCalled();
    expect(execution.toolResult).toMatchObject({ tool: 'run_command', ok: false });
    expect(execution.sayText).toContain('uma única linha');
  });

  it('reads the actual focused terminal through nexus_pane_read', async () => {
    layoutState.focusedPaneId = 'pane-terminal';
    layoutState.panes = [
      { id: 'pane-terminal', kind: 'shell', title: 'Terminal principal' },
    ];
    invokeMcpWithConfirm.mockResolvedValueOnce({
      ok: true,
      tool: 'nexus_pane_read',
      result: 'TEST_OUTPUT_MARKER',
    });

    const execution = await executeJarvisAction(
      { say: '', action: { type: 'read_pane' } },
      context,
    );

    expect(invokeMcpWithConfirm).toHaveBeenCalledWith(
      'nexus_pane_read',
      { paneId: 'pane-terminal', lines: 200 },
      expect.objectContaining({ signal: undefined }),
    );
    expect(execution.toolResult).toEqual({
      tool: 'read_pane',
      ok: true,
      summary: 'nexus_pane_read ok',
      output: 'TEST_OUTPUT_MARKER',
    });
  });

  it('reads the visible Nexus surface through local AX + OCR without a cloud image', async () => {
    const contextView = {
      capturedAt: '2026-07-10T15:00:00.000Z',
      ax: {
        status: 'ok',
        tree: {
          tag: 'body',
          role: null,
          aria: {},
          text: null,
          children: [
            {
              tag: 'h1',
              role: 'heading',
              aria: {},
              text: 'Nova Missão',
              children: [],
            },
          ],
        },
      },
      ocr: { status: 'ok', text: 'Modo Agêntico', confidence: 95 },
      screenshot: {
        status: 'ok',
        format: 'png',
        width: 1280,
        height: 720,
        capturedAt: '2026-07-10T15:00:00.000Z',
        sourceId: 'window:nexus:1',
        hasImage: true,
        cloudAllowed: false,
      },
      llmPrompt: 'unused',
    } as const;
    const readView = vi.fn(async () => contextView);
    vi.stubGlobal('window', { nexus: { vision: { context: readView } } });

    const execution = await executeJarvisAction(
      { say: 'Vou ler a tela.', action: { type: 'read_current_view' } },
      context,
    );

    expect(readView).toHaveBeenCalledWith({
      includeScreenshot: true,
      includeOcr: true,
      allowCloudImage: false,
    });
    expect(execution.sayText).toContain('Nova Missão');
    expect(execution.toolResult).toMatchObject({
      tool: 'read_current_view',
      ok: true,
      summary: expect.stringContaining('localmente'),
    });
    expect(JSON.stringify(execution.toolResult?.output)).toContain('Modo Agêntico');
  });

  it('opens canonical mission setup with the spoken objective', async () => {
    workspaceState.current = { path: '/tmp/nexus', name: 'Nexus' };

    const execution = await executeJarvisAction(
      {
        say: '',
        action: {
          type: 'new_agentic_mission',
          intent: 'auditar os logs da Jarvis',
        },
      },
      context,
    );

    expect(useProductNavigationStore.getState().destination).toEqual({
      kind: 'mission-setup',
    });
    expect(useMissionSetupStore.getState()).toMatchObject({
      workspacePath: '/tmp/nexus',
      draft: {
        objective: 'auditar os logs da Jarvis',
        step: 'team',
      },
    });
    expect(execution.toolResult).toMatchObject({
      tool: 'new_agentic_mission',
      ok: true,
    });
  });

  it('keeps squad confirmation in mission setup until an objective exists', async () => {
    useMissionSetupStore.getState().setWorkspace('/tmp/nexus');
    useMissionSetupStore.getState().setRoster([TEST_AGENT]);

    const execution = await executeJarvisAction(
      { say: '', action: { type: 'confirm_squad' } },
      context,
    );

    expect(useMissionSetupStore.getState().draft.step).toBe('mission');
    expect(useProductNavigationStore.getState().destination).toEqual({
      kind: 'mission-setup',
    });
    expect(execution.expectReply).toBe(false);
    expect(execution.toolResult).toMatchObject({
      ok: true,
      summary: expect.stringMatching(/setup canônico/i),
    });
  });

  it('opens canonical review when squad and objective are ready', async () => {
    const setup = useMissionSetupStore.getState();
    setup.setWorkspace('/tmp/nexus');
    setup.setRoster([TEST_AGENT]);
    setup.setObjective('corrigir a busca local');

    const execution = await executeJarvisAction(
      { say: '', action: { type: 'confirm_squad' } },
      context,
    );

    expect(useMissionSetupStore.getState().draft.step).toBe('review');
    expect(useProductNavigationStore.getState().destination).toEqual({
      kind: 'mission-setup',
    });
    expect(execution.toolResult).toMatchObject({
      ok: true,
      summary: expect.stringMatching(/revisão canônica/i),
    });
  });

  it('dispatches a routine delegation immediately without a confirmation round trip', async () => {
    resolveSendToPaneTarget.mockReturnValueOnce({
      kind: 'delegation',
      orchestratorPaneId: 'pane-orq',
    });
    waitForSession.mockResolvedValueOnce('session-orq');
    submitPromptToPane.mockReturnValueOnce(true);

    const execution = await executeJarvisAction(
      { say: '', action: { type: 'send_to_pane', text: 'corrigir o login' } },
      context,
    );

    expect(submitPromptToPane).toHaveBeenCalledWith(
      'pane-orq',
      expect.stringContaining('Objective: corrigir o login'),
    );
    expect(setPendingDelegation).not.toHaveBeenCalled();
    expect(execution.expectReply).not.toBe(true);
    expect(execution.toolResult).toMatchObject({
      tool: 'send_to_pane',
      ok: true,
      summary: expect.stringContaining('submetida ao pane'),
    });
  });

  describe('send_to_pane com terminal como alvo explícito', () => {
    const shellTarget = { kind: 'asking-pane', paneId: 'pane-shell', terminal: true };

    // `Once` de propósito: um mockReturnValue persistente vazaria o alvo shell
    // para os testes seguintes do arquivo (clearAllMocks não limpa implementação).
    const armShellTarget = () => resolveSendToPaneTarget.mockReturnValueOnce(shellTarget);

    beforeEach(() => {
      layoutState.panes = [{ id: 'pane-shell', kind: 'shell', title: 'zsh' }];
      waitForSession.mockResolvedValue('session-shell');
      writeToPane.mockReturnValue(true);
      confirmCommand.mockResolvedValue(true);
    });

    it('pede ao resolvedor que aceite terminal só neste caminho', async () => {
      armShellTarget();
      await executeJarvisAction(
        { say: '', action: { type: 'send_to_pane', text: 'npm test', paneId: '2' } },
        context,
      );

      expect(resolveSendToPaneTarget).toHaveBeenCalledWith(
        '2',
        expect.anything(),
        null,
        { allowTerminal: true },
      );
    });

    it('escreve o comando de uma linha no terminal pedido e revela o pane', async () => {
      armShellTarget();
      const execution = await executeJarvisAction(
        { say: '', action: { type: 'send_to_pane', text: 'npm test', paneId: '2' } },
        context,
      );

      expect(confirmCommand).toHaveBeenCalledWith('npm test');
      expect(writeToPane).toHaveBeenCalledWith('pane-shell', 'npm test\n');
      expect(submitPromptToPane).not.toHaveBeenCalled();
      expect(focusPane).toHaveBeenCalledWith('pane-shell');
      expect(execution.toolResult).toMatchObject({
        tool: 'send_to_pane',
        ok: true,
        output: { paneId: 'pane-shell' },
      });
    });

    it('comando destrutivo recusado pelo operador não chega ao terminal', async () => {
      confirmCommand.mockResolvedValue(false);
      armShellTarget();

      const execution = await executeJarvisAction(
        { say: '', action: { type: 'send_to_pane', text: 'rm -rf node_modules', paneId: '2' } },
        context,
      );

      expect(confirmCommand).toHaveBeenCalledWith('rm -rf node_modules');
      expect(writeToPane).not.toHaveBeenCalled();
      expect(execution.toolResult).toMatchObject({ ok: false, summary: 'usuário recusou' });
    });

    it('bloqueia texto multilinha e vazio antes de pedir aprovação ou escrever', async () => {
      for (const text of ['npm test\nrm -rf /', '   ']) {
        armShellTarget();
        const execution = await executeJarvisAction(
          { say: '', action: { type: 'send_to_pane', text, paneId: '2' } },
          context,
        );
        expect(execution.toolResult).toMatchObject({ ok: false });
      }

      expect(confirmCommand).not.toHaveBeenCalled();
      expect(writeToPane).not.toHaveBeenCalled();
    });

    it('terminal sem sessão viva falha sem fingir sucesso', async () => {
      waitForSession.mockResolvedValue(null);
      armShellTarget();

      const execution = await executeJarvisAction(
        { say: '', action: { type: 'send_to_pane', text: 'npm test', paneId: '2' } },
        context,
      );

      expect(writeToPane).not.toHaveBeenCalled();
      expect(execution.toolResult).toMatchObject({
        ok: false,
        summary: 'falha ao escrever no terminal',
      });
    });

    it('agente continua recebendo prompt (submitPromptToPane), nunca writeToPane', async () => {
      resolveSendToPaneTarget.mockReturnValueOnce({ kind: 'asking-pane', paneId: 'pane-agent' });
      submitPromptToPane.mockReturnValue(true);

      await executeJarvisAction(
        { say: '', action: { type: 'send_to_pane', text: 'rode os testes', paneId: '3' } },
        context,
      );

      expect(submitPromptToPane).toHaveBeenCalledWith('pane-agent', 'rode os testes');
      expect(writeToPane).not.toHaveBeenCalled();
      expect(confirmCommand).not.toHaveBeenCalled();
    });

    it('pane inexistente recusa com mensagem neutra e não escreve em lugar nenhum', async () => {
      resolveSendToPaneTarget.mockReturnValueOnce({
        kind: 'asking-pane-gone',
        requestedNumber: 9,
        validNumbers: [1, 2],
      });

      const execution = await executeJarvisAction(
        { say: '', action: { type: 'send_to_pane', text: 'npm test', paneId: '9' } },
        context,
      );

      expect(execution.sayText).toBe('Não tem pane 9 aberto. Os panes abertos são: 1, 2.');
      expect(writeToPane).not.toHaveBeenCalled();
      expect(submitPromptToPane).not.toHaveBeenCalled();
    });
  });

  it('prefills canonical mission setup when delegation has no live agent pane', async () => {
    workspaceState.current = { path: '/tmp/nexus', name: 'Nexus' };
    resolveSendToPaneTarget.mockReturnValueOnce({ kind: 'no-agent-pane' });

    const execution = await executeJarvisAction(
      { say: '', action: { type: 'send_to_pane', text: 'corrigir o login' } },
      context,
    );

    expect(useProductNavigationStore.getState().destination).toEqual({
      kind: 'mission-setup',
    });
    expect(useMissionSetupStore.getState().draft).toMatchObject({
      objective: 'corrigir o login',
      step: 'team',
    });
    expect(confirmCommand).not.toHaveBeenCalled();
    expect(writeToPane).not.toHaveBeenCalled();
    expect(execution.toolResult).toMatchObject({
      tool: 'send_to_pane',
      ok: true,
    });
  });

  it('opens the saved squad catalog with usable member actions instead of an empty team picker', async () => {
    workspaceState.current = { path: '/tmp/nexus', name: 'Nexus' };
    orchState.squads = [
      { id: 'navalha', name: 'Navalha', agents: [TEST_AGENT] },
    ];

    const execution = await executeJarvisAction(
      { say: '', action: { type: 'open_squad_picker' } },
      context,
    );

    expect(useProductNavigationStore.getState().destination).toEqual({
      kind: 'settings', section: 'squads',
    });
    expect(useMissionSetupStore.getState().draft).toMatchObject({
      roster: [],
    });
    expect(execution.toolResult).toMatchObject({ ok: true });
    expect(execution.sayText).toContain('Usar integrantes');
  });

  it('copies a named saved squad into canonical mission setup', async () => {
    workspaceState.current = { path: '/tmp/nexus', name: 'Nexus' };
    orchState.squads = [
      { id: 'navalha', name: 'Navalha', agents: [TEST_AGENT] },
    ];

    const execution = await executeJarvisAction(
      { say: '', action: { type: 'open_squad', squadName: 'Navalha' } },
      context,
    );

    expect(useProductNavigationStore.getState().destination).toEqual({
      kind: 'mission-setup',
    });
    expect(useMissionSetupStore.getState().draft).toMatchObject({
      roster: [TEST_AGENT],
      step: 'mission',
    });
    expect(execution.toolResult).toMatchObject({ ok: true });
    expect(execution.sayText).toContain('Integrantes');
    expect(execution.sayText).toContain('instruções globais');
  });

  it('routes a named Pet Studio squad to its dedicated appearance flow', async () => {
    workspaceState.current = { path: '/tmp/nexus', name: 'Nexus' };
    orchState.squads = [PET_STUDIO_SQUAD];
    const execution = await executeJarvisAction({ say: '', action: { type: 'open_squad', squadName: PET_STUDIO_SQUAD.name } }, context);
    expect(useProductNavigationStore.getState().destination).toEqual({ kind: 'settings', section: 'appearance' });
    expect(useMissionSetupStore.getState().draft.roster).toEqual([]);
    expect(execution.toolResult).toMatchObject({ ok: true });
  });

  it('routes missing squad-design credentials to canonical provider settings', async () => {
    workspaceState.current = { path: '/tmp/nexus', name: 'Nexus' };
    credentialState.missingModelKey = true;
    const designSquad = vi.fn(async () => ({
      ok: false as const,
      error: 'missing model credential',
    }));
    vi.stubGlobal('window', {
      nexus: {
        adapters: { list: vi.fn(async () => []) },
        orch: { designSquad },
        voice: { confirmCommand, logVoice: vi.fn() },
      },
    });

    const execution = await executeJarvisAction(
      { say: '', action: { type: 'design_squad' } },
      context,
    );

    expect(useProductNavigationStore.getState().destination).toEqual({
      kind: 'settings',
      section: 'providers',
    });
    expect(voiceState.openSettings).not.toHaveBeenCalled();
    expect(execution.toolResult).toMatchObject({ ok: false });
  });

  it('reports a rejected generated roster without claiming the team was applied', async () => {
    workspaceState.current = { path: '/tmp/nexus', name: 'Nexus' };
    vi.stubGlobal('window', { nexus: { orch: {
      designSquad: vi.fn(async () => ({ ok: true, squad: {
        id: 'generated-invalid', name: 'Equipe inválida',
        agents: Array.from({ length: 13 }, (_, index) => ({ ...TEST_AGENT, id: `generated-${index}` })),
      } })),
    } } });
    const result = await executeJarvisAction({ say: '', action: { type: 'design_squad' } }, context);
    expect(result.toolResult?.ok).toBe(false);
    expect(result.sayText).toMatch(/não foi possível aplicar/i);
    expect(useMissionSetupStore.getState().draft.roster).toEqual([]);
    expect(useProductNavigationStore.getState().destination.kind).not.toBe('mission-setup');
  });

  it('reroutes a structured mission mislabeled as run_command to the orchestrator', async () => {
    resolveSendToPaneTarget.mockReturnValueOnce({
      kind: 'delegation',
      orchestratorPaneId: 'pane-orq',
    });
    waitForSession.mockResolvedValueOnce('session-orq');
    submitPromptToPane.mockReturnValueOnce(true);
    const mission = [
      'Objective: Investigate the scheduling bug.',
      'Execution requirements:',
      '- Inspect logs and source code.',
      'Acceptance criteria:',
      '- Identify the trigger.',
    ].join('\n');

    const execution = await executeJarvisAction(
      { say: '', action: { type: 'run_command', command: mission } },
      context,
    );

    expect(submitPromptToPane).toHaveBeenCalledWith('pane-orq', mission);
    expect(execution.toolResult).toMatchObject({ tool: 'send_to_pane', ok: true });
  });

  it('reads the actual focused browser page through nexus_browser_read', async () => {
    layoutState.focusedPaneId = 'pane-browser';
    layoutState.panes = [
      { id: 'pane-browser', kind: 'browser', title: 'Nexus docs' },
    ];
    invokeMcpWithConfirm.mockResolvedValueOnce({
      ok: true,
      tool: 'nexus_browser_read',
      result: { title: 'Nexus docs', bodyText: 'BROWSER_PAGE_MARKER' },
    });

    const execution = await executeJarvisAction(
      { say: '', action: { type: 'read_pane' } },
      context,
    );

    expect(invokeMcpWithConfirm).toHaveBeenCalledWith(
      'nexus_browser_read',
      { paneId: 'pane-browser', maxChars: 20_000, maxElements: 200 },
      expect.objectContaining({ signal: undefined }),
    );
    expect(execution.toolResult).toEqual({
      tool: 'read_pane',
      ok: true,
      summary: 'nexus_browser_read ok',
      output: { title: 'Nexus docs', bodyText: 'BROWSER_PAGE_MARKER' },
    });
  });

  it.each([
    {
      tool: 'nexus_file_read',
      marker: 'FILE_READ_MARKER_7b16',
      result: {
        path: 'src/marker.ts',
        content: 'payload:FILE_READ_MARKER_7b16',
      },
    },
    {
      tool: 'nexus_pane_read',
      marker: 'PANE_READ_MARKER_4a92',
      result: 'pane-tail:PANE_READ_MARKER_4a92',
    },
  ])('preserves the real $tool result in toolResult.output', async ({
    tool,
    marker,
    result,
  }) => {
    invokeMcpWithConfirm.mockResolvedValueOnce({
      ok: true,
      tool,
      result,
    });

    const execution = await executeJarvisAction(mcpReply(tool), context);

    expect(execution.toolResult).toMatchObject({
      tool: 'mcp_tool',
      ok: true,
    });
    expect(execution.toolResult?.output).toEqual(result);
    expect(JSON.stringify(execution.toolResult?.output)).toContain(marker);
  });

  it('redacts secrets and bounds oversized MCP results before exposing them to Live', async () => {
    const secret = 'sk-super-secret-value-1234567890';
    const envSecret = 'plain-database-password-value';
    invokeMcpWithConfirm.mockResolvedValueOnce({
      ok: true,
      tool: 'nexus_file_read',
      result: {
        marker: 'SAFE_MARKER',
        apiKey: secret,
        content:
          `const token = "${secret}";\n` +
          `NEXUS_DATABASE_PASSWORD=${envSecret}\n` +
          'x'.repeat(30_000),
      },
    });

    const execution = await executeJarvisAction(
      mcpReply('nexus_file_read'),
      context,
    );
    const serialized = JSON.stringify(execution.toolResult?.output);

    expect(serialized).toContain('SAFE_MARKER');
    expect(serialized).toContain('[REDACTED]');
    expect(serialized).toContain('[TRUNCATED]');
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(envSecret);
    expect(serialized.length).toBeLessThanOrEqual(16_500);
  });

  it('threads cancellation control into the MCP confirmation/invoke boundary', async () => {
    const abort = new AbortController();
    const onEffectMayHaveCommitted = vi.fn();
    invokeMcpWithConfirm.mockImplementationOnce(
      async (_tool, _args, control) => {
        expect(control?.signal).toBe(abort.signal);
        control?.onEffectMayHaveCommitted?.();
        return { ok: true, tool: 'nexus_file_read', result: { ok: true } };
      },
    );

    await executeJarvisAction(mcpReply('nexus_file_read'), context, {
      signal: abort.signal,
      onEffectMayHaveCommitted,
    });

    expect(onEffectMayHaveCommitted).toHaveBeenCalledOnce();
  });

  it('does not enter MCP execution when the Live call was already cancelled', async () => {
    const abort = new AbortController();
    abort.abort();

    await expect(
      executeJarvisAction(mcpReply('nexus_file_read'), context, {
        signal: abort.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(invokeMcpWithConfirm).not.toHaveBeenCalled();
  });
});

beforeEach(() => { useAccessStore.setState({ canUseApp: true, maxAgents: null }); });
