import type { AdapterInfo, PaneModel } from '../../shared/types';
import type { Squad, SquadAgent } from '../../shared/orch-types';
import { useLayoutStore } from '../state/layout-store';
import { useHomeStore } from '../state/home-store';
import { useOrchStore } from '../state/orch-store';
import { createPane } from '../lib/split-tree';
import { getActiveWorkspacePath } from '../state/active-workspace';
import { getPaneSessionId } from '../terminal/terminal-host';

/**
 * Launch logic behind the wizard when a
 * mission starts:
 *  - LIVRE: open N solo panes (shell or agent CLI) in the workspace;
 *  - SQUAD: spawn the squad's orchestrator CLI and, once it finishes booting,
 *    inject its orchestratorInstructions + roster as the kickoff prompt
 *    (bracketed paste, then Enter) so it immediately starts delegating via
 *    the embedded MCP tools.
 */

const SESSION_POLL_MS = 150;
const SESSION_TIMEOUT_MS = 20_000;
const BOOT_IDLE_TIMEOUT_MS = 15_000;
const PASTE_SETTLE_MS = 250;

/**
 * Modo Livre: build a fresh grid of EXACTLY one pane per slot, each backed by
 * the chosen provider (or a plain shell). Replaces the current grid so "2
 * panes" reliably shows two — no fragile iterative splitting.
 */
export function launchLibrePanes(
  slots: string[],
  adapters: AdapterInfo[],
): void {
  const cwd = getActiveWorkspacePath() ?? undefined;
  const panes: PaneModel[] = slots.map((slot) => {
    if (slot === 'shell') return createPane('shell', cwd);
    const adapter = adapters.find((a) => a.id === slot);
    return createPane('cli-agent', cwd, slot, adapter?.models.default ?? '');
  });
  useHomeStore.getState().hide();
  useLayoutStore.getState().setPanes(panes);
}

function waitForSession(paneId: string): Promise<string | null> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const poll = () => {
      const sessionId = getPaneSessionId(paneId);
      if (sessionId) return resolve(sessionId);
      if (Date.now() - startedAt > SESSION_TIMEOUT_MS) return resolve(null);
      setTimeout(poll, SESSION_POLL_MS);
    };
    poll();
  });
}

/** Resolve on the CLI's first idle (booted, waiting for input) or timeout. */
function waitFirstIdle(sessionId: string): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      unsub();
      resolve();
    };
    const unsub = window.nexus.pty.onStateChange(sessionId, (state) => {
      if (state === 'idle') finish();
    });
    setTimeout(finish, BOOT_IDLE_TIMEOUT_MS);
  });
}

function rosterBlock(agents: SquadAgent[]): string {
  return agents
    .filter((a) => a.category !== 'orchestrator')
    .map(
      (a) =>
        `- ${a.agentName} (${a.category}, cli=${a.cli}` +
        `${a.model ? `, model=${a.model}` : ''})`,
    )
    .join('\n');
}

function kickoffPrompt(squad: Squad): string {
  const parts: string[] = [];
  if (squad.orchestratorInstructions.trim()) {
    parts.push(squad.orchestratorInstructions.trim());
  }
  parts.push(
    `## Seu squad (${squad.name})\n${rosterBlock(squad.agents) || '(sem workers definidos)'}`,
  );
  parts.push(
    'Você é o orquestrador desta missão dentro do NexusIDE. Use as tools MCP ' +
      'do servidor "nexus" para orquestrar: nexus_mission_create para abrir a ' +
      'missão, nexus_pane_spawn {agentName} para spawnar cada worker (as ' +
      'allowlists do squad são aplicadas automaticamente), nexus_pane_write / ' +
      'nexus_pane_wait_idle / nexus_pane_read para coordenar, e ' +
      'nexus_handoff_list para coletar os resultados. Cada worker deve ' +
      'finalizar com nexus_handoff_submit. Comece perguntando ao usuário qual ' +
      'é a missão, caso ainda não tenha sido informada.',
  );
  parts.push(
    '## Roteamento inteligente (economia de tokens)\n' +
      'Uma das suas missões é POUPAR tokens e acelerar o trabalho. Antes de ' +
      'CADA delegação, chame nexus_route_task {task} e use o adapterId/model/' +
      'effort retornados no nexus_pane_spawn: tarefa fácil vai para modelo ' +
      'barato e rápido (grok, haiku, gpt-5.4-mini), tarefa média para sonnet/' +
      'gpt-5.4, e só o que é realmente difícil/crítico (arquitetura, auth, ' +
      'pagamentos, migração) vai para opus/fable/gpt-5.5 com effort alto. ' +
      'Nunca gaste um modelo caro em tarefa trivial; nunca entregue tarefa ' +
      'crítica a um modelo fraco. Quebre missões grandes em tarefas pequenas ' +
      'e roteie cada uma individualmente.',
  );
  return parts.join('\n\n');
}

