/**
 * Pure helpers for LiveTransportController (keeps the controller under 800 lines).
 */

import type {
  RealtimeFailure,
  RealtimeFailureCategory,
} from '../../shared/voice-ipc';

const LOCAL_TOOL_CALL_PREFIX = 'local:';
export const MAX_LIVE_HISTORY_ENTRY_CHARS = 2_000;
export const MAX_RESUME_CONTEXT_CHARS = 12_000;

export function isLocalToolCallId(callId: string): boolean {
  return callId.startsWith(LOCAL_TOOL_CALL_PREFIX);
}

export function isIgnorableRealtimeError(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes('cancellation failed') ||
    m.includes('no active response') ||
    m.includes('response_cancel_not_active') ||
    m.includes('nothing to cancel') ||
    // O fim de captura do operador pode commitar um buffer que o VAD do
    // servidor já fechou (a parada local por silêncio é mais rápida que a
    // volta do frame de VAD). O commit vazio que volta disso é inofensivo —
    // quem responde já foi pedido em seguida.
    m.includes('input_audio_buffer_commit_empty') ||
    (m.includes('buffer too small') && m.includes('audio buffer'))
  );
}

/**
 * Motivo legível de um erro de socket, sem vazar o texto cru.
 *
 * `ws` reporta handshake recusado como "Unexpected server response: 404"; o
 * provider reporta timeout e fechamento antes do setup com frases próprias. O
 * classificador existe para transformar isso numa CATEGORIA — o texto original
 * pode conter payload do provedor e nunca vai para o log nem para a tela.
 */
function errorMessageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object' && 'message' in err) {
    const message = (err as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return typeof err === 'string' ? err : '';
}

const HTTP_STATUS_PATTERN = /(?:unexpected server response|response|status|http)\D{0,16}(\d{3})\b/;

export function httpStatusFromMessage(message: string): number | undefined {
  const match = HTTP_STATUS_PATTERN.exec(message);
  if (!match) return undefined;
  const status = Number(match[1]);
  return status >= 100 && status <= 599 ? status : undefined;
}

const AUTH_PATTERN =
  /\b(unauthorized|forbidden|invalid[_ ]?api[_ ]?key|incorrect api key|invalid authentication|permission[_ ]denied|missing api key|authentication)\b/;
const MODEL_PATTERN =
  /\b(model[_ ]not[_ ]found|unknown model|invalid model|model not found|does not exist|no such model|unsupported model)\b/;
const TIMEOUT_PATTERN = /\b(timeout|timed out|etimedout|setup timeout)\b/;
const CLOSED_PATTERN = /\bclosed before setup|closed before the session|abnormal closure|1006\b/;
const NETWORK_PATTERN =
  /\b(econnrefused|econnreset|enotfound|eai_again|epipe|enetunreach|ehostunreach|getaddrinfo|socket hang up|network error|net::err\w*|fetch failed)\b/;

/**
 * Classifica uma falha de conexão realtime numa categoria estável + status HTTP.
 * Puro: nenhum I/O, nenhum acesso ao erro original além da leitura da mensagem.
 *
 * Ordem importa. 401/403 é credencial antes de ser qualquer outra coisa; um 404
 * numa rota cujo path é fixo pelo provider significa modelo inexistente (foi
 * exatamente o `grok-voice-think-fast-2.0` pinado contra a doc da xAI); timeout
 * e fechamento pré-setup vêm antes de rede porque descrevem melhor a ação.
 */
export function classifyRealtimeConnectError(err: unknown): {
  category: RealtimeFailureCategory;
  status?: number;
} {
  const message = errorMessageOf(err);
  const status = httpStatusFromMessage(message);
  const m = message.toLowerCase();
  if (status === 401 || status === 403 || AUTH_PATTERN.test(m)) {
    return { category: 'auth_rejected', status };
  }
  if (status === 404 || MODEL_PATTERN.test(m) || (status === 400 && /model/.test(m))) {
    return { category: 'model_rejected', status };
  }
  if (TIMEOUT_PATTERN.test(m)) return { category: 'timeout', status };
  if (CLOSED_PATTERN.test(m)) return { category: 'closed_before_setup', status };
  if (NETWORK_PATTERN.test(m)) return { category: 'network', status };
  return { category: 'provider_error', status };
}

