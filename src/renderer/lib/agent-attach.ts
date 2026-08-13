/**
 * Attach file paths / dropped blobs to the focused CLI agent pane (Sprint A1).
 */
import type { PaneModel } from '../../shared/types';
import { useLayoutStore } from '../state/layout-store';
import { useOrchStore } from '../state/orch-store';
import { listPanes } from './split-tree';
import { resolveDroppedMissionContextPath } from './mission-shell-file-intake';
import { getActiveWorkspacePath } from '../state/active-workspace';
import {
  getPaneSessionId,
  submitPromptToPaneConfirmed,
  writeToPane,
} from '../terminal/terminal-host';

function shellQuote(p: string): string {
  if (/^[A-Za-z0-9_./:@+-]+$/.test(p)) return p;
  return `'${p.replace(/'/g, `'\\''`)}'`;
}

export function focusedAgentPaneId(): string | null {
  const { focusedPaneId, root } = useLayoutStore.getState();
  const panes = listPanes(root);
  if (focusedPaneId) {
    const p = panes.find((x) => x.id === focusedPaneId);
    if (p?.kind === 'cli-agent') return p.id;
  }
  const agent = panes.find((p) => p.kind === 'cli-agent');
  return agent?.id ?? null;
}

/**
 * Pure resolver: the pane that should receive a human diff review.
 * Review feedback is orchestration input — it belongs to the mission's
 * ORCHESTRATOR (who delegates the rework), not to whatever worker happens to
 * hold focus. Preference order:
 *  1. orchestrator of the focused pane's mission;
 *  2. (only when focus is NOT mission-bound) any live mission orchestrator;
 *  3. focused/first cli-agent pane (solo layouts without a mission).
 * A review NEVER crosses missions: if the focused pane belongs to mission A
 * and A's orchestrator is down, falling back to mission B's orchestrator
 * would deliver A's feedback to the wrong mission — prefer A's own panes.
 */
export function resolveReviewTargetPaneId(input: {
  readonly panes: readonly Pick<PaneModel, 'id' | 'kind' | 'role'>[];
  readonly focusedPaneId: string | null;
  readonly paneMissions: Readonly<Record<string, string>>;
  /** Defaults to true for pure callers; the live wrapper supplies PTY state. */
  readonly isPaneLive?: (paneId: string) => boolean;
}): string | null {
  const isPaneLive = input.isPaneLive ?? (() => true);
  const orchestrators = input.panes.filter(
    (pane) =>
      pane.kind === 'cli-agent' &&
      pane.role === 'orchestrator' &&
      input.paneMissions[pane.id] &&
      isPaneLive(pane.id),
  );
  const focusedMission = input.focusedPaneId
    ? input.paneMissions[input.focusedPaneId]
    : undefined;
  if (focusedMission) {
    // Mission-bound focus: only that mission's orchestrator qualifies.
    const ofFocusedMission = orchestrators.find(
      (pane) => input.paneMissions[pane.id] === focusedMission,
    );
    if (ofFocusedMission) return ofFocusedMission.id;
  } else if (orchestrators.length > 0) {
    return orchestrators[0]!.id;
  }
  if (input.focusedPaneId) {
    const focused = input.panes.find((pane) => pane.id === input.focusedPaneId);
    if (focused?.kind === 'cli-agent' && isPaneLive(focused.id)) return focused.id;
  }
  return (
    input.panes.find(
      (pane) =>
        pane.kind === 'cli-agent' &&
        isPaneLive(pane.id) &&
        // Mission-bound focus never leaks the review into another mission's
        // pane; unbound focus may take any live agent (solo layouts).
        (!focusedMission || input.paneMissions[pane.id] === focusedMission),
    )?.id ?? null
  );
}

/** Live resolver over the stores (thin wrapper around the pure function). */
export function reviewTargetPaneId(): string | null {
  const { focusedPaneId, root } = useLayoutStore.getState();
  return resolveReviewTargetPaneId({
    panes: listPanes(root),
    focusedPaneId,
    paneMissions: useOrchStore.getState().paneMissions,
    isPaneLive: (paneId) => Boolean(getPaneSessionId(paneId)),
  });
}

export function resolveReviewMissionId(
  paneId: string,
  paneMissions: Readonly<Record<string, string>>,
): string | null {
  return paneMissions[paneId] ?? null;
}

/** Inject path(s) into the focused agent as if typed into the prompt. */
export function injectPathsToAgent(paths: string[], paneId?: string): boolean {
  const target = paneId ?? focusedAgentPaneId();
  if (!target || paths.length === 0) return false;
  const line =
    '\n[Anexos Nexus]\n' +
    paths.map((p) => `- ${shellQuote(p)}`).join('\n') +
    '\n';
  return writeToPane(target, line);
}

export async function attachFilesToAgent(
  files: FileList | File[],
  paneId?: string,
): Promise<{ ok: boolean; count: number; error?: string }> {
  const list = Array.from(files);
  if (list.length === 0) return { ok: false, count: 0, error: 'no files' };
  const target = paneId ?? focusedAgentPaneId();
  if (!target) return { ok: false, count: 0, error: 'no agent pane focused' };

  const workspace = getActiveWorkspacePath();
  const paths: string[] = [];
  for (const file of list) {
    const resolved = await resolveDroppedMissionContextPath(workspace, file);
    if (resolved) paths.push(resolved);
  }
  if (paths.length === 0) return { ok: false, count: 0, error: 'could not resolve paths' };
  const ok = injectPathsToAgent(paths, target);
  return { ok, count: paths.length, error: ok ? undefined : 'write failed' };
}

/** Format diff annotations as a prompt block for the agent. */
export function annotationsToAgentPrompt(
  annotations: Array<{ path: string; line: number; body: string }>,
): string {
  if (annotations.length === 0) return '';
  const lines = annotations.map(
    (a, i) => `${i + 1}. ${a.path}:${a.line} — ${a.body.trim()}`,
  );
  return (
    '[Revisão Nexus — anotações no diff]\n' +
    'Revisão humana do diff atual. Endereça cada comentário no código; ' +
    'delegue ao especialista adequado quando fizer sentido e valide antes de concluir:\n' +
    lines.join('\n')
  );
}

/**
 * Mission feedback is persisted first as a non-terminal handoff; main-owned
 * idle delivery supplies acceptance/retry proof. Solo panes without a mission
 * keep the direct submitted-prompt behavior.
 */
export async function sendAnnotationsToAgent(
  annotations: Array<{ path: string; line: number; body: string }>,
  paneId?: string,
): Promise<boolean> {
  const text = annotationsToAgentPrompt(annotations);
  if (!text) return false;
  const target = paneId ?? reviewTargetPaneId();
  if (!target) return false;
  const missionId = resolveReviewMissionId(
    target,
    useOrchStore.getState().paneMissions,
  );
  if (missionId) {
    const result = await window.nexus.orch.submitOperatorReview({
      missionId,
      annotations: annotations.map((annotation) => ({ ...annotation })),
    });
    return result.ok;
  }
  const sessionId = getPaneSessionId(target);
  if (!sessionId) return false;
  return submitPromptToPaneConfirmed(target, text, sessionId);
}
