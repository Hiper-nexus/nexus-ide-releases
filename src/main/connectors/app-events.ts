/**
 * Nexus Arms — eventos de aplicação com cursor (paridade Overclock 1.3.9
 * `app_events`). Um orquestrador externo precisa saber que um pane acabou
 * de spawnar ou que um handoff foi entregue SEM ler o conteúdo de terminal
 * — aqui entra só metadado: ids, estados e contagens. Nunca output, prompt,
 * segredo ou path de usuário.
 */

export type AppEventKind =
  | 'app.boot'
  | 'pane.spawned'
  | 'pane.exited'
  | 'handoff.submitted'
  | 'handoff.delivered'
  | 'handoff.consumed'
  | 'mission.state'
  | 'mission.completed'
  | 'arms.token';

export interface AppEvent {
  readonly seq: number;
  readonly at: number;
  readonly kind: AppEventKind;
  readonly payload: Readonly<Record<string, string | number | boolean | null>>;
}

const MAX_EVENTS = 512;
let nextSeq = 1;
let ring: AppEvent[] = [];
const listeners = new Set<(event: AppEvent) => void>();

export function emitAppEvent(
  kind: AppEventKind,
  payload: Readonly<Record<string, string | number | boolean | null>> = {},
  at = Date.now(),
): AppEvent {
  const event: AppEvent = Object.freeze({
    seq: nextSeq++,
    at,
    kind,
    payload: Object.freeze({ ...payload }),
  });
  ring.push(event);
  if (ring.length > MAX_EVENTS) {
    ring = ring.slice(ring.length - MAX_EVENTS);
  }
  for (const listener of [...listeners]) {
    try {
      listener(event);
    } catch {
      /* listener errante não pode derrubar o emissor */
    }
  }
  return event;
}

export interface AppEventsPage {
  readonly events: readonly AppEvent[];
  /** Cursor da próxima leitura (passe de volta em `after`). */
  readonly nextCursor: number;
  /** true quando o ring descartou eventos entre o cursor pedido e agora. */
  readonly truncated: boolean;
}

export function appEventsAfter(cursor: number): AppEventsPage {
  const safeCursor = Number.isInteger(cursor) && cursor >= 0 ? cursor : 0;
  const events = ring.filter((event) => event.seq > safeCursor);
  const oldest = ring[0]?.seq ?? 1;
  const truncated = safeCursor + 1 < oldest;
  return Object.freeze({
    events: Object.freeze(events),
    nextCursor: ring.length > 0 ? ring[ring.length - 1]!.seq : safeCursor,
    truncated,
  });
}

export function latestAppEventSeq(): number {
  return ring.length > 0 ? ring[ring.length - 1]!.seq : 0;
}

export function subscribeAppEvents(listener: (event: AppEvent) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Reinicializa o módulo entre testes (não usar em produção). */
export function resetAppEventsForTests(): void {
  nextSeq = 1;
  ring = [];
  listeners.clear();
}
