import type { AdapterInfo, PaneModel } from '../../shared/types';
import type { Squad, SquadAgent } from '../../shared/orch-types';
import { useLayoutStore } from '../state/layout-store';
import { useOrchStore } from '../state/orch-store';
import { createPane } from '../lib/split-tree';
import { getActiveWorkspacePath } from '../state/active-workspace';
import { getPaneSessionId } from '../terminal/terminal-host';

/**
 * Launch logic behind the wizard, mirroring what Overclock does when a
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
  return parts.join('\n\n');
}

export interface SquadLaunchResult {
  ok: boolean;
  paneId?: string;
  error?: string;
}

export function launchSquadMission(
  squad: Squad,
  adapters: AdapterInfo[],
): SquadLaunchResult {
  const orchestrator =
    squad.agents.find((a) => a.category === 'orchestrator') ?? squad.agents[0];
  if (!orchestrator) {
    return { ok: false, error: 'Este squad não tem agentes.' };
  }

  // Resolve the orchestrator's CLI: prefer its declared adapter (installed or
  // not — a not-installed one still opens the pane and shows the install hint,
  // which beats silently doing nothing). If the declared CLI is unknown, fall
  // back to an installed agent CLI, else keep the id and let the spawn report.
  const declared = adapters.find((a) => a.id === orchestrator.cli);
  const fallback =
    declared ?? adapters.find((a) => a.installed) ?? adapters[0] ?? null;
  const cli = declared ? orchestrator.cli : fallback?.id ?? orchestrator.cli;
  const model =
    orchestrator.model ?? declared?.models.default ?? fallback?.models.default ?? '';

  // Start the mission in a clean grid with just the orchestrator pane (a
  // squad opens its own workspace, same as Overclock). Workers are added by
  // the orchestrator via the MCP tools as it delegates. Always replaces the
  // grid so something starts — no silent no-op.
  const cwd = getActiveWorkspacePath() ?? undefined;
  const orchPane: PaneModel = {
    ...createPane('cli-agent', cwd, cli, model),
    title: `${squad.name} · orq`,
    orchRequestId: `squad-${squad.id}-${Date.now().toString(36)}`,
  };
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
