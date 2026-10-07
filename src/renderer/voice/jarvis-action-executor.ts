import { allowPaneCreation, reportLicenseDenial } from '../state/access-guard';
import type { JarvisAction, JarvisContext, JarvisReply } from '../../shared/voice-ipc';
import { isMissionRuntimeSquadId, type SquadAgent } from '../../shared/orch-types';
import { PET_STUDIO_SQUAD_ID } from '../../shared/pet-studio';
import { useLayoutStore } from '../state/layout-store';
import { listPanes } from '../lib/split-tree';
import { pickFallbackInScope } from '../lib/pane-spaces';
import { attentionMissionIdForPane } from '../lib/mission-attention-route';
import { useWorkspaceStore } from '../state/workspace-store';
import { useOrchStore } from '../state/orch-store';
import { useProductNavigationStore } from '../state/product-navigation-store';
import {
  useMissionSetupStore,
  type MissionSetupStep,
} from '../state/mission-setup-store';
import { useVoiceStore } from './voice-store';
import {
  submitPromptToPane,
  submitPromptToPaneConfirmed,
  waitForSession,
  writeToPane,
} from '../terminal/terminal-host';
import { useSessionStateStore } from '../state/session-state-store';
import { waitForBrowserPaneCreated } from '../browser/browser-host';
import { isMissingModelKeyError } from '../lib/credential-errors';
import { invokeMcpWithConfirm, mapActionToTool } from '../services/mcp-bridge';
import {
  isOrchestratorPane,
  resolveSendToPaneTarget,
  resolveSyncRepoViaPaneTarget,
} from './send-to-pane-target';
import { parsePaneNumberRef } from '../../shared/pane-number';
import { requestPaneClose } from '../terminal/pane-close-guard';
import { sanitizeMcpResultOutput } from './mcp-result-output';
import { currentViewNarration, currentViewToolOutput } from './current-view-read';
import { waitForActionEvidence } from './action-evidence';
import { resolveWorkspaceByVoiceName } from './workspace-name-resolver';
import { resolveSquadByVoiceName } from './squad-name-resolver';
import { decideRestoreMission, requestMissionPick, spokenTitle } from './restore-mission-target';
import { logVoiceEvent } from './voice-live-ipc';
import {
  isExecutionReadyDelegationPrompt,
  prepareDelegationPrompt,
} from './delegation-prompt';
import {
  buildSyncRepoViaPanePrompt,
  isSyncRepoPaneFree,
  normalizeSyncRepoViaPaneMode,
  syncRepoViaPaneBusySay,
  syncRepoViaPaneDeliveryFailedSay,
  syncRepoViaPaneNoAgentSay,
  syncRepoViaPaneSay,
} from '../../shared/sync-repo-via-pane';

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

interface MissionSetupPrefill {
  objective?: string;
  roster?: readonly SquadAgent[];
  step?: MissionSetupStep;
}

function openCanonicalMissionSetup(
  prefill: MissionSetupPrefill = {},
): boolean {
  const workspace = useWorkspaceStore.getState().current;
  if (!workspace) return false;
  useMissionSetupStore.getState().clearEntryContext();

  useMissionSetupStore.getState().setWorkspace(workspace.path);
  let setup = useMissionSetupStore.getState();
  if (prefill.objective !== undefined) {
    setup.setObjective(prefill.objective);
  }
  if (prefill.roster !== undefined) {
    if (!useMissionSetupStore.getState().setRoster(prefill.roster)) return false;
  }
  setup = useMissionSetupStore.getState();
  const step =
    prefill.step ??
    (setup.draft.objective.trim()
      ? setup.draft.roster.length > 0
        ? 'review'
        : 'team'
      : 'mission');
  setup.setStep(step);
  useProductNavigationStore.getState().openMissionSetup();
  return true;
}

