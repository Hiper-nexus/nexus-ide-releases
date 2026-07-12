/**
 * Thin wrappers around Jarvis Live IPC (status / endTurn / context / log).
 */
import { useVoiceStore } from './voice-store';
import { mcpClearSession } from '../services/mcp-bridge';
import { currentScreenSnapshot } from './jarvis-screen-context';
import { isJarvisLiveEnabled } from './voice-realtime-gates';
import { useWorkspaceStore } from '../state/workspace-store';

export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function logVoiceEvent(
  level: 'info' | 'warn' | 'error',
  event: string,
  msg?: string,
  data?: Record<string, unknown>,
): void {
  window.nexus.voice.logVoice({
    level,
    event,
    ...(msg ? { msg: msg.slice(0, 500) } : {}),
    ...(data ? { data } : {}),
  });
}

export function liveStatus(
  status: 'dormant' | 'listening' | 'thinking' | 'speaking' | 'interrupted' | 'error',
  error?: string,
): void {
  if (!isJarvisLiveEnabled()) return;
  // Ownership is intentionally released by liveQuiesce before Classic takes
  // over. A late cosmetic status update must never become an unhandled IPC
  // rejection and abort the command that triggered that hand-off.
  void window.nexus.voice
    .liveStatus({ status, ...(error ? { error } : {}) })
    .catch((cause) => {
      const message = errMsg(cause);
      if (!/live session has no owner/i.test(message)) {
        console.warn('[voice] falha atualizando status Live:', message);
      }
    });
}

export async function clearJarvisMcpSession(): Promise<void> {
  try {
    const result = await mcpClearSession();
    if (!result.ok) {
      console.warn('[voice] não consegui limpar sessão MCP da Jarvis');
    }
  } catch (err) {
    console.warn('[voice] falha limpando sessão MCP da Jarvis:', errMsg(err));
  }
}

function requestLiveEndUserAudio(): Promise<void> {
  if (!isJarvisLiveEnabled()) return Promise.resolve();
  return window.nexus.voice
    .liveEndUserAudio()
    .then((state) => useVoiceStore.getState().setLiveState(state))
    .catch(() => {});
}

/** Flushes provider-side input as soon as capture pauses. */
export function liveEndUserAudio(): void {
  void requestLiveEndUserAudio();
}

/** Ends provider input and clears turn-scoped renderer MCP state. */
export function liveEndTurn(): void {
  if (!isJarvisLiveEnabled()) return;
  void window.nexus.voice
    .liveEndTurn()
    .then((state) => useVoiceStore.getState().setLiveState(state))
    .catch(() => {})
    .finally(() => {
      void clearJarvisMcpSession();
    });
}

/** Closes Live and waits until late provider callbacks can no longer race Classic. */
export async function quiesceLiveForClassic(reason: string): Promise<void> {
  if (!isJarvisLiveEnabled()) return;
  try {
    const state = await window.nexus.voice.liveQuiesce(reason);
    useVoiceStore.getState().setLiveState(state);
  } catch (error) {
    logVoiceEvent('error', 'live.quiesceFailed', 'falha encerrando Live antes do Classic', {
      reason,
      error: errMsg(error),
    });
    await window.nexus.voice.liveHardTeardown().catch(() => null);
  }
}

export function liveContextText(): string {
  const screen = currentScreenSnapshot().context;
  const workspaceCatalog = useWorkspaceStore.getState().recents
    .slice(0, 8)
    .map((workspace) => workspace.name)
    .join(', ') || 'none';
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'local';
  const now = new Date().toLocaleString('pt-BR', {
    dateStyle: 'short',
    timeStyle: 'short',
  });
  return `${screen} Recent workspace catalog: ${workspaceCatalog}. Opening an existing workspace must use open_workspace with a catalog name; creating one must use new_workspace only when the user explicitly asks for a new workspace. Local time: ${now} (${timeZone}).`;
}

export function sendLiveContextSnapshot(): void {
  if (!isJarvisLiveEnabled()) return;
  window.nexus.voice.liveContextIn(liveContextText());
}

export function queueLiveContextRefresh(): void {
  sendLiveContextSnapshot();
  window.setTimeout(sendLiveContextSnapshot, 120);
}
