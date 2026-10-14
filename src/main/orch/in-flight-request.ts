/**
 * F-1482: os últimos pedidos entregues a cada pane — brief, `nexus_pane_write`,
 * direção do operador ao Maestro, handoff colado no pai. Na troca de conta ou
 * de CLI o pacote de continuidade os reentrega em vez de perdê-los.
 *
 * Só memória do Main, por paneId (o pane do renderer e o orquestrador religam
 * no MESMO pane; o worker headless leva os pedidos ao pane novo com
 * `carryInFlightRequests`). Nunca vai para disco, log ou trace; o pacote passa
 * o texto pelo redator de segredos e pela neutralização do detector.
 */
import { FAILOVER_HANDOFF_HEADER, MAX_IN_FLIGHT_REQUEST_CHARS } from '../../shared/failover-handoff';

/** Pedidos lembrados por pane (o mais recente por último). */
const KEEP_PER_PANE = 3;
const MAX_CHARS_PER_REQUEST = 4_000;
const MAX_PANES = 1_024;

const requestsByPane = new Map<string, string[]>();

/** Pedido entregue e aceito. O pacote/nota do próprio failover não conta. */
export function noteInFlightRequest(paneId: string | undefined, prompt: string): void {
  const text = prompt.trim();
  if (!paneId || !text || text.includes(FAILOVER_HANDOFF_HEADER)) return;
  const kept = (requestsByPane.get(paneId) ?? []).filter((entry) => entry !== text);
  kept.push(text.slice(0, MAX_CHARS_PER_REQUEST));
  requestsByPane.delete(paneId);
  requestsByPane.set(paneId, kept.slice(-KEEP_PER_PANE));
  while (requestsByPane.size > MAX_PANES) {
    const oldest = requestsByPane.keys().next().value;
    if (oldest === undefined) break;
    requestsByPane.delete(oldest);
  }
}

/** Anterior que não cabe nem com isto fica de fora (ruído, não contexto). */
const MIN_EARLIER_CHARS = 24;

/**
 * Pedidos em voo do pane, do MAIS RECENTE para o mais antigo e dentro de
 * `budget`: o mais recente vai inteiro (até o teto) e o que sobra é dos
 * anteriores — o mais antigo é o primeiro a ser cortado. Undefined sem pedido.
 */
export function inFlightRequestOf(
  paneId: string | undefined,
  budget = MAX_IN_FLIGHT_REQUEST_CHARS,
): string | undefined {
  const kept = paneId ? requestsByPane.get(paneId) : undefined;
  if (!kept?.length) return undefined;
  const [latest, ...earlier] = [...kept].reverse();
  if (!earlier.length) return clipTo(latest!, budget);
  const LATEST = 'Latest: ';
  let text = `${LATEST}${clipTo(latest!, budget - LATEST.length)}`;
  for (const [index, entry] of earlier.entries()) {
    const prefix = index === 0 ? ' | Earlier: ' : ' | ';
    const room = budget - text.length - prefix.length;
    if (room < MIN_EARLIER_CHARS) break;
    text += `${prefix}${clipTo(entry, room)}`;
  }
  return text;
}

function clipTo(raw: string, max: number): string {
  const text = raw.replace(/\s+/g, ' ').trim();
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

/** F-1512: cópia dos pedidos lembrados do pane (o mais recente por último). */
export function inFlightRequestsOf(paneId: string | undefined): readonly string[] {
  return paneId ? [...(requestsByPane.get(paneId) ?? [])] : [];
}

/** O pane novo do respawn herda os pedidos do pane que parou. */
export function carryInFlightRequests(fromPaneId: string, toPaneId: string | undefined): void {
  const kept = requestsByPane.get(fromPaneId);
  if (!toPaneId || !kept?.length || toPaneId === fromPaneId) return;
  for (const entry of kept) noteInFlightRequest(toPaneId, entry);
}

export function resetInFlightRequestsForTests(): void {
  requestsByPane.clear();
}