/**
 * Categoria para a sessão INTEIRA sem nenhum candidato: nenhuma rota chegou a
 * abrir socket. A distinção que importa é "não há chave nenhuma" (a pessoa
 * precisa configurar) vs "a chave consta e não decifra" (um problema de vault,
 * e pedir uma chave nova não resolve).
 */
export function noCandidateCategory(keyPresent: boolean): RealtimeFailureCategory {
  return keyPresent ? 'vault_unreadable' : 'no_key';
}

export function buildRealtimeFailure(
  category: RealtimeFailureCategory,
  provider: RealtimeFailure['provider'],
  at: number,
  extras: { model?: string; status?: number; attempts?: number } = {},
): RealtimeFailure {
  const failure: RealtimeFailure = {
    category,
    provider,
    attempts: extras.attempts ?? 1,
    at,
  };
  if (extras.model) failure.model = extras.model;
  if (extras.status !== undefined) failure.status = extras.status;
  return failure;
}

/** P5: heuristic — text that looks like a periodic screen snapshot vs tool result. */
export function isScreenContext(text: string): boolean {
  // peer ADE: [wake]/[reconexão] are speakable injectContext turns, not silent updates.
  if (text.startsWith('[wake]') || text.startsWith('[reconexão]')) return false;
  // Tool-result breadcrumbs look like "- tool: ok (...)" / "- tool: failed (...)".
  if (text.startsWith('- ') && (text.includes(': ok') || text.includes(': failed'))) {
    return false;
  }
  return true;
}

export function localToolCallId(kind: string, seq: number): string {
  return `${LOCAL_TOOL_CALL_PREFIX}${kind}:${seq}`;
}

export function trimLiveHistory(
  history: Array<{ role: 'user' | 'assistant'; text: string }>,
  maxTurns: number,
): Array<{ role: 'user' | 'assistant'; text: string }> {
  if (maxTurns <= 0) return [];
  const turns: Array<Array<{ role: 'user' | 'assistant'; text: string }>> = [];
  for (const entry of history) {
    const bounded = {
      role: entry.role,
      text: entry.text.trim().slice(0, MAX_LIVE_HISTORY_ENTRY_CHARS),
    };
    if (!bounded.text) continue;
    if (bounded.role === 'user') {
      turns.push([bounded]);
      continue;
    }
    // A resume prompt must never begin with an orphan assistant message.
    if (turns.length > 0) turns[turns.length - 1].push(bounded);
  }
  return turns.slice(-maxTurns).flat();
}

export function buildResumeContext(
  history: ReadonlyArray<{ role: 'user' | 'assistant'; text: string }>,
): string | null {
  if (history.length === 0) return null;
  const header = '[reconexão] Histórico recente:\n';
  const lines: string[] = [];
  let remaining = MAX_RESUME_CONTEXT_CHARS - header.length;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const entry = history[index];
    const line = `${entry.role === 'user' ? 'Usuário' : 'Jarvis'}: ${entry.text
      .trim()
      .slice(0, MAX_LIVE_HISTORY_ENTRY_CHARS)}`;
    const cost = line.length + (lines.length > 0 ? 1 : 0);
    if (cost > remaining) break;
    lines.unshift(line);
    remaining -= cost;
  }
  if (lines.length === 0) return null;
  // If truncation lands on an assistant, drop it instead of inventing an
  // assistant-first conversation boundary.
  while (lines[0]?.startsWith('Jarvis: ')) lines.shift();
  return lines.length > 0 ? `${header}${lines.join('\n')}` : null;
}
