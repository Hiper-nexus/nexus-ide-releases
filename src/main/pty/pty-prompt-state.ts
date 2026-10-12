import { z } from 'zod';
import type { WebContents } from 'electron';
import type { PtyPromptState } from '../../shared/types';
import { getOwnedAgentSessionInfo, getSessionState, orchWriteSession } from './pty-manager';
import { getAgentSemanticStatusBySession, getAgentTurnStartSequence } from '../orch/agent-status';
import { getContextBySession } from '../orch/gate';
import { requireLiveRendererWorkspaceScope } from '../persistence/renderer-workspace-scope';
import { getAdapter } from '../adapters/adapter-registry';

const request = z.object({ sessionId: z.string().min(1).max(128) }).strict();

/** Same presentation owner and live workspace as PTY input; never terminal text. */
export function readOwnedPromptState(owner: WebContents, raw: unknown): PtyPromptState | null {
  const parsed = request.safeParse(raw);
  if (!parsed.success) return null;
  try {
    const info = getOwnedAgentSessionInfo(owner, parsed.data.sessionId);
    if (!info) return null;
    const context = getContextBySession(parsed.data.sessionId);
    if (!context) return null;
    // PTY info.scope is the execution worktree; renderer authority is the
    // Main-minted coordination checkout, including ordinary worktree tabs.
    requireLiveRendererWorkspaceScope(owner, context.scope);
    const state = getSessionState(parsed.data.sessionId);
    if (!state) return null;
    return {
      turnStartSequence: getAgentTurnStartSequence(parsed.data.sessionId),
      state,
      awaitingInput: getAgentSemanticStatusBySession(parsed.data.sessionId)?.status === 'awaiting-input',
      ...(getAdapter(info.adapterId)?.quirks?.queuesInputWhileBusy ? { queuesInputWhileBusy: true } : {}),
    };
  } catch { return null; }
}


const enterRequest = z.object({
  sessionId: z.string().min(1).max(128),
  turnStartSequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  retry: z.boolean(),
}).strict();

/** Check and CR are synchronous in Main: a new dialog cannot race an IPC probe. */
export function submitOwnedPromptEnter(owner: WebContents, raw: unknown): boolean {
  const parsed = enterRequest.safeParse(raw);
  if (!parsed.success) return false;
  const state = readOwnedPromptState(owner, { sessionId: parsed.data.sessionId });
  if (!state || state.awaitingInput || state.turnStartSequence !== parsed.data.turnStartSequence) return false;
  if (state.state !== 'idle' && (parsed.data.retry || state.state !== 'busy')) return false;
  return orchWriteSession(parsed.data.sessionId, '\r', { markInputBusy: false, inputOrigin: 'human' });
}
