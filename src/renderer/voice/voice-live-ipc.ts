/**
 * Thin wrappers around Jarvis Live IPC (status / endTurn / context / log).
 */
import { useVoiceStore } from './voice-store';
import { mcpClearSession } from '../services/mcp-bridge';
import { currentScreenSnapshot } from './jarvis-screen-context';
import { isJarvisLiveEnabled } from './voice-realtime-gates';

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
  void window.nexus.voice.liveStatus({ status, ...(error ? { error } : {}) });
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

export function liveContextText(): string {
  const screen = currentScreenSnapshot().context;
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'local';
  const now = new Date().toLocaleString('pt-BR', {
    dateStyle: 'short',
    timeStyle: 'short',
  });
  return `${screen} Local time: ${now} (${timeZone}).`;
}

export function sendLiveContextSnapshot(): void {
  if (!isJarvisLiveEnabled()) return;
  window.nexus.voice.liveContextIn(liveContextText());
}

export function queueLiveContextRefresh(): void {
  sendLiveContextSnapshot();
  window.setTimeout(sendLiveContextSnapshot, 120);
}
