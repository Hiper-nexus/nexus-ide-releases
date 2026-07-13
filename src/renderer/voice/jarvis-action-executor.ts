import type { JarvisAction, JarvisContext, JarvisReply } from '../../shared/voice-ipc';
import { useLayoutStore } from '../state/layout-store';
import { listPanes } from '../lib/split-tree';
import { useWorkspaceStore } from '../state/workspace-store';
import { useOrchStore } from '../state/orch-store';
import { useMissionWizardStore } from '../state/mission-wizard-store';
import { useHomeStore } from '../state/home-store';
import { useGamificationStore } from '../state/gamification-store';
import { useVoiceStore } from './voice-store';
import { useSettingsStore } from '../state/settings-store';
import { waitForSession, writeToPane } from '../terminal/terminal-host';
import {
  assessTerminalVisibility,
  readUiVisibilityState,
} from './terminal-visibility';
import { waitForBrowserPaneCreated } from '../browser/browser-host';
import { launchSquadMission } from '../orch/mission-launcher';
import { isMissingModelKeyError } from '../lib/credential-errors';
import { invokeMcpWithConfirm, mapActionToTool } from '../services/mcp-bridge';
import { reopenMission } from '../orch/mission-reopen';
import { isOrchestratorPane, resolveSendToPaneTarget } from './send-to-pane-target';
import { requestPaneClose } from '../terminal/pane-close-guard';
import { sanitizeMcpResultOutput } from './mcp-result-output';
import { currentViewNarration, currentViewToolOutput } from './current-view-read';
import { waitForActionEvidence } from './action-evidence';
import { resolveWorkspaceByVoiceName } from './workspace-name-resolver';
import { logVoiceEvent } from './voice-live-ipc';
import {
  isExecutionReadyDelegationPrompt,
  prepareDelegationPrompt,
} from './delegation-prompt';

export interface JarvisExecutionResult {
  sayText: string;
  expectReply?: boolean;
  toolResult: {
    tool: JarvisAction['type'];
    ok: boolean;
    summary: string;
    output?: unknown;
  } | null;
}

export interface JarvisExecutionControl {
  signal?: AbortSignal;
  onEffectMayHaveCommitted?: () => void;
  /** Correlates state created by a native realtime tool with its completion. */
  originCallId?: string;
}

function checkpoint(control: JarvisExecutionControl): void {
  if (!control.signal?.aborted) return;
  const error = new Error('Jarvis action cancelled');
  error.name = 'AbortError';
  throw error;
}

function markEffect(control: JarvisExecutionControl): void {
  control.onEffectMayHaveCommitted?.();
}

async function confirmUiState<T>(
  read: () => T,
  accepts: (value: T) => boolean,
  control: JarvisExecutionControl,
): Promise<boolean> {
  const evidence = await waitForActionEvidence({
    read,
    accepts,
    timeoutMs: 750,
    pollMs: 25,
    signal: control.signal,
  });
  checkpoint(control);
  return evidence.status === 'committed';
}

function findOrchestratorPane(
  root: ReturnType<typeof useLayoutStore.getState>['root'],
): string | null {
  return listPanes(root).find(isOrchestratorPane)?.id ?? null;
}

function paneContext() {
  const { root, focusedPaneId } = useLayoutStore.getState();
  return {
    focusedPaneId,
    orchestratorPaneId: findOrchestratorPane(root),
  };
}

function mcpSummary(result: { ok: boolean; tool: string; error?: string }): string {
  if (result.ok) return `${result.tool} ok`;
  return result.error ?? `${result.tool} falhou`;
}

/** Fecha overlays que cobrem a área de panes (perfil, home, settings…). */
function dismissBlockingOverlays(): void {
  useGamificationStore.getState().closeProfile();
  useHomeStore.getState().hide();
  useMissionWizardStore.getState().close();
  useOrchStore.getState().closeBoard();
  useVoiceStore.getState().closeSettings();
  const settings = useSettingsStore.getState();
  if (settings.drawerOpen) settings.toggleDrawer();
}

/** Garante que o pane recém-aberto fique visível (grade + foco). */
function revealPaneForUser(paneId: string): void {
  dismissBlockingOverlays();
  const layout = useLayoutStore.getState();
  if (layout.viewKind !== 'grid') layout.toggleView();
  layout.focus(paneId);
}

function focusedOrFirstBrowserPane(): { id: string; title: string } | null {
  const { root, focusedPaneId } = useLayoutStore.getState();
  const panes = listPanes(root);
  const focused = focusedPaneId
    ? panes.find((pane) => pane.id === focusedPaneId)
    : undefined;
  const browser = focused?.kind === 'browser'
    ? focused
    : panes.find((pane) => pane.kind === 'browser');
  return browser ? { id: browser.id, title: browser.title } : null;
}

