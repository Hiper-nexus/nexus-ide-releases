import type { MissionEvent } from '../../shared/mission-events';

/**
 * F-1005: o quadro mostra a janela recente do journal (o Main pagina) e, se o
 * operador pediu, páginas anteriores. Uma atualização traz de novo só a janela
 * recente; as páginas antigas continuam se encostarem nela sem buraco — com
 * buraco (chegaram mais eventos do que cabe na janela) elas saem, e o "carregar
 * mais" volta a valer a partir da janela nova.
 *
 * `current` e `recent` vêm ordenados por sequência crescente.
 */
export function mergeRecentJournalWindow(
  current: readonly MissionEvent[],
  recent: readonly MissionEvent[],
): { readonly events: MissionEvent[]; readonly keptOlder: boolean } {
  const first = recent[0];
  if (!first) return { events: [...recent], keptOlder: false };
  const older = current.filter((event) => event.sequence < first.sequence);
  const newestOlder = older[older.length - 1];
  if (!newestOlder || newestOlder.sequence < first.sequence - 1) {
    return { events: [...recent], keptOlder: false };
  }
  return { events: [...older, ...recent], keptOlder: true };
}

/** Junta uma página anterior (já pedida antes de `current[0]`) na frente. */
export function prependOlderJournalPage(
  current: readonly MissionEvent[],
  older: readonly MissionEvent[],
): MissionEvent[] {
  const first = current[0];
  if (!first) return [...older];
  return [...older.filter((event) => event.sequence < first.sequence), ...current];
}
