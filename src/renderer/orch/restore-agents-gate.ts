import type { PaneModel } from '../../shared/types';
import type { OrchSettings } from '../../shared/settings-types';
import { DEFAULT_ORCH_SETTINGS } from '../../shared/settings-types';
import { setRestoredPanesHandler } from '../state/layout-store';
import { askConfirm } from '../state/confirm-store';
import {
  holdSpawnUntilApproved,
  releaseHeldSpawns,
} from '../terminal/terminal-host';

/**
 * Cross-platform gate for restored agents.
 *
 * Same Electron renderer path on macOS, Linux and Windows — no platform
 * branches. Mission panes never use generic auto-resume: their authority must
 * be rearmed/resumed through the main-owned mission flow from the rail.
 */

export type AgentRestorePolicy = OrchSettings['agentRestorePolicy'];

/** Pure: policy → action (unit-tested, OS-independent). */
export function resolveAgentRestoreAction(
  policy: AgentRestorePolicy | string | undefined,
): 'ask' | 'pause' | 'resume' {
  if (policy === 'pause' || policy === 'resume' || policy === 'ask') {
    return policy;
  }
  return 'ask';
}

/** Coalesce concurrent restore prompts (layout handler + App double-call). */
let promptInFlight: Promise<void> | null = null;
/** Agent pane ids waiting for the in-flight ask decision. */
const pendingAskIds = new Set<string>();
/** Last ask outcome — waiters apply the same decision to their batch. */
let lastAskDecision: 'resume' | 'pause' | null = null;

function agentLabel(pane: PaneModel): string {
  const name = pane.title?.trim() || pane.agentName?.trim() || pane.adapterId;
  return name || 'agente';
}

function isMissionAgent(pane: PaneModel): boolean {
  return Boolean(
    pane.missionId ||
      pane.role === 'orchestrator' ||
      pane.role === 'worker',
  );
}

async function loadPolicy(): Promise<AgentRestorePolicy> {
  try {
    const orch = await window.nexus.settings.orchGet();
    return resolveAgentRestoreAction(
      orch.agentRestorePolicy ?? DEFAULT_ORCH_SETTINGS.agentRestorePolicy,
    );
  } catch {
    return DEFAULT_ORCH_SETTINGS.agentRestorePolicy;
  }
}

function applyDecision(
  ids: readonly string[],
  decision: 'resume' | 'pause',
): void {
  if (ids.length === 0) return;
  if (decision === 'resume') {
    releaseHeldSpawns(ids, { resume: true });
    return;
  }
  releaseHeldSpawns(ids, { resume: false });
  // Stay held so a later attach cannot silent-spawn without an explicit reopen.
  for (const id of ids) holdSpawnUntilApproved(id);
}

/**
 * Hold restored CLI agents and apply the product policy. Safe default is
 * ask → dialog with focus on cancel ("Deixar em pausa").
 */
export async function gateRestoredAgents(
  panes: readonly PaneModel[],
): Promise<void> {
  const agents = panes.filter((pane) => pane.kind === 'cli-agent');
  if (agents.length === 0) return;

  // Always hold first so a fast attach cannot race before policy resolves.
  for (const pane of agents) holdSpawnUntilApproved(pane.id);

  // A mission pane is a presentation of main-owned physical authority. Generic
  // restore cannot decide whether to adopt, rearm, or create a fresh context;
  // keep it paused until the operator explicitly resumes the mission in rail.
  const restorable = agents.filter((pane) => !isMissionAgent(pane));
  if (restorable.length === 0) return;
  const ids = restorable.map((pane) => pane.id);

  const action = resolveAgentRestoreAction(await loadPolicy());

  if (action === 'resume') {
    applyDecision(ids, 'resume');
    return;
  }

  if (action === 'pause') {
    applyDecision(ids, 'pause');
    return;
  }

  // action === 'ask' — merge concurrent batches into one dialog.
  for (const id of ids) pendingAskIds.add(id);

  if (promptInFlight) {
    await promptInFlight;
    // Primary prompt already applied lastAskDecision to the full pending set.
    return;
  }

  promptInFlight = (async () => {
    const snapshotIds = [...pendingAskIds];
    const labels = restorable.slice(0, 5).map(agentLabel).join(', ');
    const more =
      restorable.length > 5 ? ` e mais ${restorable.length - 5}` : '';
    const count = Math.max(snapshotIds.length, restorable.length);
    const ok = await askConfirm({
      title: 'Retomar agentes da sessão anterior?',
      body:
        `Este workspace tinha ${count} agente(s) avulso(s) ` +
        `(${labels}${more}).\n\n` +
        'Se retomar agora, eles podem continuar a trabalhar sozinhos — ' +
        'comandos, edições e tools — sem pedir de novo a cada passo.\n\n' +
        'Isso vale em qualquer SO (macOS, Linux, Windows): o Nexus não ' +
        'reinicia missão sozinho sem sua confirmação.\n\n' +
        'Cancelar deixa tudo em pausa; retome no rail quando quiser.',
      confirmLabel: 'Retomar agentes',
      cancelLabel: 'Deixar em pausa',
      danger: true,
    });

    lastAskDecision = ok ? 'resume' : 'pause';
    const batch = [...pendingAskIds];
    pendingAskIds.clear();
    applyDecision(batch, lastAskDecision);
  })();

  try {
    await promptInFlight;
  } finally {
    promptInFlight = null;
  }
}

/** Wire layout restore → hold + policy. Call once at app boot (all platforms). */
export function installRestoredAgentsGate(): void {
  setRestoredPanesHandler((panes) => {
    void gateRestoredAgents(panes);
  });
}

/** Drop pending ask state (workspace close / tests). */
export function resetRestoredAgentsGate(): void {
  promptInFlight = null;
  pendingAskIds.clear();
  lastAskDecision = null;
}

/** @deprecated use resetRestoredAgentsGate */
export const resetRestoredAgentsGateForTests = resetRestoredAgentsGate;