export interface SquadLaunchResult {
  ok: boolean;
  paneId?: string;
  error?: string;
}

/** Only Claude Code reliably drives the embedded nexus MCP orchestration. */
const ORCHESTRATOR_CLI = 'claude';

export function launchSquadMission(
  squad: Squad,
  adapters: AdapterInfo[],
): SquadLaunchResult {
  const orchestrator =
    squad.agents.find((a) => a.category === 'orchestrator') ?? squad.agents[0];
  if (!orchestrator) {
    return { ok: false, error: 'Este squad não tem agentes.' };
  }

  // The orchestrator ALWAYS runs on Claude — it is the only CLI that reliably
  // calls the nexus_pane_* MCP tools to spawn and coordinate workers. A codex /
  // grok / gemini orchestrator boots but never delegates (the "squad opens but
  // nothing starts" bug). Workers keep their own CLI. If a legacy squad declared
  // a different orchestrator CLI we override it here as a safety net; the wizard
  // already locks the picker to Claude.
  const claudeAdapter = adapters.find((a) => a.id === ORCHESTRATOR_CLI);
  const cli = ORCHESTRATOR_CLI;
  const model =
    (orchestrator.cli === ORCHESTRATOR_CLI ? orchestrator.model : undefined) ??
    claudeAdapter?.models.default ??
    '';
  if (!claudeAdapter?.installed) {
    return {
      ok: false,
      error:
        'O orquestrador roda no Claude, mas a CLI `claude` não foi detectada. ' +
        'Instale/entre no Claude Code (ou ajuste o binário em Configurações › Providers) e tente de novo.',
    };
  }

  // Start the mission in a clean grid with just the orchestrator pane (a
  // squad opens its own workspace). Workers are added by
  // the orchestrator via the MCP tools as it delegates. Always replaces the
  // grid so something starts — no silent no-op.
  const cwd = getActiveWorkspacePath() ?? undefined;
  const orchPane: PaneModel = {
    ...createPane('cli-agent', cwd, cli, model),
    title: `${squad.name} · orq`,
    orchRequestId: `squad-${squad.id}-${Date.now().toString(36)}`,
  };
  useHomeStore.getState().hide();
  useLayoutStore.getState().setPanes([orchPane]);

  // Kickoff injection runs async — the wizard closes immediately, the
  // instructions land as soon as the CLI is booted and idle.
  void (async () => {
    const sessionId = await waitForSession(orchPane.id);
    if (!sessionId) return;
    await waitFirstIdle(sessionId);
    const prompt = kickoffPrompt(squad);
    // Bracketed paste keeps multi-line playbooks from submitting line-by-line.
    window.nexus.pty.write(sessionId, `\x1b[200~${prompt}\x1b[201~`);
    setTimeout(() => window.nexus.pty.write(sessionId, '\r'), PASTE_SETTLE_MS);
  })();

  useOrchStore.getState().bindPaneMission(orchPane.id, undefined);
  return { ok: true, paneId: orchPane.id };
}
