/**
 * F-765/F-775: o pedido de spawn de um pane de TAREFA (worker de missão ou
 * helper do operador), guardado enquanto o pane vive — não só na janela de
 * início do F-723.
 *
 * Quando religar no lugar é impossível — o renderer não religa pane de missão
 * viva (quem manda nele é o Main) e a CLI inteira pode ficar sem conta — o
 * failover reabre o MESMO pedido pela rota do `nexus_pane_spawn`, com a
 * autoridade ATUAL de quem pediu: especialidade, capacidade, roster,
 * disjuntores e cota valem de novo, e CLI que não pode fazer a tarefa não a
 * recebe. O pedido (com o brief) fica só na memória do Main: nunca vai para
 * disco, log, trace, evento ou handoff.
 */
import type { PaneStartRerouteResult } from './pane-start-watchdog';

export interface PaneTaskRerouteRequest {
  /** CLIs fora da rota (a que falhou, quando trocar de CLI é a saída). */
  readonly excludeAdapterIds: readonly string[];
  /** Preferência suave da rota (bônus no multi-score), nunca pin nem exclusão. */
  readonly preferAdapterIds?: readonly string[];
  /** Texto do Nexus anexado ao brief original (pacote de continuidade). */
  readonly appendPrompt?: string;
}

export interface PaneTaskRerouteHandle {
  readonly paneId: string;
  readonly adapterId: string;
  readonly missionId?: string;
  readonly role: 'worker' | 'helper';
  /** F-231: pane aberto pelo operador — a máquina nunca o troca. */
  readonly operatorOpened: boolean;
  /** CLI pedida pelo operador (ou conversa retomada): troca nunca é sozinha. */
  readonly pinnedRuntime: boolean;
  /** 0 = pedido original; n = n-ésima reabertura automática do mesmo pedido. */
  readonly generation: number;
  readonly reroute: (request: PaneTaskRerouteRequest) => Promise<PaneStartRerouteResult>;
  /** Há CLI, fora destas, que poderia receber a tarefa? (aproximação barata) */
  readonly hasAlternative: (excludeAdapterIds: readonly string[]) => boolean;
}

/** Teto de reaberturas automáticas encadeadas do mesmo pedido: sem cascata. */
export const MAX_PANE_TASK_REROUTES = 2;
const HANDLE_TTL_MS = 24 * 60 * 60_000;
const MAX_HANDLES = 256;

const handles = new Map<string, { readonly handle: PaneTaskRerouteHandle; readonly at: number }>();

export function registerPaneTaskReroute(
  handle: PaneTaskRerouteHandle,
  now: number = Date.now(),
): void {
  handles.delete(handle.paneId);
  handles.set(handle.paneId, { handle, at: now });
  // Ordem de inserção = idade: poda os mais velhos (vencidos ou além do teto).
  for (const [paneId, entry] of handles) {
    if (handles.size <= MAX_HANDLES && now - entry.at < HANDLE_TTL_MS) break;
    handles.delete(paneId);
  }
}

export function getPaneTaskReroute(
  paneId: string,
  now: number = Date.now(),
): PaneTaskRerouteHandle | null {
  const entry = handles.get(paneId);
  if (!entry) return null;
  if (now - entry.at >= HANDLE_TTL_MS) {
    handles.delete(paneId);
    return null;
  }
  return entry.handle;
}

export function forgetPaneTaskReroute(paneId: string): void {
  handles.delete(paneId);
}

export type PaneTaskRerouteBlocker = 'no-request' | 'operator' | 'pinned' | 'chain-limit';

/**
 * Por que o failover NÃO pode reabrir a tarefa sozinho (null = pode). A rota
 * do spawn solta o pin de CLI, então CLI pedida pelo operador nunca passa.
 */
export function paneTaskRerouteBlocker(
  handle: PaneTaskRerouteHandle | null,
): PaneTaskRerouteBlocker | null {
  if (!handle) return 'no-request';
  if (handle.operatorOpened) return 'operator';
  if (handle.pinnedRuntime) return 'pinned';
  if (handle.generation >= MAX_PANE_TASK_REROUTES) return 'chain-limit';
  return null;
}

export function resetPaneTaskReroutesForTests(): void {
  handles.clear();
}
