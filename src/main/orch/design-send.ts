import type {
  BrowserDesignElementContext,
  BrowserDesignRect,
} from '../../shared/browser-design';
import {
  queryFromSelection,
  type DesignCodeCandidate,
  type DesignSearchQuery,
} from './design-code-search';
import {
  formatDesignSelectionPrompt,
  type DesignStyleDiff,
} from './design-context-format';

/**
 * Push flow "enviar seleção pro agente" (VISUAL-EDIT-001, Fase 1): takes the
 * pane's stored selection, enriches it (L2 candidates + element screenshot)
 * and types the formatted context into the target CLI pane's PTY — the same
 * gesture Cursor ships as "forward DOM information to the agent". Pure logic
 * over injected deps; the electron wiring lives in browser-manager.
 */

export interface DesignSendInput {
  /** Browser pane holding the selection. */
  paneId: string;
  /** CLI pane (or its sessionId) that receives the context. */
  targetPaneRef: string;
  instruction?: string;
  /** Workspace-relative root for the L2 search. */
  dir?: string;
  /** Sidebar style edits to persist (F2 "Aplicar"). */
  styleDiff?: DesignStyleDiff;
  /** 'clone' (F4): third-party element to recreate in the project. */
  intent?: 'context' | 'clone';
  /**
   * When true, prepare the formatted prompt (L2 enrich + element screenshot +
   * format) but do NOT inject it into the target PTY. The prompt is returned
   * so the renderer can copy it to the clipboard (the "Copy" path of Orca's
   * Grab confirmation, adapted to this project's push flow). Default false.
   */
  dryRun?: boolean;
}

export interface DesignSendDeps {
  getSelection(paneId: string): BrowserDesignElementContext | null;
  /** Multi-selection set (F4); the newest entry is the primary selection. */
  getSelections(paneId: string): BrowserDesignElementContext[];
  findPane(paneRef: string): { paneId: string; sessionId?: string } | null;
  workspaceRoot(dir?: string): string;
  search(
    rootDir: string,
    query: DesignSearchQuery,
  ): Promise<DesignCodeCandidate[]>;
  capture(
    paneId: string,
    clip: BrowserDesignRect,
  ): Promise<{ path: string } | null>;
  inject(sessionId: string, prompt: string): Promise<void>;
}

export interface DesignSendResult {
  ok: true;
  targetPaneId: string;
  targetSessionId: string;
  promptChars: number;
  screenshotPath?: string;
  /** Present only when dryRun=true: the formatted prompt, for clipboard copy. */
  prompt?: string;
}

function snapshotSelectionState(
  selection: BrowserDesignElementContext,
  selections: readonly BrowserDesignElementContext[],
): {
  selection: BrowserDesignElementContext;
  selections: BrowserDesignElementContext[];
  fingerprint: string;
} {
  const fingerprint = JSON.stringify({ selection, selections });
  const snapshot = JSON.parse(fingerprint) as {
    selection: BrowserDesignElementContext;
    selections: BrowserDesignElementContext[];
  };
  return { ...snapshot, fingerprint };
}

export async function sendDesignSelectionToAgent(
  input: DesignSendInput,
  deps: DesignSendDeps,
): Promise<DesignSendResult> {
  const currentSelection = deps.getSelection(input.paneId);
  if (!currentSelection) {
    throw new Error(
      'no design selection for this pane: enable design mode and click an element first',
    );
  }
  const selectionState = snapshotSelectionState(
    currentSelection,
    deps.getSelections(input.paneId),
  );
  const { selection } = selectionState;
  const target = deps.findPane(input.targetPaneRef);
  if (!target) throw new Error(`unknown target pane: ${input.targetPaneRef}`);
  if (!target.sessionId) {
    throw new Error(`target pane has no live session: ${input.targetPaneRef}`);
  }

  let candidates: DesignCodeCandidate[] = [];
  if (input.intent !== 'clone') {
    try {
      candidates = await deps.search(
        deps.workspaceRoot(input.dir),
        queryFromSelection(selection),
      );
    } catch {
      // L2 is advisory — the agent can still search on its own.
    }
  }

  let screenshotPath: string | undefined;
  try {
    screenshotPath = (await deps.capture(input.paneId, selection.rect))?.path;
  } catch {
    // Hidden pane etc.: context still ships without the image.
  }

  const liveSelection = deps.getSelection(input.paneId);
  if (
    !liveSelection ||
    JSON.stringify({
      selection: liveSelection,
      selections: deps.getSelections(input.paneId),
    }) !== selectionState.fingerprint
  ) {
    throw new Error('design selection changed during context enrichment');
  }

  const extraSelections = selectionState.selections.filter(
    (candidate) => candidate.ref !== selection.ref,
  );

  const prompt = formatDesignSelectionPrompt({
    selection,
    candidates,
    screenshotPath,
    instruction: input.instruction,
    styleDiff: input.styleDiff,
    extraSelections,
    intent: input.intent,
  });
  // dryRun: stop short of injecting — return the prompt for clipboard copy /
  // preview. The fingerprint check above already guarantees the selection did
  // not change during enrichment, so the returned prompt is consistent.
  if (!input.dryRun) {
    await deps.inject(target.sessionId, prompt);
  }
  return {
    ok: true,
    targetPaneId: target.paneId,
    targetSessionId: target.sessionId,
    promptChars: prompt.length,
    ...(screenshotPath ? { screenshotPath } : {}),
    ...(input.dryRun ? { prompt } : {}),
  };
}