function normPaneName(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function findPaneByVoiceName(
  panes: ReturnType<typeof listPanes>,
  paneName: string,
): ReturnType<typeof listPanes>[number] | null {
  const wanted = normPaneName(paneName);
  if (!wanted) return null;
  if (/\b(orquestrador|orchestrator)\b/.test(wanted)) {
    return (
      panes.find((pane) => pane.orchRequestId?.startsWith('squad-')) ??
      panes.find((pane) => /(^|[ ·])orq\b/i.test(pane.title)) ??
      null
    );
  }
  if (/\b(terminal|shell|console)\b/.test(wanted)) {
    return panes.find((pane) => pane.kind === 'shell') ?? null;
  }
  if (/\b(browser|navegador|pagina|page|site)\b/.test(wanted)) {
    return panes.find((pane) => pane.kind === 'browser') ?? null;
  }
  if (/\b(agente|agent|worker|codex|claude|agy)\b/.test(wanted)) {
    return (
      panes.find((pane) => pane.kind === 'cli-agent' && normPaneName(pane.title).includes(wanted)) ??
      panes.find((pane) => pane.kind === 'cli-agent') ??
      null
    );
  }
  return (
    panes.find((pane) => normPaneName(pane.title) === wanted) ??
    panes.find((pane) => normPaneName(pane.title).includes(wanted)) ??
    panes.find((pane) => wanted.includes(normPaneName(pane.title))) ??
    null
  );
}

async function navigateBrowserPane(
  nav: 'back' | 'forward' | 'reload',
  control: JarvisExecutionControl,
): Promise<{ ok: boolean; summary: string }> {
  const pane = focusedOrFirstBrowserPane();
  if (!pane) return { ok: false, summary: 'nenhum browser aberto' };
  try {
    checkpoint(control);
    await window.nexus.browser[nav](pane.id);
    markEffect(control);
    checkpoint(control);
    return { ok: true, summary: `browser ${nav} em ${pane.title}` };
  } catch (err) {
    return {
      ok: false,
      summary: err instanceof Error ? err.message : String(err),
    };
  }
}

async function executeViaMcp(
  action: JarvisAction,
  sayText: string,
  control: JarvisExecutionControl,
): Promise<JarvisExecutionResult | null> {
  checkpoint(control);
  const ctx = paneContext();
  const mapping = mapActionToTool(action, ctx);
  if (!mapping) return null;

  const result = await invokeMcpWithConfirm(mapping.tool, mapping.args, {
    signal: control.signal,
    onEffectMayHaveCommitted: control.onEffectMayHaveCommitted,
  });
  checkpoint(control);
  console.log(
    `[voice] mcp ${mapping.tool} → ${result.ok ? 'OK' : result.error ?? 'FALHOU'}`,
  );
  return {
    sayText: result.ok
      ? sayText || 'Feito.'
      : result.error?.includes('user_denied')
        ? 'Cancelei, não executei.'
        : `Não consegui: ${result.error ?? 'erro'}.`,
    toolResult: {
      tool: action.type === 'mcp_tool' ? 'mcp_tool' : action.type,
      ok: result.ok,
      summary: mcpSummary(result),
      ...(result.result !== undefined
        ? { output: sanitizeMcpResultOutput(result.result) }
        : {}),
    },
  };
}

/**
 * Executa a ação decidida pelo cérebro — MCP primeiro (guardrails + audit),
 * fallback UI para squads, workspaces e wizards.
 */
export async function executeJarvisAction(
  reply: JarvisReply,
  context: JarvisContext,
  control: JarvisExecutionControl = {},
): Promise<JarvisExecutionResult> {
  checkpoint(control);
  let sayText = reply.say;
  let expectReply = reply.expectReply;
  const action: JarvisAction =
    reply.action.type === 'run_command' &&
    isExecutionReadyDelegationPrompt(reply.action.command)
      ? { type: 'send_to_pane', text: reply.action.command }
      : reply.action;

  if (action.type !== 'none') {
    // run_command must reach the focused shell branch below. The mission MCP
    // route requires mission identifiers and incorrectly blocked ordinary
    // workspace terminals before the native confirmation dialog appeared.
    const mcpFirst = new Set<JarvisAction['type']>([
      'mcp_tool',
    ]);
    if (mcpFirst.has(action.type)) {
      const mcp = await executeViaMcp(action, sayText, control);
      if (mcp) return { ...mcp, expectReply };
    }
  }

  let toolResult: JarvisExecutionResult['toolResult'] =
    action.type === 'none' ? null : { tool: action.type, ok: true, summary: 'executado' };

  if (action.type === 'read_current_view') {
    try {
      // Vision keeps the PNG inside the main process. Jarvis receives only
      // bounded AX labels and local OCR, redacted before the Live tool result.
      const vision = await window.nexus.vision.context({
        includeScreenshot: true,
        includeOcr: true,
        allowCloudImage: false,
      });
      checkpoint(control);
      sayText = currentViewNarration(vision);
      toolResult = {
        tool: action.type,
        ok: true,
        summary: `visão atual lida localmente (AX ${vision.ax.status}; OCR ${vision.ocr.status})`,
        output: currentViewToolOutput(vision),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sayText = 'Não consegui ler esta tela agora.';
      toolResult = {
        tool: action.type,
        ok: false,
        summary: `leitura visual indisponível: ${message}`,
      };
    }
  } else if (action.type === 'read_pane') {
    const layout = useLayoutStore.getState();
    const panes = listPanes(layout.root);
    const requested = action.paneId?.trim() ?? '';
    const useFocused = !requested || /^(ativo|active|focused|focado)$/i.test(requested);
    const target = useFocused
      ? panes.find((pane) => pane.id === layout.focusedPaneId) ?? null
      : panes.find((pane) => pane.id === requested) ?? findPaneByVoiceName(panes, requested);
    if (!target) {
      return {
        sayText: 'Não encontrei esse pane para ler.',
        expectReply,
        toolResult: { tool: 'read_pane', ok: false, summary: 'pane não encontrado' },
      };
    }
    if (target.kind === 'browser') {
      const read = await executeViaMcp(
        {
          type: 'mcp_tool',
          tool: 'nexus_browser_read',
          args: { paneId: target.id, maxChars: 20_000, maxElements: 200 },
        },
        sayText,
        { signal: control.signal },
      );
      if (read) {
        return {
          ...read,
          expectReply,
          toolResult: read.toolResult
            ? { ...read.toolResult, tool: 'read_pane' }
            : null,
        };
      }
      return {
        sayText: 'Não consegui iniciar a leitura da página do navegador.',
        expectReply,
        toolResult: {
          tool: 'read_pane',
          ok: false,
          summary: 'leitura do navegador indisponível',
          output: { paneId: target.id, kind: target.kind },
        },
      };
    }
    const read = await executeViaMcp(
      {
        type: 'mcp_tool',
        tool: 'nexus_pane_read',
        args: { paneId: target.id, lines: 200 },
      },
      sayText,
      { signal: control.signal },
    );
    if (!read) {
      return {
        sayText: 'Não consegui iniciar a leitura do pane.',
        expectReply,
        toolResult: { tool: 'read_pane', ok: false, summary: 'leitura indisponível' },
      };
    }
    return {
      ...read,
      expectReply,
      toolResult: read.toolResult
        ? { ...read.toolResult, tool: 'read_pane' }
        : null,
    };
  } else if (action.type === 'open_squad_picker') {
    const workspace = useWorkspaceStore.getState().current;
    const squads = useOrchStore.getState().squads;
    if (!workspace) {
      sayText = 'Antes eu preciso de um projeto aberto. Quer abrir um dos recentes?';
      expectReply = true;
      toolResult = { tool: action.type, ok: false, summary: 'sem workspace aberto' };
    } else if (squads.length === 0) {
      sayText = 'Este projeto ainda não tem squads salvos. Quer criar um novo?';
      expectReply = true;
      toolResult = { tool: action.type, ok: false, summary: 'nenhum squad salvo' };
    } else {
      useMissionWizardStore.getState().openSquadPicker();
      markEffect(control);
      const confirmed = await confirmUiState(
        () => useMissionWizardStore.getState(),
        (wizard) => wizard.open && wizard.visibleStep === 'squad-select',
        control,
      );
      sayText = confirmed
        ? 'Abrindo seus squads salvos. Qual você quer usar?'
        : 'Tentei abrir a lista de squads, mas ainda não confirmei a tela.';
      toolResult = {
        tool: action.type,
        ok: confirmed,
        summary: confirmed
          ? 'seletor de squads salvos aberto e confirmado'
          : 'seletor de squads sem pós-condição confirmada',
      };
    }
  } else if (action.type === 'open_squad') {
    const wanted = action.squadName.toLowerCase();
    const squads = useOrchStore.getState().squads;
    const match =
      squads.find((s) => s.name.toLowerCase() === wanted) ??
      squads.find(
        (s) =>
          s.name.toLowerCase().includes(wanted) ||
          wanted.includes(s.name.toLowerCase()),
      );
    console.log(
      `[voice] ação open_squad "${action.squadName}" → ${match ? `match: ${match.name}` : 'SEM MATCH'}`,
    );
    if (match && !useWorkspaceStore.getState().current) {
      sayText =
        'Antes eu preciso de um projeto aberto. Quer que eu abra um dos recentes? Diga o nome.';
      expectReply = true;
      toolResult = { tool: action.type, ok: false, summary: 'sem workspace aberto' };
    } else if (match) {
      const adapters = await window.nexus.adapters.list();
      checkpoint(control);
      const res = await launchSquadMission(match, adapters);
      if (res.ok) {
        markEffect(control);
        useMissionWizardStore.getState().close();
        sayText = `Squad ${match.name} iniciado.`;
      }
      checkpoint(control);
      console.log(`[voice] launch squad "${match.name}" → ${res.ok ? 'NO AR' : `falhou: ${res.error}`}`);
      if (!res.ok) sayText = res.error ?? 'Não consegui subir o squad.';
      toolResult = {
        tool: action.type,
        ok: res.ok,
        summary: res.ok ? `squad ${match.name} iniciado` : (res.error ?? 'falhou'),
      };
    } else {
      sayText = `Não achei o squad "${action.squadName}". Os disponíveis são: ${context.squads.join(', ')}.`;
      toolResult = { tool: action.type, ok: false, summary: 'squad não encontrado' };
    }
  } else if (action.type === 'open_workspace') {
    const wanted = action.workspaceName.toLowerCase().trim();
    // STT/Live often says "abrir workspace" / "iniciar no workspace" without a
    // project name — treat as new_workspace wizard, not a failed open.
    if (
      !wanted ||
      /^(novo|nova|new|workspace-new|new-workspace|novo-workspace)$/i.test(wanted)
    ) {
      useMissionWizardStore.getState().openForNewWorkspace();
      sayText = sayText.trim() || 'Abrindo o assistente de novo workspace.';
      toolResult = { tool: 'new_workspace', ok: true, summary: 'wizard de workspace aberto' };
    } else {
      const ws = useWorkspaceStore.getState();
      const all = [...ws.recents];
      const resolution = resolveWorkspaceByVoiceName(action.workspaceName, all);
      if (resolution.kind === 'match') {
        const match = resolution.workspace;
        try {
          await ws.open(match.path);
          markEffect(control);
          const evidence = await waitForActionEvidence({
            read: () => useWorkspaceStore.getState().current?.path ?? null,
            accepts: (activePath) => activePath === match.path,
            timeoutMs: 3_000,
            signal: control.signal,
          });
          checkpoint(control);
          if (evidence.status === 'committed') {
            sayText = `Projeto ${match.name} aberto.`;
            toolResult = {
              tool: action.type,
              ok: true,
              summary: `workspace ${match.name} aberto e confirmado`,
              output: { activePath: match.path, evidenceMs: evidence.elapsedMs },
            };
          } else {
            sayText = `Tentei abrir ${match.name}, mas ainda não confirmei a troca.`;
            toolResult = {
              tool: action.type,
              ok: false,
              summary: `workspace ${match.name} sem pós-condição confirmada`,
            };
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          sayText = `Não consegui abrir ${match.name}.`;
          toolResult = { tool: action.type, ok: false, summary: message };
        }
      } else if (resolution.kind === 'ambiguous') {
        const names = resolution.candidates.slice(0, 4).map((item) => item.name).join(', ');
        sayText = `Encontrei mais de um workspace compatível: ${names}. Qual deles você quer abrir?`;
        expectReply = true;
        toolResult = { tool: action.type, ok: false, summary: 'workspace ambíguo' };
      } else {
        sayText = `Não achei o projeto "${action.workspaceName}" nos recentes. Diga outro nome ou peça para escolher uma pasta.`;
        expectReply = true;
        toolResult = { tool: action.type, ok: false, summary: 'workspace não encontrado' };
      }
    }
  } else if (action.type === 'design_squad') {
    const ws = useWorkspaceStore.getState().current;
    if (!ws) {
      sayText = 'Abre um projeto primeiro que eu monto o squad dele.';
      toolResult = { tool: action.type, ok: false, summary: 'sem workspace aberto' };
    } else {
      // Await design so Live gets a real tool result + confirmation prompt
      // (Overclock: open review → ask "Disparo?" before wizard-fire).
      try {
        const res = await window.nexus.orch.designSquad(ws.path);
        if (res.ok) markEffect(control);
        checkpoint(control);
        if (res.ok && res.squad) {
          useMissionWizardStore.getState().openForSquad(res.squad.id);
          sayText = `Squad ${res.squad.name} pronto na revisão. Quer que eu inicie de verdade?`;
          expectReply = true;
          toolResult = {
            tool: action.type,
            ok: true,
            summary: `squad ${res.squad.name} em revisão — aguardando confirmação`,
          };
        } else {
          if (isMissingModelKeyError(res.error)) useVoiceStore.getState().openSettings();
          sayText = `Não consegui montar o squad: ${res.error ?? 'erro'}.`;
          toolResult = {
            tool: action.type,
            ok: false,
            summary: res.error ?? 'design falhou',
          };
        }
      } catch (err) {
        sayText = `Não consegui montar o squad: ${err instanceof Error ? err.message : String(err)}.`;
        toolResult = { tool: action.type, ok: false, summary: 'design falhou' };
      }
    }
  } else if (action.type === 'confirm_squad') {
    const wizard = useMissionWizardStore.getState();
    if (!wizard.open || !wizard.presetSquadId) {
      sayText =
        'Não tem um squad na revisão agora. Diga "iniciar squad" pra eu montar um primeiro.';
      expectReply = true;
      toolResult = { tool: action.type, ok: false, summary: 'wizard de squad fechado' };
    } else {
      wizard.requestVoiceLaunch();
      sayText = 'Confirmado — iniciando o squad.';
      expectReply = false;
      toolResult = { tool: action.type, ok: true, summary: 'squad confirmado e iniciando' };
    }
  } else if (action.type === 'new_agentic_mission') {
    useMissionWizardStore.getState().openForAgentic(action.intent);
    sayText =
      sayText.trim() ||
      (action.intent
        ? 'Abrindo a missão no modo agêntico com o objetivo preenchido.'
        : 'Abrindo a missão no modo agêntico.');
    toolResult = {
      tool: action.type,
      ok: true,
      summary: action.intent
        ? 'wizard de missão aberto no modo agêntico com objetivo'
        : 'wizard de missão aberto no modo agêntico',
      ...(action.intent ? { output: { intent: action.intent } } : {}),
    };
  } else if (action.type === 'new_mission') {
    useMissionWizardStore.getState().openForMission();
    toolResult = { tool: action.type, ok: true, summary: 'wizard de missão aberto' };
  } else if (action.type === 'new_workspace') {
    useMissionWizardStore.getState().openForNewWorkspace();
    toolResult = { tool: action.type, ok: true, summary: 'wizard de workspace aberto' };
  } else if (action.type === 'open_terminal') {
    const workspace = useWorkspaceStore.getState().current;
    if (!workspace) {
      sayText = 'Abre um projeto primeiro; aí eu abro o terminal nele.';
      toolResult = { tool: action.type, ok: false, summary: 'sem workspace aberto' };
    } else {
      const layout = useLayoutStore.getState();
      const panes = listPanes(layout.root);
      const homeVisible = useHomeStore.getState().visible;
      const loneShell =
        panes.length === 1 && panes[0].kind === 'shell' && !panes[0].orchRequestId;
      const paneId =
        loneShell && homeVisible ? panes[0].id : layout.addShellPane();
      revealPaneForUser(paneId);
      markEffect(control);
      const sessionId = await waitForSession(paneId, 5_000);
      checkpoint(control);
      const visibility = assessTerminalVisibility(
        paneId,
        readUiVisibilityState(),
        Boolean(sessionId),
      );
      if (visibility.visible) {
        sayText = 'Terminal aberto.';
        toolResult = { tool: action.type, ok: true, summary: 'terminal aberto e visível' };
      } else if (sessionId) {
        const blocked = visibility.reasons.join(', ');
        sayText = `Criei o terminal, mas ainda não está visível (${blocked}).`;
        toolResult = { tool: action.type, ok: false, summary: `terminal oculto: ${blocked}` };
      } else {
        sayText = 'Abri o painel, mas o terminal ainda não iniciou.';
        toolResult = { tool: action.type, ok: false, summary: 'terminal sem sessão' };
      }
    }
  } else if (action.type === 'close_pane') {
    const layout = useLayoutStore.getState();
    const target = layout.focusedPaneId;
    if (target) {
      const title = listPanes(layout.root).find((p) => p.id === target)?.title ?? 'pane';
      const closed = await requestPaneClose(target);
      toolResult = {
        tool: action.type,
        ok: closed,
        summary: closed ? `${title} fechado` : `fechamento de ${title} cancelado`,
      };
    } else {
      sayText = 'Nenhum pane focado para eu fechar.';
      toolResult = { tool: action.type, ok: false, summary: 'sem pane focado' };
    }
  } else if (action.type === 'open_board') {
    const orch = useOrchStore.getState();
    if (!orch.boardOpen) orch.toggleBoard();
    const confirmed = await confirmUiState(
      () => useOrchStore.getState().boardOpen,
      Boolean,
      control,
    );
    sayText = confirmed ? 'Quadro aberto.' : 'Tentei abrir o quadro, mas não confirmei a tela.';
    toolResult = {
      tool: action.type,
      ok: confirmed,
      summary: confirmed ? 'quadro aberto e confirmado' : 'quadro sem pós-condição',
    };
  } else if (action.type === 'open_settings') {
    const settings = useSettingsStore.getState();
    if (!settings.drawerOpen) settings.toggleDrawer();
    const confirmed = await confirmUiState(
      () => useSettingsStore.getState().drawerOpen,
      Boolean,
      control,
    );
    sayText = confirmed ? 'Configurações abertas.' : 'Tentei abrir as configurações, mas não confirmei a tela.';
    toolResult = {
      tool: action.type,
      ok: confirmed,
      summary: confirmed ? 'configurações abertas e confirmadas' : 'configurações sem pós-condição',
    };
  } else if (action.type === 'open_voice_settings') {
    useVoiceStore.getState().openSettings();
    const confirmed = await confirmUiState(
      () => useVoiceStore.getState().settingsOpen,
      Boolean,
      control,
    );
    sayText = confirmed ? 'Configurações de voz abertas.' : 'Tentei abrir os ajustes de voz, mas não confirmei a tela.';
    toolResult = {
      tool: action.type,
      ok: confirmed,
      summary: confirmed ? 'configurações de voz abertas e confirmadas' : 'voz sem pós-condição',
    };
  } else if (action.type === 'open_canvas') {
    const layout = useLayoutStore.getState();
    if (layout.viewKind !== 'canvas') layout.toggleView();
    useHomeStore.getState().hide();
    const confirmed = await confirmUiState(
      () => useLayoutStore.getState().viewKind,
      (kind) => kind === 'canvas',
      control,
    );
    sayText = confirmed ? 'Canvas aberto.' : 'Tentei abrir o canvas, mas não confirmei a tela.';
    toolResult = { tool: action.type, ok: confirmed, summary: confirmed ? 'modo canvas confirmado' : 'canvas sem pós-condição' };
  } else if (action.type === 'open_grid') {
    const layout = useLayoutStore.getState();
    if (layout.viewKind !== 'grid') layout.toggleView();
    useHomeStore.getState().hide();
    const confirmed = await confirmUiState(
      () => useLayoutStore.getState().viewKind,
      (kind) => kind === 'grid',
      control,
    );
    sayText = confirmed ? 'Grade aberta.' : 'Tentei abrir a grade, mas não confirmei a tela.';
    toolResult = { tool: action.type, ok: confirmed, summary: confirmed ? 'modo grade confirmado' : 'grade sem pós-condição' };
  } else if (action.type === 'open_browser') {
    useGamificationStore.getState().closeProfile();
    const paneId = useLayoutStore.getState().addBrowserPane(action.url);
    useHomeStore.getState().hide();
    markEffect(control);
    try {
      await waitForBrowserPaneCreated(paneId, 3_000);
      markEffect(control);
      checkpoint(control);
      sayText = action.url ? 'Site aberto.' : 'Browser aberto.';
      toolResult = {
        tool: action.type,
        ok: true,
        summary: action.url ? `browser aberto em ${action.url}` : 'browser aberto',
      };
    } catch (err) {
      sayText = 'Criei o pane do browser, mas ele ainda não respondeu.';
      toolResult = {
        tool: action.type,
        ok: false,
        summary: err instanceof Error ? err.message : String(err),
      };
    }
  } else if (action.type === 'browser_back') {
    const result = await navigateBrowserPane('back', control);
    sayText = result.ok ? 'Voltei no browser.' : 'Nenhum browser aberto para voltar.';
    toolResult = { tool: action.type, ok: result.ok, summary: result.summary };
  } else if (action.type === 'browser_forward') {
    const result = await navigateBrowserPane('forward', control);
    sayText = result.ok ? 'Avancei no browser.' : 'Nenhum browser aberto para avançar.';
    toolResult = { tool: action.type, ok: result.ok, summary: result.summary };
  } else if (action.type === 'browser_reload') {
    const result = await navigateBrowserPane('reload', control);
    sayText = result.ok ? 'Página recarregada.' : 'Nenhum browser aberto para recarregar.';
    toolResult = { tool: action.type, ok: result.ok, summary: result.summary };
  } else if (action.type === 'focus_next_pane') {
    const layout = useLayoutStore.getState();
    const panes = listPanes(layout.root);
    if (panes.length <= 1) {
      sayText = 'Só tem um pane aberto.';
      toolResult = { tool: action.type, ok: false, summary: 'apenas um pane aberto' };
    } else {
      const index = panes.findIndex((pane) => pane.id === layout.focusedPaneId);
      const next = panes[(index + 1 + panes.length) % panes.length];
      layout.focus(next.id);
      const confirmed = await confirmUiState(
        () => useLayoutStore.getState().focusedPaneId,
        (id) => id === next.id,
        control,
      );
      sayText = confirmed ? 'Próximo pane focado.' : 'Tentei trocar o foco, mas não confirmei.';
      toolResult = { tool: action.type, ok: confirmed, summary: confirmed ? `${next.title} focado` : 'foco sem pós-condição' };
    }
  } else if (action.type === 'focus_previous_pane') {
    const layout = useLayoutStore.getState();
    const panes = listPanes(layout.root);
    if (panes.length <= 1) {
      sayText = 'Só tem um pane aberto.';
      toolResult = { tool: action.type, ok: false, summary: 'apenas um pane aberto' };
    } else {
      const index = panes.findIndex((pane) => pane.id === layout.focusedPaneId);
      const prev = index < 0 ? panes[0] : panes[(index - 1 + panes.length) % panes.length];
      layout.focus(prev.id);
      const confirmed = await confirmUiState(
        () => useLayoutStore.getState().focusedPaneId,
        (id) => id === prev.id,
        control,
      );
      sayText = confirmed ? 'Pane anterior focado.' : 'Tentei trocar o foco, mas não confirmei.';
      toolResult = { tool: action.type, ok: confirmed, summary: confirmed ? `${prev.title} focado` : 'foco sem pós-condição' };
    }
  } else if (action.type === 'focus_pane') {
    const layout = useLayoutStore.getState();
    const panes = listPanes(layout.root);
    const target = findPaneByVoiceName(panes, action.paneName);
    if (!target) {
      sayText = `Não achei um pane chamado ${action.paneName}.`;
      toolResult = { tool: action.type, ok: false, summary: 'pane não encontrado' };
    } else {
      layout.focus(target.id);
      const confirmed = await confirmUiState(
        () => useLayoutStore.getState().focusedPaneId,
        (id) => id === target.id,
        control,
      );
      sayText = confirmed ? `${target.title} focado.` : 'Tentei focar esse pane, mas não confirmei.';
      toolResult = { tool: action.type, ok: confirmed, summary: confirmed ? `${target.title} focado` : 'foco sem pós-condição' };
    }
  } else if (action.type === 'send_to_pane') {
    const { root, focusedPaneId } = useLayoutStore.getState();
    // NEW-B + C3 (follow-ups 2/4b): resposta roteada de pergunta pendente
    // (paneId presente) escreve de volta SÓ em pane de agente/orquestrador
    // vivo; pane sumido/inválido AVISA e re-pergunta — nunca vira comando em
    // shell. Delegação rotineira segue direto; só destrutivo/deploy confirma.
    const target = resolveSendToPaneTarget(action.paneId, listPanes(root), focusedPaneId);
    if (target.kind === 'asking-pane') {
      const commandId = crypto.randomUUID();
      logVoiceEvent('info', 'pane.deliveryResolved', 'destino de pane resolvido', {
        commandId,
        paneId: target.paneId,
        chars: action.text.length,
      });
      const sessionId = await waitForSession(target.paneId, 750);
      checkpoint(control);
      const ok = Boolean(sessionId) && writeToPane(target.paneId, `${action.text}\n`);
      logVoiceEvent(ok ? 'info' : 'warn', ok ? 'pane.deliverySubmitted' : 'pane.deliveryFailed', ok ? 'texto submetido ao PTY' : 'sessão do pane indisponível', {
        commandId,
        paneId: target.paneId,
        sessionReady: Boolean(sessionId),
      });
      if (!ok) sayText = 'Não consegui escrever no pane.';
      toolResult = {
        tool: action.type,
        ok,
        summary: ok ? `resposta submetida ao pane (${commandId})` : 'falha ao escrever no pane',
        output: { commandId, paneId: target.paneId, sessionReady: Boolean(sessionId) },
      };
    } else if (target.kind === 'asking-pane-gone') {
      sayText =
        'O pane que tinha perguntado já fechou. Se ainda precisar, me diz de novo o que fazer.';
      expectReply = true;
      toolResult = {
        tool: action.type,
        ok: false,
        summary: 'pane da pergunta fechado — resposta não roteada',
      };
    } else if (target.kind === 'asking-pane-not-agent') {
      sayText = 'Esse pane não é de agente — não escrevo comando nele.';
      toolResult = {
        tool: action.type,
        ok: false,
        summary: `alvo não é pane de agente: ${target.title}`,
      };
    } else if (target.kind === 'asking-pane-ambiguous') {
      sayText = `Encontrei mais de um pane compatível: ${target.titles.join(', ')}. Qual deles?`;
      expectReply = true;
      toolResult = {
        tool: action.type,
        ok: false,
        summary: 'nome de pane ambíguo — envio bloqueado',
      };
    } else if (target.kind === 'no-agent-pane') {
      // send_to_pane is natural-language delegation only. Never reinterpret it
      // as shell input: that produced a misleading native command dialog for
      // ordinary mission objectives. Explicit shell requests still use the
      // dedicated run_command branch and retain its confirmation guardrail.
      sayText =
        'Não achei um pane de agente pra receber a missão — abre o orquestrador primeiro.';
      toolResult = {
        tool: action.type,
        ok: false,
        summary: 'sem pane de agente válido (delegação não virou comando de shell)',
      };
    } else {
      const missionPrompt = prepareDelegationPrompt(action.text);
      const commandId = crypto.randomUUID();
      const sessionId = await waitForSession(target.orchestratorPaneId, 750);
      checkpoint(control);
      const ok = Boolean(sessionId) &&
        writeToPane(target.orchestratorPaneId, `${missionPrompt}\n`);
      if (ok) markEffect(control);
      logVoiceEvent(
        ok ? 'info' : 'warn',
        ok ? 'pane.delegationSubmitted' : 'pane.delegationFailed',
        ok ? 'missão submetida ao orquestrador' : 'sessão do orquestrador indisponível',
        {
          commandId,
          paneId: target.orchestratorPaneId,
          sessionReady: Boolean(sessionId),
          sourceChars: action.text.length,
          promptChars: missionPrompt.length,
        },
      );
      sayText = ok
        ? 'Missão enviada ao squad.'
        : 'Não consegui enviar a missão ao orquestrador.';
      toolResult = {
        tool: action.type,
        ok,
        summary: ok
          ? `missão submetida ao pane (${commandId})`
          : 'falha ao escrever no orquestrador',
        output: {
          commandId,
          paneId: target.orchestratorPaneId,
          sessionReady: Boolean(sessionId),
        },
      };
    }
  } else if (action.type === 'run_command') {
    const { focusedPaneId: fp, root: rc } = useLayoutStore.getState();
    const panesNow = listPanes(rc);
    const focused = fp ? panesNow.find((p) => p.id === fp) : undefined;
    const shellPane = focused?.kind === 'shell' ? focused : panesNow.find((p) => p.kind === 'shell');
    const targetPaneId = shellPane?.id ?? useLayoutStore.getState().addShellPane();
    if (!shellPane) {
      useHomeStore.getState().hide();
      markEffect(control);
    }
    const sessionId = await waitForSession(targetPaneId, 5_000);
    checkpoint(control);
    if (!sessionId) {
      sayText = 'Não consegui iniciar um terminal para rodar o comando.';
      toolResult = { tool: action.type, ok: false, summary: 'terminal sem sessão' };
    } else {
      // Gemini occasionally converts the Portuguese literal command “ai” to
      // the English pronoun “I”. For this exact one-token ambiguity preserve
      // the user's intended lowercase CLI command. Other commands stay exact.
      const terminalCommand = action.command.trim() === 'I' ? 'ai' : action.command;
      // Native dialog is sufficient feedback. A parallel local TTS here raced
      // Gemini Live narration and produced two overlapping Jarvis voices.
      const approved = await window.nexus.voice.confirmCommand(terminalCommand);
      checkpoint(control);
      if (approved) {
        checkpoint(control);
        const ok = writeToPane(targetPaneId, `${terminalCommand}\n`);
        if (ok) markEffect(control);
        if (!ok) sayText = 'Não consegui escrever no terminal.';
        toolResult = {
          tool: action.type,
          ok,
          summary: ok ? 'comando confirmado e executado' : 'falha ao escrever no terminal',
        };
      } else {
        sayText = 'Cancelei, não rodei o comando.';
        toolResult = { tool: action.type, ok: false, summary: 'usuário recusou' };
      }
    }
  } else if (action.type === 'mcp_tool') {
    const mcp = await executeViaMcp(action, sayText, control);
    if (mcp) return { ...mcp, expectReply };
  } else if (action.type === 'restore_mission_panes') {
    const orch = useOrchStore.getState();
    const missions = orch.missions ?? [];
    if (missions.length === 0) {
      sayText = 'Não tem nenhuma missão salva para restaurar.';
      toolResult = { tool: action.type, ok: false, summary: 'sem missões' };
    } else {
      const alvo = action.alvo?.toLowerCase();
      const target = alvo
        ? missions.find((m) => m.title?.toLowerCase().includes(alvo)) ?? missions[0]
        : missions[0];
      const result = await reopenMission(target);
      if (result.ok) markEffect(control);
      checkpoint(control);
      if (result.ok) {
        sayText = `Missão restaurada com ${result.panes ?? 0} panes.`;
        toolResult = { tool: action.type, ok: true, summary: `missão restaurada (${result.panes} panes)` };
      } else {
        sayText = result.error ?? 'Não consegui restaurar a missão.';
        toolResult = { tool: action.type, ok: false, summary: result.error ?? 'falhou' };
      }
    }
  } else if (action.type === 'ask_pane') {
    // C3: pergunta autorada por LLM só pode ir pra pane de agente/orquestrador
    // — mesmo guard do send_to_pane. O fallback silencioso pro focusedPaneId
    // (que podia ser um shell) morre aqui: nunca escrever texto do LLM fora
    // de um pane de agente/orquestrador.
    const { root } = useLayoutStore.getState();
    const target = resolveSendToPaneTarget(action.paneId, listPanes(root));
    if (target.kind === 'asking-pane') {
      const result = await executeViaMcp(
        {
          type: 'mcp_tool',
          tool: 'nexus_pane_write',
          args: { paneId: target.paneId, text: action.pergunta, submit: true },
        },
        sayText,
        control,
      );
      if (result) {
        return {
          ...result,
          expectReply,
          toolResult: result.toolResult
            ? { ...result.toolResult, tool: 'ask_pane' }
            : null,
        };
      }
    } else if (target.kind === 'delegation') {
      const result = await executeViaMcp(
        {
          type: 'mcp_tool',
          tool: 'nexus_pane_write',
          args: {
            paneId: target.orchestratorPaneId,
            text: action.pergunta,
            submit: true,
          },
        },
        sayText,
        control,
      );
      if (result) {
        return {
          ...result,
          expectReply,
          toolResult: result.toolResult
            ? { ...result.toolResult, tool: 'ask_pane' }
            : null,
        };
      }
    } else if (target.kind === 'asking-pane-gone') {
      sayText = 'Esse pane já fechou — não tenho pra quem perguntar.';
      toolResult = { tool: action.type, ok: false, summary: 'pane da pergunta fechado' };
    } else if (target.kind === 'asking-pane-not-agent') {
      sayText = 'Esse pane não é de agente — não escrevo pergunta nele.';
      toolResult = {
        tool: action.type,
        ok: false,
        summary: `alvo não é pane de agente: ${target.title}`,
      };
    } else {
      sayText = 'Não achei um pane de agente pra perguntar.';
      toolResult = { tool: action.type, ok: false, summary: 'sem pane de agente válido' };
    }
  }

  return { sayText, expectReply, toolResult };
}
