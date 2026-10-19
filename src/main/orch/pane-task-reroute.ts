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
import { MAX_START_REROUTES, type PaneStartRerouteResult } from './pane-start-watchdog';

export interface PaneTaskRerouteRequest {
  /** CLIs fora da rota (a que falhou, quando trocar de CLI é a saída). */
  readonly excludeAdapterIds: readonly string[];
  /** Preferência suave da rota (bônus no multi-score), nunca pin nem exclusão. */
  readonly preferAdapterIds?: readonly string[];
  /** Texto do Nexus anexado ao brief original (pacote de continuidade). */
  readonly appendPrompt?: string;
  /**
   * F-775: o pane novo continua na worktree isolada do pane parado (o
   * trabalho não commitado está lá) — sem retomar a conversa do provedor.
   */
  readonly worktreeFromPaneId?: string;
  /**
   * F-1471: troca de CONTA, não de CLI — a conta do pane esgotou e o failover
   * preparou a irmã do mesmo provedor. A tarefa reabre na MESMA CLI (a rota
   * só pode devolvê-la; agente do roster é o mesmo) com a irmã como pin do
   * spawn, e a cadeia de reaberturas não avança. `excludeAdapterIds` não vale.
   * `model`: o do pane anterior — a rota o mantém quando a CLI o oferece.
   */
  readonly sameAdapter?: {
    readonly adapterId: string;
    readonly accountId: string;
    readonly model?: string;
  };
  /**
   * F-1473: com `sameAdapter`, o histórico da CLI atravessa as contas e a
   * conversa de `fromPaneId` já é da irmã — o pane novo a retoma (`--resume`)
   * e recebe só `note`, nem o brief nem o pacote.
   */
  readonly nativeResume?: { readonly fromPaneId: string; readonly note: string };
}

export interface PaneTaskRerouteHandle {
  readonly paneId: string;
  readonly adapterId: string;
  readonly missionId?: string;
  readonly role: 'worker' | 'helper';
  /** Quem pediu o pane (Maestro ou pane do operador): autoridade da rota. */
  readonly callerSessionId: string;
  /** Texto que roteia a tarefa (task ?? prompt ?? title), nunca exposto. */
  readonly routeTask: string | null;
  /** Pane do pedido ORIGINAL: as reaberturas encadeadas são a mesma tarefa. */
  readonly lineageId: string;
  /** F-231: pane aberto pelo operador — a máquina nunca o troca. */
  readonly operatorOpened: boolean;
  /** CLI pedida pelo operador ou conversa retomada: o failover não troca sozinho. */
  readonly pinnedRuntime: boolean;
  /**
   * CLI que o operador escolheu. Retomada sozinha é `false`. Ausente: handle
   * antigo, e `pinnedRuntime` continua decidindo.
   */
  readonly operatorPinned?: boolean;
  /** 0 = pedido original; n = n-ésima reabertura automática do mesmo pedido. */
  readonly generation: number;
  /**
   * F-1471: writer — dono do checkout/worktree em que roda (a delegação no
   * mesmo checkout é serializada e a worktree isolada aceita um pane só). O
   * sucessor só entra depois de ele sair; ausente = writer (conservador).
   */
  readonly exclusiveCheckout?: boolean;
  readonly reroute: (request: PaneTaskRerouteRequest) => Promise<PaneStartRerouteResult>;
  /** Há CLI, fora destas, que poderia receber a tarefa? (aproximação barata) */
  readonly hasAlternative: (excludeAdapterIds: readonly string[]) => boolean;
}

/**
 * Teto de reaberturas automáticas encadeadas do mesmo pedido: sem cascata.
 * F-1414: o mesmo teto vale para o watchdog de início (MAX_START_REROUTES).
 */
export const MAX_PANE_TASK_REROUTES = MAX_START_REROUTES;
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

/** F-775: a próxima CLI escolhida pela rota (sem spawnar nada). */
export interface NextCliRoute {
  readonly adapterId: string;
  readonly model?: string;
  readonly effort?: string;
}

export type NextCliResolver = (request: {
  /** Sessão com autoridade de rota: o Maestro da missão ou o pane do operador. */
  readonly callerSessionId: string;
  readonly task: string;
  /** CLIs fora (a esgotada e as que seguem sem conta livre). */
  readonly excludeAdapterIds: readonly string[];
  readonly preferAdapterIds?: readonly string[];
}) => Promise<NextCliRoute | null>;

let nextCliResolver: NextCliResolver | null = null;

/**
 * Registrado por quem tem a rota do `nexus_pane_spawn` (tools-panes): o
 * failover pede "qual a próxima CLI para esta tarefa" pelo MESMO roteador —
 * especialidade, capacidade, diversidade, cota e login — sem importar o grafo
 * de ferramentas MCP.
 */
export function setNextCliResolver(resolver: NextCliResolver | null): void {
  nextCliResolver = resolver;
}

export function hasNextCliResolver(): boolean {
  return nextCliResolver !== null;
}

export async function resolveNextCli(
  request: Parameters<NextCliResolver>[0],
): Promise<NextCliRoute | null> {
  if (!nextCliResolver) return null;
  try {
    return await nextCliResolver(request);
  } catch {
    return null;
  }
}

export function resetPaneTaskReroutesForTests(): void {
  handles.clear();
}
