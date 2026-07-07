import type { JarvisAction, JarvisContext, JarvisReply } from '../../shared/voice-ipc';
import { useLayoutStore } from '../state/layout-store';
import { listPanes } from '../lib/split-tree';
import { useWorkspaceStore } from '../state/workspace-store';
import { useOrchStore } from '../state/orch-store';
import { useMissionWizardStore } from '../state/mission-wizard-store';
import { useHomeStore } from '../state/home-store';
import { useGamificationStore } from '../state/gamification-store';
import { useVoiceStore } from './voice-store';
import { waitForSession, writeToPane } from '../terminal/terminal-host';
import { launchSquadMission } from '../orch/mission-launcher';
import { isMissingModelKeyError } from '../lib/credential-errors';
import { playAudioBase64 } from './voice-playback';
import { invokeMcpWithConfirm, mapActionToTool } from '../services/mcp-bridge';

export interface JarvisExecutionResult {
  sayText: string;
  expectReply?: boolean;
  toolResult: { tool: JarvisAction['type']; ok: boolean; summary: string } | null;
}

function findOrchestratorPane(
  root: ReturnType<typeof useLayoutStore.getState>['root'],
): string | null {
  const panes = listPanes(root);
  const pane = panes.find(
    (p) => p.orchRequestId?.startsWith('squad-') || /(^|[ ·])orq\b/i.test(p.title),
  );
  return pane?.id ?? null;
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

async function executeViaMcp(
  action: JarvisAction,
  sayText: string,
): Promise<JarvisExecutionResult | null> {
  const ctx = paneContext();
  const mapping = mapActionToTool(action, ctx);
  if (!mapping) return null;

  if (action.type === 'run_command') {
    void window.nexus.voice
      .speak({ text: 'Confirma na tela se pedir permissão.', speakMode: 'full', echoRecord: false })
      .then((r) => {
        if (r.ok && r.mode === 'audio') void playAudioBase64(r.audioBase64, r.format).catch(() => {});
      })
      .catch(() => {});
  }

  const result = await invokeMcpWithConfirm(mapping.tool, mapping.args);
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
): Promise<JarvisExecutionResult> {
  let sayText = reply.say;
  let expectReply = reply.expectReply;
  const action = reply.action;

  if (action.type !== 'none') {
    const mcpFirst = new Set<JarvisAction['type']>([
      'mcp_tool',
      'close_pane',
      'send_to_pane',
      'run_command',
    ]);
    if (mcpFirst.has(action.type)) {
      const mcp = await executeViaMcp(action, sayText);
      if (mcp) return { ...mcp, expectReply };
    }
  }

  let toolResult: JarvisExecutionResult['toolResult'] =
    action.type === 'none' ? null : { tool: action.type, ok: true, summary: 'executado' };

  if (action.type === 'open_squad') {
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
      const res = launchSquadMission(match, adapters);
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
    const wanted = action.workspaceName.toLowerCase();
    const ws = useWorkspaceStore.getState();
    const all = [...ws.recents];
    const match =
      all.find((r) => r.name.toLowerCase() === wanted) ??
      all.find(
        (r) =>
          r.name.toLowerCase().includes(wanted) ||
          wanted.includes(r.name.toLowerCase()),
      );
    if (match) {
      void ws.open(match.path);
      toolResult = { tool: action.type, ok: true, summary: `workspace ${match.name} aberto` };
    } else {
      sayText = `Não achei o projeto "${action.workspaceName}" nos recentes.`;
      toolResult = { tool: action.type, ok: false, summary: 'workspace não encontrado' };
    }
  } else if (action.type === 'design_squad') {
    const ws = useWorkspaceStore.getState().current;
    if (!ws) {
      sayText = 'Abre um projeto primeiro que eu monto o squad dele.';
      toolResult = { tool: action.type, ok: false, summary: 'sem workspace aberto' };
    } else {
      void window.nexus.orch.designSquad(ws.path).then((res) => {
        if (res.ok && res.squad) {
          useMissionWizardStore.getState().openForSquad(res.squad.id);
          void window.nexus.voice.speak({
            text: `Squad ${res.squad.name} pronto — revise e inicie.`,
            speakMode: 'full',
          });
        } else {
          if (isMissingModelKeyError(res.error)) useVoiceStore.getState().openSettings();
          void window.nexus.voice.speak({
            text: `Não consegui montar o squad: ${res.error ?? 'erro'}.`,
            speakMode: 'full',
          });
        }
      });
      sayText = 'Deixa comigo — analisando o projeto para montar o time.';
      toolResult = { tool: action.type, ok: true, summary: 'design de squad iniciado' };
    }
  } else if (action.type === 'new_mission') {
    useMissionWizardStore.getState().openForMission();
    toolResult = { tool: action.type, ok: true, summary: 'wizard de missão aberto' };
  } else if (action.type === 'new_workspace') {
    useMissionWizardStore.getState().openForNewWorkspace();
    toolResult = { tool: action.type, ok: true, summary: 'wizard de workspace aberto' };
  } else if (action.type === 'open_terminal') {
    useGamificationStore.getState().closeProfile();
    const paneId = useLayoutStore.getState().addShellPane();
    useHomeStore.getState().hide();
    const sessionId = await waitForSession(paneId, 5_000);
    const ok = Boolean(sessionId);
    sayText = ok ? 'Terminal aberto.' : 'Abri o painel, mas o terminal ainda não iniciou.';
    toolResult = { tool: action.type, ok, summary: ok ? 'terminal aberto' : 'terminal sem sessão' };
  } else if (action.type === 'close_pane') {
    const layout = useLayoutStore.getState();
    const target = layout.focusedPaneId;
    if (target) {
      const title = listPanes(layout.root).find((p) => p.id === target)?.title ?? 'pane';
      layout.close(target);
      toolResult = { tool: action.type, ok: true, summary: `${title} fechado` };
    } else {
      sayText = 'Nenhum pane focado para eu fechar.';
      toolResult = { tool: action.type, ok: false, summary: 'sem pane focado' };
    }
  } else if (action.type === 'open_board') {
    const orch = useOrchStore.getState();
    if (!orch.boardOpen) orch.toggleBoard();
    toolResult = { tool: action.type, ok: true, summary: 'quadro aberto' };
  } else if (action.type === 'send_to_pane') {
    const { root, focusedPaneId } = useLayoutStore.getState();
    const target = findOrchestratorPane(root) ?? focusedPaneId;
    const ok = target ? writeToPane(target, `${action.text}\n`) : false;
    if (!ok) sayText = 'Não tem nenhum pane para eu mandar a tarefa.';
    toolResult = {
      tool: action.type,
      ok,
      summary: ok ? 'tarefa enviada ao pane' : 'nenhum pane disponível',
    };
  } else if (action.type === 'run_command') {
    const { focusedPaneId: fp, root: rc } = useLayoutStore.getState();
    const panesNow = listPanes(rc);
    const focused = fp ? panesNow.find((p) => p.id === fp) : undefined;
    const shellPane = focused?.kind === 'shell' ? focused : panesNow.find((p) => p.kind === 'shell');
    const targetPaneId = shellPane?.id ?? useLayoutStore.getState().addShellPane();
    if (!shellPane) useHomeStore.getState().hide();
    const sessionId = await waitForSession(targetPaneId, 5_000);
    if (!sessionId) {
      sayText = 'Não consegui iniciar um terminal para rodar o comando.';
      toolResult = { tool: action.type, ok: false, summary: 'terminal sem sessão' };
    } else {
      void window.nexus.voice
        .speak({ text: 'Confirma na tela para eu executar.', speakMode: 'full', echoRecord: false })
        .then((r) => {
          if (r.ok && r.mode === 'audio') void playAudioBase64(r.audioBase64, r.format).catch(() => {});
        })
        .catch(() => {});
      const approved = await window.nexus.voice.confirmCommand(action.command);
      if (approved) {
        const ok = writeToPane(targetPaneId, `${action.command}\n`);
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
    const mcp = await executeViaMcp(action, sayText);
    if (mcp) return { ...mcp, expectReply };
  }

  return { sayText, expectReply, toolResult };
}
