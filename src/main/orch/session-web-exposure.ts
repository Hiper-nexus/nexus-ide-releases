/**
 * F-808: sessões expostas a conteúdo de terceiros (navegador do Nexus, busca
 * web, fetch de URL). O que uma dessas sessões grava em `nexus_memory_retain`
 * fica em quarentena — nunca entra em brief sem promoção pelo operador: o
 * texto de uma página não pode virar "pegadinha" injetada em todo worker.
 *
 * Só o rótulo da tool entra aqui (observer-tool-kind), nunca argumento, URL
 * ou saída. Memória de processo, limitada: uma sessão marcada fica marcada
 * até o fim do processo (a exposição não "passa").
 */
import { observerToolKind } from './observer-tool-kind';

const MAX_TRACKED_SESSIONS = 4_096;
const exposed = new Map<string, number>();
let exposureOverflow = false;

const EXPOSING_KINDS: ReadonlySet<string> = new Set(['nexus-browser', 'web-search', 'fetch']);

/** Marca a sessão quando a tool chamada alcança a web; devolve se marcou. */
export function noteSessionToolCall(
  sessionId: string | null | undefined,
  toolName: unknown,
  declaredKind?: unknown,
): boolean {
  if (!sessionId) return false;
  const kind = observerToolKind(toolName, declaredKind);
  if (!kind || !EXPOSING_KINDS.has(kind)) return false;
  markSessionWebExposed(sessionId);
  return true;
}

export function markSessionWebExposed(sessionId: string): void {
  if (exposed.size >= MAX_TRACKED_SESSIONS && !exposed.has(sessionId)) {
    // Esquecer exposição de sessão ainda viva elevaria conteúdo de terceiros.
    // Mantém a memória limitada e quarentena as sessões sem prova até reiniciar.
    exposureOverflow = true;
    return;
  }
  exposed.set(sessionId, Date.now());
}

export function isSessionWebExposed(sessionId: string | null | undefined): boolean {
  return Boolean(sessionId && (exposureOverflow || exposed.has(sessionId)));
}

/** Test-only. */
export function __resetSessionWebExposureForTests(): void {
  exposed.clear();
  exposureOverflow = false;
}