function findOrchestratorPane(
  root: ReturnType<typeof useLayoutStore.getState>['root'],
): string | null {
  const panes = listPanes(root);
  const matches = panes.filter(isOrchestratorPane);
  if (matches.length === 0) return null;
  // Orquestrador do MESMO escopo do foco. Sem fallback para `matches[0]`:
  // quando a missão A não tem orquestrador, cair no da B é o vazamento A→B.
  return pickFallbackInScope(
    matches.map((p) => p.id),
    useLayoutStore.getState().focusedPaneId,
    panes,
    useOrchStore.getState().paneMissions,
  );
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

function repositorySyncNarration(result: {
  ok: boolean;
  result?: unknown;
  error?: string;
}): string | null {
  if (!result.ok) return null;
  const value = result.result;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const sync = value as Record<string, unknown>;
  const status = sync.status;
  const branch = typeof sync.branch === 'string' ? sync.branch : 'a branch atual';
  if (status === 'updated') return `Repositório atualizado em ${branch}.`;
  if (status === 'up_to_date') return `O repositório já está atualizado em ${branch}.`;
  if (status === 'blocked' && typeof sync.reason === 'string') {
    return `Não alterei nada: ${sync.reason}`;
  }
  return null;
}

/**
 * Voice-owned soft UI may close before pane navigation. Product navigation,
 * not legacy drawers or home/wizard booleans, makes the terminal surface
 * visible. Hard confirmations remain untouched.
 */
function dismissBlockingOverlays(): void {
  useVoiceStore.getState().closeSettings();
}

/** Garante que o pane fique visível sem descartar seu contexto de missão. */
function revealPaneForUser(paneId: string): void {
  dismissBlockingOverlays();
  const layout = useLayoutStore.getState();
  const pane = listPanes(layout.root).find(
    (candidate) => candidate.id === paneId,
  );
  const navigation = useProductNavigationStore.getState();
  const missionId = pane ? attentionMissionIdForPane(pane) : undefined;
  if (missionId) {
    navigation.openMission(missionId);
    useProductNavigationStore.getState().showMissionTerminals();
  } else {
    navigation.openTerminal();
  }
  layout.focus(paneId);
}

async function openSingleAgentPaneForSync(): Promise<{
  paneId: string;
  paneTitle: string;
} | null> {
  const before = listPanes(useLayoutStore.getState().root);
  const beforeIds = new Set(before.map((pane) => pane.id));
  const adapters = await window.nexus.adapters.list().catch(() => []);
  const adapter = adapters.find((candidate) => candidate.installed);
  if (!adapter) return null;
  useLayoutStore
    .getState()
    .spawnAgent(adapter.id, adapter.models.default || '');
  const afterState = useLayoutStore.getState();
  const after = listPanes(afterState.root);
  const spawned =
    after.find((pane) => pane.kind === 'cli-agent' && !beforeIds.has(pane.id)) ??
    after.find(
      (pane) =>
        pane.kind === 'cli-agent' && pane.id === afterState.focusedPaneId,
    );
  if (!spawned) return null;
  return { paneId: spawned.id, paneTitle: spawned.title };
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

const SHELL_COMMAND_RE = /^(?:\.\/|\/|[A-Za-z0-9_.-]+=|[A-Za-z0-9_.-]+(?:\s|$))/;
const KNOWN_SHELL_COMMANDS = new Set([
  'agy', 'awk', 'cat', 'cd', 'chmod', 'chown', 'claude', 'clear', 'codex',
  'cp', 'curl', 'docker', 'echo', 'electron-forge', 'find', 'gh',
  'git', 'grep', 'head', 'kill', 'kimi', 'ls', 'make', 'mkdir', 'mv', 'node',
  'npm', 'npx', 'pnpm', 'pwd', 'python', 'python3', 'rg', 'rm', 'sed', 'tail',
  'touch', 'tsx', 'yarn',
]);

function stripEnvAssignments(command: string): string {
  return command
    .trim()
    .replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+)+/, '');
}

function looksLikeShellCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed || trimmed.length > 4_096) return false;
  const firstToken = stripEnvAssignments(trimmed).split(/\s+/, 1)[0] ?? '';
  if (!firstToken) return false;
  if (!SHELL_COMMAND_RE.test(trimmed) || /[À-ÿ]/.test(firstToken)) return false;
  if (/[;&|<>`$(){}[\]*?~]/.test(trimmed)) return true;
  if (firstToken.includes('/') || firstToken.includes('.')) return true;
  return KNOWN_SHELL_COMMANDS.has(firstToken);
}

/**
 * Recusa NOMEADA quando o operador ditou um número que não resolve: diz qual
 * número foi pedido e quais existem. Nunca redireciona para o pane focado —
 * mandar trabalho para o terminal errado é pior que recusar.
 *
 * Devolve `null` quando o alvo não veio de um número, para a frase original da
 * recusa continuar valendo.
 */
function paneNumberRefusal(target: {
  requestedNumber?: number;
  validNumbers?: readonly number[];
}): string | null {
  if (target.requestedNumber === undefined) return null;
  const valid = target.validNumbers ?? [];
  return valid.length === 0
    ? `Não tem pane ${target.requestedNumber} aberto — não há nenhum pane numerado agora.`
    : `Não tem pane ${target.requestedNumber} aberto. Os panes abertos são: ${valid.join(', ')}.`;
}

function findPaneByVoiceName(
  panes: ReturnType<typeof listPanes>,
  paneName: string,
): ReturnType<typeof listPanes>[number] | null {
  // Identidade primeiro, NÚMERO depois, título por último.
  //
  // O id cru pode sair só com dígitos (`randomUUID().slice(0,8)`), então ele é
  // testado antes de qualquer leitura numérica. Em seguida o número — o
  // endereço que o operador consegue ditar — porque um "7" solto casaria por
  // substring com qualquer título que contenha 7 ("claude-7"). Número que não
  // resolve para EXATAMENTE um pane devolve null: recusar é melhor que mandar
  // trabalho para o terminal errado.
  const byId = panes.find((pane) => pane.id === paneName.trim());
  if (byId) return byId;
  const wantedNumber = parsePaneNumberRef(paneName);
  if (wantedNumber !== null) {
    const numbered = panes.filter((pane) => pane.paneNumber === wantedNumber);
    return numbered.length === 1 ? (numbered[0] ?? null) : null;
  }
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
  revealPaneForUser(pane.id);
  markEffect(control);
  try {
    checkpoint(control);
    await window.nexus.browser[nav](pane.id);
    markEffect(control);
    checkpoint(control);
    return { ok: true, summary: `browser ${nav} em ${pane.title}` };
  } catch {
    return {
      ok: false,
      summary: 'navegação do browser indisponível',
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
      ? ((repositorySyncNarration(result) ?? sayText) || 'Feito.')
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
 * com fallback de UI para o setup canônico, workspaces e panes.
 */
export async function executeJarvisAction(
  reply: JarvisReply,
  context: JarvisContext,
  control: JarvisExecutionControl = {},
): Promise<JarvisExecutionResult> {
  checkpoint(control);
  if (reply.action.type !== 'none' && !allowPaneCreation()) {
    return { sayText: 'Abra Minha conta para atualizar seu acesso ao NexusIDE.', expectReply: false, toolResult: { tool: reply.action.type, ok: false, summary: 'license_access_denied' } };
  }
  let sayText = reply.say;
  let expectReply = reply.expectReply;
  // Legacy Live/classic action: rewrite to pane CLI path (avoids nexus_git_sync
  // failing on executable local git config like core.fsmonitor).
  let action: JarvisAction =
    reply.action.type === 'sync_repository'
      ? { type: 'sync_repo_via_pane', mode: 'pull' }
      : reply.action.type === 'run_command' &&
          (isExecutionReadyDelegationPrompt(reply.action.command) ||
            !looksLikeShellCommand(reply.action.command))
        ? { type: 'send_to_pane', text: reply.action.command }
        : reply.action;

  if (action.type !== 'none') {
    // run_command must reach the focused shell branch below. The mission MCP
    // route requires mission identifiers and incorrectly blocked ordinary
    // workspace terminals before the native confirmation dialog appeared.
    const mcpFirst = new Set<JarvisAction['type']>(['mcp_tool']);
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
    } catch {
      sayText = 'Não consegui ler esta tela agora.';
      toolResult = {
        tool: action.type,
        ok: false,
        summary: 'leitura visual indisponível',
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
    const squads = useOrchStore.getState().squads.filter((squad) => !isMissionRuntimeSquadId(squad.id));
    if (!workspace) {
      sayText = 'Antes eu preciso de um projeto aberto. Quer abrir um dos recentes?';
      expectReply = true;
      toolResult = { tool: action.type, ok: false, summary: 'sem workspace aberto' };
    } else if (squads.length === 0) {
      sayText = 'Este projeto ainda não tem squads salvos. Quer criar um novo?';
      expectReply = true;
      toolResult = { tool: action.type, ok: false, summary: 'nenhum squad salvo' };
    } else {
      useProductNavigationStore.getState().openSettings('squads');
      markEffect(control);
      const confirmed = await confirmUiState(
        () => useProductNavigationStore.getState().destination,
        (destination) => destination.kind === 'settings' && destination.section === 'squads',
        control,
      );
      sayText = confirmed
        ? 'Catálogo de equipes aberto. Escolha Usar integrantes na equipe desejada.'
        : 'Tentei abrir o catálogo de equipes, mas ainda não confirmei a tela.';
      toolResult = {
        tool: action.type,
        ok: confirmed,
        summary: confirmed
          ? 'catálogo de equipes aberto nas Configurações'
          : 'catálogo de equipes sem pós-condição confirmada',
      };
    }
  } else if (action.type === 'open_squad') {
    const squads = useOrchStore.getState().squads.filter((squad) => !isMissionRuntimeSquadId(squad.id));
    const resolution = resolveSquadByVoiceName(action.squadName, squads);
    if (resolution.kind === 'ambiguous') {
      const choices = resolution.candidates
        .slice(0, 4)
        .map((squad) => squad.name)
        .join(', ');
      sayText = `Encontrei mais de um squad parecido: ${choices}. Qual deles você quer usar?`;
      expectReply = true;
      toolResult = { tool: action.type, ok: false, summary: 'squad ambíguo' };
    } else if (resolution.kind === 'match') {
      const squad = resolution.squad;
      if (squad.id === PET_STUDIO_SQUAD_ID) {
        useProductNavigationStore.getState().openSettings('appearance');
        markEffect(control);
        return {
          sayText: 'Abra Criar pet em Aparência para preparar o Pet Studio.',
          toolResult: { tool: action.type, ok: true, summary: 'fluxo dedicado de pet aberto em Aparência' },
        };
      }
      const opened = openCanonicalMissionSetup({
        roster: squad.agents,
        step: 'mission',
      });
      if (!opened) {
        sayText =
          'Não foi possível aplicar os integrantes. Confira o projeto aberto e as configurações dessa equipe.';
        expectReply = true;
        toolResult = { tool: action.type, ok: false, summary: 'sem workspace aberto' };
      } else {
        markEffect(control);
        sayText = `Integrantes de ${squad.name} aplicados, sem as instruções globais do catálogo. Qual é o objetivo da missão?`;
        expectReply = true;
        toolResult = {
          tool: action.type,
          ok: true,
          summary: `integrantes de ${squad.name} copiados para o setup da missão`,
        };
      }
    } else {
      sayText = `Não achei o squad "${action.squadName}". Os disponíveis são: ${context.squads.join(', ')}.`;
      toolResult = { tool: action.type, ok: false, summary: 'squad não encontrado' };
    }
  } else if (action.type === 'open_workspace') {
    const wanted = action.workspaceName.toLowerCase().trim();
    const workspaceStore = useWorkspaceStore.getState();
    if (
      !wanted ||
      /^(novo|nova|new|workspace-new|new-workspace|novo-workspace)$/i.test(wanted)
    ) {
      try {
        await workspaceStore.pick();
        markEffect(control);
        checkpoint(control);
        const current = useWorkspaceStore.getState().current;
        if (current) {
          useProductNavigationStore.getState().openTerminal();
          sayText = `Projeto ${current.name} aberto.`;
          toolResult = {
            tool: 'new_workspace',
            ok: true,
            summary: 'workspace escolhido e terminal aberto',
          };
        } else {
          sayText = 'A escolha de projeto foi cancelada.';
          toolResult = {
            tool: 'new_workspace',
            ok: false,
            summary: 'seleção de workspace cancelada',
          };
        }
      } catch {
        sayText = 'Não consegui abrir o seletor de projetos.';
        toolResult = {
          tool: 'new_workspace',
          ok: false,
          summary: 'falha ao escolher workspace',
        };
      }
    } else {
      const resolution = resolveWorkspaceByVoiceName(
        action.workspaceName,
        workspaceStore.recents,
      );
      if (resolution.kind === 'match') {
        const match = resolution.workspace;
        try {
          await workspaceStore.open(match.path);
          markEffect(control);
          const evidence = await waitForActionEvidence({
            read: () => useWorkspaceStore.getState().current?.path ?? null,
            accepts: (activePath) => activePath === match.path,
            timeoutMs: 3_000,
            signal: control.signal,
          });
          checkpoint(control);
          if (evidence.status === 'committed') {
            useProductNavigationStore.getState().openTerminal();
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
        } catch {
          sayText = `Não consegui abrir ${match.name}.`;
          toolResult = {
            tool: action.type,
            ok: false,
            summary: 'falha ao abrir workspace',
          };
        }
      } else if (resolution.kind === 'ambiguous') {
        const names = resolution.candidates
          .slice(0, 4)
          .map((item) => item.name)
          .join(', ');
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
    const workspace = useWorkspaceStore.getState().current;
    if (!workspace) {
      sayText = 'Abre um projeto primeiro que eu monto o squad dele.';
      toolResult = { tool: action.type, ok: false, summary: 'sem workspace aberto' };
    } else {
      try {
        const result = await window.nexus.orch.designSquad(workspace.path);
        checkpoint(control);
        if (result.ok && result.squad) {
          const opened = openCanonicalMissionSetup({
            roster: result.squad.agents,
            step: 'mission',
          });
          if (!opened) {
            return {
              sayText: 'Não foi possível aplicar os integrantes gerados. Confira o projeto aberto e revise a equipe.',
              toolResult: { tool: action.type, ok: false, summary: 'integrantes gerados não foram aplicados' },
            };
          }
          markEffect(control);
          sayText = `Integrantes de ${result.squad.name} preparados, sem as instruções globais do catálogo. Qual é o objetivo da missão?`;
          expectReply = true;
          toolResult = {
            tool: action.type,
            ok: true,
            summary: `integrantes de ${result.squad.name} copiados para o setup da missão`,
          };
        } else {
          if (isMissingModelKeyError(result.error)) {
            useProductNavigationStore
              .getState()
              .openSettings('providers');
          }
          sayText = 'Não consegui montar o squad.';
          toolResult = {
            tool: action.type,
            ok: false,
            summary: 'design de squad falhou',
          };
        }
      } catch {
        sayText = 'Não consegui montar o squad.';
        toolResult = {
          tool: action.type,
          ok: false,
          summary: 'design de squad falhou',
        };
      }
    }
  } else if (action.type === 'confirm_squad') {
    const entrySetup = useMissionSetupStore.getState();
    if (entrySetup.entryContext) entrySetup.clearEntryContext();
    const setup = useMissionSetupStore.getState();
    if (!setup.workspacePath || setup.draft.roster.length === 0) {
      sayText =
        'Não tem uma equipe na revisão agora. Diga "iniciar squad" para escolher uma.';
      expectReply = true;
      toolResult = {
        tool: action.type,
        ok: false,
        summary: 'setup sem equipe selecionada',
      };
    } else {
      setup.setStep(setup.draft.objective.trim() ? 'review' : 'mission');
      useProductNavigationStore.getState().openMissionSetup();
      markEffect(control);
      sayText = setup.draft.objective.trim()
        ? 'Abrindo a aprovação final da missão.'
        : 'Equipe selecionada. Agora falta revisar o objetivo.';
      expectReply = false;
      toolResult = {
        tool: action.type,
        ok: true,
        summary: setup.draft.objective.trim()
          ? 'revisão canônica da missão aberta'
          : 'equipe confirmada no setup canônico',
      };
    }
  } else if (action.type === 'new_agentic_mission') {
    const opened = openCanonicalMissionSetup({
      ...(action.intent?.trim()
        ? { objective: action.intent.trim(), step: 'team' as const }
        : { step: 'mission' as const }),
    });
    if (!opened) {
      sayText = 'Abre um projeto primeiro; aí eu preparo a missão.';
      toolResult = { tool: action.type, ok: false, summary: 'sem workspace aberto' };
    } else {
      markEffect(control);
      sayText =
        sayText.trim() ||
        (action.intent
          ? 'Abrindo o setup da missão com o objetivo preenchido.'
          : 'Abrindo o setup da missão.');
      toolResult = {
        tool: action.type,
        ok: true,
        summary: action.intent
          ? 'setup de missão aberto com objetivo'
          : 'setup de missão aberto',
        ...(action.intent ? { output: { intent: action.intent } } : {}),
      };
    }
  } else if (action.type === 'new_mission') {
    const workspace = useWorkspaceStore.getState().current;
    if (!workspace) {
      toolResult = {
        tool: action.type,
        ok: false,
        summary: 'sem workspace aberto',
      };
    } else {
      useProductNavigationStore.getState().openNewMission();
      markEffect(control);
      toolResult = {
        tool: action.type,
        ok: true,
        summary: 'setup de missão aberto',
      };
    }
  } else if (action.type === 'new_workspace') {
    try {
      await useWorkspaceStore.getState().pick();
      markEffect(control);
      checkpoint(control);
      const workspace = useWorkspaceStore.getState().current;
      if (workspace) {
        useProductNavigationStore.getState().openTerminal();
        sayText = `Projeto ${workspace.name} aberto.`;
        toolResult = {
          tool: action.type,
          ok: true,
          summary: 'workspace escolhido e terminal aberto',
        };
      } else {
        sayText = 'A escolha de projeto foi cancelada.';
        toolResult = {
          tool: action.type,
          ok: false,
          summary: 'seleção de workspace cancelada',
        };
      }
    } catch {
      sayText = 'Não consegui abrir o seletor de projetos.';
      toolResult = {
        tool: action.type,
        ok: false,
        summary: 'falha ao escolher workspace',
      };
    }
  } else if (action.type === 'open_terminal') {
    const workspace = useWorkspaceStore.getState().current;
    if (!workspace) {
      sayText = 'Abre um projeto primeiro; aí eu abro o terminal nele.';
      toolResult = { tool: action.type, ok: false, summary: 'sem workspace aberto' };
    } else {
      const layout = useLayoutStore.getState();
      const panes = listPanes(layout.root);
      const reusableShell =
        panes.length === 1 &&
        panes[0].kind === 'shell' &&
        !panes[0].orchRequestId;
      let paneId: string;
      try {
        paneId = reusableShell ? panes[0].id : layout.addShellPane();
      } catch (error) {
        reportLicenseDenial(error);
        return { sayText: 'Abra Minha conta para atualizar seu acesso ao NexusIDE.', expectReply: false, toolResult: { tool: action.type, ok: false, summary: 'license_access_denied' } };
      }
      if (reusableShell) layout.claimStructuralPlaceholder(paneId);
      revealPaneForUser(paneId);
      markEffect(control);
      const sessionId = await waitForSession(paneId, 5_000);
      checkpoint(control);
      if (sessionId) {
        sayText = 'Terminal aberto.';
        toolResult = {
          tool: action.type,
          ok: true,
          summary: 'terminal aberto e visível',
        };
      } else {
        sayText = 'Abri o painel, mas o terminal ainda não iniciou.';
        toolResult = {
          tool: action.type,
          ok: false,
          summary: 'terminal sem sessão',
        };
      }
    }
  } else if (action.type === 'open_agent') {
    const workspace = useWorkspaceStore.getState().current;
    if (!workspace) {
      sayText = 'Abre um projeto primeiro; aí eu abro o agente nele.';
      toolResult = { tool: action.type, ok: false, summary: 'sem workspace aberto' };
    } else {
      const rawAgent = action.agentId.toLowerCase().trim();
      const agentId = rawAgent === 'antigravity' ? 'agy' : rawAgent;
      let model = action.model;
      let effort: string | undefined;

      if (agentId === 'codex') {
        model = action.model || 'gpt-5.6-luna';
      } else if (agentId === 'agy') {
        model = action.model || 'gemini-3.8-flash-high';
        effort = 'max';
      } else if (agentId === 'kimi') {
        model = action.model || 'kimi-code/k3';
      } else if (agentId === 'devin') {
        model = action.model || 'swe-2-high';
      }

      const paneId = useLayoutStore.getState().spawnAgent(agentId, model || '', {
        ...(effort ? { effort } : {}),
      });

      if (paneId) {
        revealPaneForUser(paneId);
        markEffect(control);
        const sessionId = await waitForSession(paneId, 5_000);
        checkpoint(control);
        if (sessionId) {
          sayText = sayText || `Agente ${agentId} aberto.`;
          toolResult = {
            tool: action.type,
            ok: true,
            summary: `agente ${agentId} aberto e visível (${model ?? 'padrão'})`,
            output: { paneId, agentId, model, effort },
          };
        } else {
          sayText = `Abri o painel, mas o agente ${agentId} ainda não iniciou.`;
          toolResult = {
            tool: action.type,
            ok: false,
            summary: `agente ${agentId} sem sessão`,
          };
        }
      } else {
        sayText = `Não consegui abrir o agente ${agentId}.`;
        toolResult = {
          tool: action.type,
          ok: false,
          summary: `falha ao abrir agente ${agentId}`,
        };
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
    useProductNavigationStore.getState().openTaskBoard();
    const confirmed = await confirmUiState(
      () => useProductNavigationStore.getState().destination,
      (destination) => destination.kind === 'task-board',
      control,
    );
    sayText = confirmed
      ? 'Quadro aberto.'
      : 'Tentei abrir o quadro, mas não confirmei a tela.';
    toolResult = {
      tool: action.type,
      ok: confirmed,
      summary: confirmed
        ? 'quadro de tarefas aberto e confirmado'
        : 'quadro sem pós-condição',
    };
  } else if (action.type === 'open_settings') {
    useProductNavigationStore.getState().openSettings();
    const confirmed = await confirmUiState(
      () => useProductNavigationStore.getState().destination,
      (destination) => destination.kind === 'settings',
      control,
    );
    sayText = confirmed
      ? 'Configurações abertas.'
      : 'Tentei abrir as configurações, mas não confirmei a tela.';
    toolResult = {
      tool: action.type,
      ok: confirmed,
      summary: confirmed
        ? 'configurações abertas e confirmadas'
        : 'configurações sem pós-condição',
    };
  } else if (action.type === 'open_voice_settings') {
    useVoiceStore.getState().openSettings();
    const confirmed = await confirmUiState(
      () => useVoiceStore.getState().settingsOpen,
      Boolean,
      control,
    );
    sayText = confirmed
      ? 'Configurações de voz abertas.'
      : 'Tentei abrir os ajustes de voz, mas não confirmei a tela.';
    toolResult = {
      tool: action.type,
      ok: confirmed,
      summary: confirmed
        ? 'configurações de voz abertas e confirmadas'
        : 'voz sem pós-condição',
    };
  } else if (action.type === 'open_browser') {
    let paneId: string;
    try {
      paneId = useLayoutStore.getState().addBrowserPane(action.url);
    } catch (error) {
      reportLicenseDenial(error);
      return { sayText: 'Abra Minha conta para atualizar seu acesso ao NexusIDE.', expectReply: false, toolResult: { tool: action.type, ok: false, summary: 'license_access_denied' } };
    }
    revealPaneForUser(paneId);
    markEffect(control);
    try {
      await waitForBrowserPaneCreated(paneId, 3_000);
      checkpoint(control);
      sayText = action.url ? 'Site aberto.' : 'Browser aberto.';
      toolResult = {
        tool: action.type,
        ok: true,
        summary: action.url
          ? `browser aberto em ${action.url}`
          : 'browser aberto',
      };
    } catch {
      sayText = 'Criei o pane do browser, mas ele ainda não respondeu.';
      toolResult = {
        tool: action.type,
        ok: false,
        summary: 'browser ainda indisponível',
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
      revealPaneForUser(next.id);
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
      revealPaneForUser(prev.id);
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
      revealPaneForUser(target.id);
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
      const ok = Boolean(sessionId) && await submitPromptToPane(target.paneId, action.text);
      logVoiceEvent(ok ? 'info' : 'warn', ok ? 'pane.deliverySubmitted' : 'pane.deliveryFailed', ok ? 'texto submetido ao PTY' : 'sessão do pane indisponível', {
        commandId,
        paneId: target.paneId,
        sessionReady: Boolean(sessionId),
      });
      if (!ok) {
        sayText = 'Não consegui escrever no pane.';
      } else if (!sayText) {
        sayText = 'Enviado ao pane.';
      }
      toolResult = {
        tool: action.type,
        ok,
        summary: ok ? `resposta submetida ao pane (${commandId})` : 'falha ao escrever no pane',
        output: { commandId, paneId: target.paneId, sessionReady: Boolean(sessionId) },
      };
    } else if (target.kind === 'asking-pane-gone') {
      sayText =
        paneNumberRefusal(target) ??
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
      // Natural-language delegation is mission setup input, never shell input.
      // Explicit shell requests retain the native run_command confirmation.
      const opened = openCanonicalMissionSetup({
        objective: action.text,
        step: 'team',
      });
      if (opened) markEffect(control);
      sayText = opened
        ? 'Abrindo o setup da missão com esse objetivo. Nenhum agente foi iniciado ainda.'
        : 'Abre um projeto primeiro; aí eu preparo essa missão.';
      toolResult = {
        tool: action.type,
        ok: opened,
        summary: opened
          ? 'objetivo encaminhado ao setup canônico'
          : 'sem workspace aberto',
        ...(opened ? { output: { intent: action.text } } : {}),
      };
    } else {
      const missionPrompt = prepareDelegationPrompt(action.text);
      const commandId = crypto.randomUUID();
      const sessionId = await waitForSession(target.orchestratorPaneId, 750);
      checkpoint(control);
      const ok = Boolean(sessionId) &&
        await submitPromptToPane(target.orchestratorPaneId, missionPrompt);
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
        ? (sayText || 'Missão enviada ao squad.')
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
    let terminalCommand = action.command.trim() === 'I' ? 'ai' : action.command.trim();
    if (terminalCommand === 'codex') {
      terminalCommand = 'codex --model gpt-5.6-luna';
    } else if (terminalCommand === 'agy' || terminalCommand === 'antigravity') {
      terminalCommand = 'agy --model gemini-3.8-flash-high --effort max';
    } else if (terminalCommand === 'kimi') {
      terminalCommand = 'kimi --model kimi-code/k3';
    } else if (terminalCommand === 'devin') {
      terminalCommand = 'devin --model swe-2-high';
    }
    if (/[\r\n]/.test(terminalCommand)) {
      return {
        sayText: 'Por segurança, eu só executo comandos de uma única linha.',
        expectReply: false,
        toolResult: {
          tool: action.type,
          ok: false,
          summary: 'comando multilinha bloqueado',
        },
      };
    }
    const { focusedPaneId: fp, root: rc } = useLayoutStore.getState();
    const panesNow = listPanes(rc);
    const paneMissions = useOrchStore.getState().paneMissions;
    const focused = fp ? panesNow.find((p) => p.id === fp) : undefined;
    // Shell do MESMO escopo do foco: o comando da missão A nunca roda no
    // terminal da missão B (isolamento de campo A/B).
    const shellPane =
      focused?.kind === 'shell'
        ? focused
        : (() => {
            const shellIds = panesNow
              .filter((p) => p.kind === 'shell')
              .map((p) => p.id);
            const scoped = pickFallbackInScope(shellIds, fp, panesNow, paneMissions);
            return scoped ? panesNow.find((p) => p.id === scoped) : undefined;
          })();
    let targetPaneId: string;
    try {
      targetPaneId = shellPane?.id ?? useLayoutStore.getState().addShellPane();
    } catch (error) {
      reportLicenseDenial(error);
      return { sayText: 'Abra Minha conta para atualizar seu acesso ao NexusIDE.', expectReply: false, toolResult: { tool: action.type, ok: false, summary: 'license_access_denied' } };
    }
    revealPaneForUser(targetPaneId);
    markEffect(control);
    const sessionId = await waitForSession(targetPaneId, 5_000);
    checkpoint(control);
    if (!sessionId) {
      sayText = 'Não consegui iniciar um terminal para rodar o comando.';
      toolResult = { tool: action.type, ok: false, summary: 'terminal sem sessão' };
    } else {
      // Gemini occasionally converts the Portuguese literal command “ai” to
      // the English pronoun “I”. For this exact one-token ambiguity preserve
      // the user's intended lowercase CLI command. Other commands stay exact.
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
    const missions = useOrchStore.getState().missionSummaries;
    // F-634/F-635: a espera do Jev pode durar segundos; quem espera e depois age
    // confere o escopo de novo. Projeto trocado ou missão removida no meio = nada abre.
    const epochBefore = useOrchStore.getState().workspaceEpoch;
    if (missions.length === 0) {
      sayText = 'Não tem nenhuma missão salva para abrir.';
      toolResult = { tool: action.type, ok: false, summary: 'sem missões' };
    } else {
      // Nenhuma missão é aberta "por palpite": nome sem par → diz que não achou;
      // nomes parecidos → o Jev desempata ou a pessoa é perguntada.
      const decision = await decideRestoreMission(action.alvo, missions, (request) =>
        requestMissionPick(request, control.signal),
      );
      checkpoint(control);
      const scopeNow = useOrchStore.getState();
      const scopeChanged =
        decision.kind === 'open' &&
        (scopeNow.workspaceEpoch !== epochBefore ||
          !scopeNow.missionSummaries.some((mission) => mission.id === decision.mission.id));
      if (decision.kind === 'open' && scopeChanged) {
        sayText = 'O projeto mudou enquanto eu procurava a missão. Peça de novo.';
        toolResult = {
          tool: action.type,
          ok: false,
          summary: 'projeto mudou durante a escolha — nada aberto',
        };
      } else if (decision.kind === 'open') {
        const navigation = useProductNavigationStore.getState();
        navigation.openMission(decision.mission.id);
        useProductNavigationStore.getState().showMissionTerminals();
        markEffect(control);
        sayText = decision.say;
        toolResult = {
          tool: action.type,
          ok: true,
          summary: `terminais da missão ${spokenTitle(decision.mission.title)} abertos`,
          output: { missionId: decision.mission.id },
        };
      } else {
        sayText = decision.say;
        expectReply = true;
        toolResult = {
          tool: action.type,
          ok: false,
          summary:
            decision.reason === 'none'
              ? 'nenhuma missão com esse nome — nada aberto'
              : 'nome de missão ambíguo — nada aberto',
        };
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
      sayText =
        paneNumberRefusal(target) ??
        'Esse pane já fechou — não tenho pra quem perguntar.';
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
  } else if (action.type === 'sync_repo_via_pane') {
    // Product default: everyday repo sync goes to an AI CLI pane with a fixed
    // prompt — never ProcessGitRunner / nexus_git_* (multi-OS client git).
    const mode = normalizeSyncRepoViaPaneMode(action.mode);
    if (mode === 'push') {
      checkpoint(control);
      const approved = await window.nexus.voice.confirmCommand(
        'Pedir ao agente no pane: git push (sem force)',
      );
      checkpoint(control);
      if (!approved) {
        sayText = 'Cancelei, não pedi o push.';
        toolResult = {
          tool: action.type,
          ok: false,
          summary: 'usuário recusou push',
        };
        return { sayText, expectReply, toolResult };
      }
    }

    const prompt = buildSyncRepoViaPanePrompt(mode);
    const { root, focusedPaneId } = useLayoutStore.getState();
    const panes = listPanes(root);
    const target = resolveSyncRepoViaPaneTarget(action.paneId, panes, focusedPaneId);

    if (target.kind === 'asking-pane-gone') {
      sayText =
        paneNumberRefusal(target) ??
        'O pane que você citou já fechou. Abre um agente e pede de novo.';
      toolResult = {
        tool: action.type,
        ok: false,
        summary: 'pane alvo fechado',
      };
    } else if (target.kind === 'asking-pane-not-agent') {
      sayText = 'Esse pane não é de agente — o sync vai só pra CLI de IA.';
      toolResult = {
        tool: action.type,
        ok: false,
        summary: `alvo não é pane de agente: ${target.title}`,
      };
    } else if (target.kind === 'asking-pane-ambiguous') {
      sayText = `Achei mais de um pane: ${target.titles.join(', ')}. Qual deles?`;
      expectReply = true;
      toolResult = {
        tool: action.type,
        ok: false,
        summary: 'pane ambíguo',
      };
    } else if (target.kind === 'no-agent-pane') {
      const created = await openSingleAgentPaneForSync();
      checkpoint(control);
      if (!created) {
        sayText =
          'Não achei agente aberto e não consegui abrir um agente novo pra sincronizar.';
        toolResult = {
          tool: action.type,
          ok: false,
          summary: 'sem agente disponível para sync',
          output: { mode },
        };
      } else {
        markEffect(control);
        const commandId = crypto.randomUUID();
        const sessionId = await waitForSession(created.paneId, 15_000);
        checkpoint(control);
        const ok = sessionId
          ? await submitPromptToPaneConfirmed(created.paneId, prompt, sessionId)
          : false;
        checkpoint(control);
        if (ok) revealPaneForUser(created.paneId);
        logVoiceEvent(
          ok ? 'info' : 'warn',
          ok ? 'pane.syncRepoSpawnedAndSubmitted' : 'pane.syncRepoSpawnedButFailed',
          ok
            ? 'sync de repositório abriu um agente único e confirmou entrega'
            : 'agente único abriu, mas a entrega do sync não foi confirmada',
          {
            commandId,
            paneId: created.paneId,
            mode,
            sessionReady: Boolean(sessionId),
            deliveryConfirmed: ok,
          },
        );
        sayText = ok
          ? syncRepoViaPaneNoAgentSay(mode)
          : syncRepoViaPaneDeliveryFailedSay();
        toolResult = {
          tool: action.type,
          ok,
          summary: ok
            ? `sync ${mode} abriu um agente único e foi confirmado (${commandId})`
            : 'agente único abriu, mas entrega não confirmou',
          output: {
            commandId,
            paneId: created.paneId,
            mode,
            sessionReady: Boolean(sessionId),
            deliveryConfirmed: ok,
          },
        };
      }
    } else {
      const paneId =
        target.kind === 'asking-pane'
          ? target.paneId
          : target.orchestratorPaneId;
      const paneTitle =
        panes.find((pane) => pane.id === paneId)?.title ?? 'agente';
      const commandId = crypto.randomUUID();
      const paneState = useSessionStateStore.getState().paneStates.get(paneId);
      if (!isSyncRepoPaneFree(paneState)) {
        sayText = syncRepoViaPaneBusySay(paneTitle);
        toolResult = {
          tool: action.type,
          ok: false,
          summary: `pane ocupado (${paneState})`,
          output: { commandId, paneId, mode, paneState },
        };
      } else {
        const sessionId = await waitForSession(paneId, 750);
        checkpoint(control);
        // Prefer confirmed write so delivery is validated against the live PTY
        // identity; fall back to fire-and-forget only if confirmed API missing.
        let ok = false;
        if (sessionId) {
          ok = await submitPromptToPaneConfirmed(paneId, prompt, sessionId);
          checkpoint(control);
        }
        if (ok) {
          markEffect(control);
          revealPaneForUser(paneId);
        }
        logVoiceEvent(
          ok ? 'info' : 'warn',
          ok ? 'pane.syncRepoSubmitted' : 'pane.syncRepoFailed',
          ok
            ? 'sync de repositório submetido e confirmado no pane'
            : 'falha ao confirmar entrega no pane',
          {
            commandId,
            paneId,
            mode,
            sessionReady: Boolean(sessionId),
            deliveryConfirmed: ok,
            paneState: paneState ?? 'unknown',
          },
        );
        sayText = ok
          ? syncRepoViaPaneSay(mode, paneTitle)
          : syncRepoViaPaneDeliveryFailedSay();
        toolResult = {
          tool: action.type,
          ok,
          summary: ok
            ? `sync ${mode} confirmado no pane (${commandId})`
            : 'falha ao confirmar entrega no pane',
          output: {
            commandId,
            paneId,
            mode,
            sessionReady: Boolean(sessionId),
            deliveryConfirmed: ok,
          },
        };
      }
    }
  }

  return { sayText, expectReply, toolResult };
}
