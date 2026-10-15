/**
 * F-1531: idempotência do `nexus_pane_spawn` por `requestId`.
 *
 * Campo 14/10: quatro chamadas seguidas estouraram os 120 s do cliente MCP com o
 * Main sob carga. Os panes NASCIAM — o aviso de falha era falso. O Maestro,
 *Ao ver a falha, repetiu o pedido e criou DUPLICATA (cada pane de agente custa
 * 0,5–1 GB, AGENTS.md F-572) ou perdeu a tarefa.
 *
 * Aqui mora só a regra: um `requestId` é um pedido, não uma tentativa. Quem
 * chama com o mesmo `requestId` recebe o MESMO pane — nunca um segundo. A
 * resposta do primeiro pedido fica guardada em memória pelo prazo do grant
 * (`ORCH_SPAWN_GRANT_TTL_MS`, 30 min): nesse intervalo o resultado verdadeiro é
 * consultável por `requestId`, mesmo que o cliente já tenha desistido.
 *
 * Por que não é o grant do `pane-registry`: o grant é Main-owned e carrega
 * autoridade (dono, sessão, escopo). Esta tabela NÃO concede nada — ela só
 * impede que o mesmo pedido abra dois panes. A autoridade do pane continua
 * exclusivamente no grant; aqui moram requestId, paneId, sessionId e um
 * desfecho, nada de brief, rota ou credencial.
 *
 * Falha libera a chave: uma recusa de verdade (admissão, argv, CLI morta) tem
 * que poder ser refeita pelo chamador. Fixar a chave num pedido que morreu
 * devolveria um pane morto para sempre.
 */
import { ORCH_SPAWN_GRANT_TTL_MS } from './orch-spawn-grant-recovery';

/** Teto de pedidos guardados; descarta os mais antigos (memória do Main). */
const MAX_TRACKED_REQUESTS = 256;

/**
 * Charset aceito para o `requestId` do chamador. O id entra em log, trace e
 * aviso: nada de quebra de linha, controle ou texto livre. O `requestId` do
 * Main (`orchspawn-*`) também passa aqui sem colisão: o prefixo é gerado no
 * Main, o do chamador não pode começar com ele (ver `validCallerRequestId`).
 */
const CALLER_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const MAIN_REQUEST_ID_PREFIX = 'orchspawn-';

export type PaneSpawnRequestOutcome = 'pending' | 'live';

export interface PaneSpawnRequestState {
  readonly requestId: string;
  /**
   * `null` enquanto o preparo pesado roda (rota, worktree, credencial) — é
   * exatamente a janela em que o cliente MCP estoura o prazo (F-1531). O pane
   * ainda não existe, e o recibo diz isso em vez de inventar id.
   */
  readonly paneId: string | null;
  readonly sessionId: string | null;
  /** `pending` = ACK pendente (ainda sem sessão); `live` = sessão vinculada. */
  readonly outcome: PaneSpawnRequestOutcome | 'in-flight';
  readonly at: number;
  /** Resposta já devolvida ao chamador (evita divergir do que ele viu). */
  readonly receipt: Readonly<Record<string, unknown>>;
}

interface TrackedRequest {
  state: PaneSpawnRequestState;
}

const requests = new Map<string, TrackedRequest>();

/**
 * Valida o `requestId` que o chamador mandou. `null` = não mandou (compatível
 * com toda chamada antiga, que fica sem idempotência).
 * Recusa o que não é id: devolve um textoPronto para o chamador, sem stack.
 */
export function validCallerRequestId(
  value: unknown,
): { ok: true; requestId: null | string } | { ok: false; error: string } {
  if (value === undefined || value === null || value === '') return { ok: true, requestId: null };
  if (typeof value !== 'string') {
    return {
      ok: false,
      error:
        'requestId inválido: use texto curto (letras, números, ponto, hífen, ' +
        'underscore ou dois-pontos, até 120 caracteres).',
    };
  }
  const requestId = value.trim();
  if (!CALLER_REQUEST_ID.test(requestId)) {
    return {
      ok: false,
      error:
        'requestId inválido: use texto curto (letras, números, ponto, hífen, ' +
        'underscore ou dois-pontos, até 120 caracteres).',
    };
  }
  // O prefixo do Main é gerado aqui dentro; um id do chamador com esse prefixo
  // poderia se passar por grant emitido pelo Main.
  if (requestId.startsWith(MAIN_REQUEST_ID_PREFIX)) {
    return {
      ok: false,
      error: 'requestId inválido: o prefixo "orchspawn-" é do Nexus. Use o seu próprio id.',
    };
  }
  return { ok: true, requestId };
}

function pruneExpired(now: number): void {
  for (const [requestId, tracked] of requests) {
    if (now - tracked.state.at >= ORCH_SPAWN_GRANT_TTL_MS) requests.delete(requestId);
  }
  while (requests.size > MAX_TRACKED_REQUESTS) {
    const oldest = requests.keys().next().value;
    if (oldest === undefined) break;
    requests.delete(oldest);
  }
}

/**
 * Reserva o `requestId` para este pedido.
 * - `fresh`: nobody else owns it — the caller may spawn.
 * - `joined`: there IS a request with this id (in flight or with a live pane);
 *   the caller must NOT spawn, it must return the existing receipt.
 */
export function beginPaneSpawnRequest(input: {
  readonly requestId: string;
  readonly paneId?: string | null;
  readonly receipt?: Readonly<Record<string, unknown>>;
  readonly now?: number;
}): { kind: 'fresh' } | { kind: 'joined'; existing: PaneSpawnRequestState } {
  const now = input.now ?? Date.now();
  pruneExpired(now);
  const existing = requests.get(input.requestId);
  if (existing) return { kind: 'joined', existing: existing.state };
  requests.set(input.requestId, {
    state: {
      requestId: input.requestId,
      paneId: input.paneId ?? null,
      sessionId: null,
      outcome: input.paneId ? 'pending' : 'in-flight',
      at: now,
      receipt: input.receipt ?? {},
    },
  });
  return { kind: 'fresh' };
}

/**
 * O pane nasceu: `paneId` (e, quando houver, `sessionId`) deixam de ser
 * desconhecidos e o recibo passa a ser o que o chamador levou.
 */
export function settlePaneSpawnRequest(input: {
  readonly requestId: string;
  readonly paneId: string;
  readonly sessionId: string | null;
  readonly receipt?: Readonly<Record<string, unknown>>;
  readonly now?: number;
}): PaneSpawnRequestState | null {
  const now = input.now ?? Date.now();
  const tracked = requests.get(input.requestId);
  // Só a tentativa dona da chave pode liquidá-la.
  if (!tracked) return null;
  if (tracked.state.paneId !== null && tracked.state.paneId !== input.paneId) return null;
  tracked.state = {
    ...tracked.state,
    paneId: input.paneId,
    sessionId: input.sessionId,
    outcome: input.sessionId ? 'live' : 'pending',
    at: now,
    ...(input.receipt ? { receipt: input.receipt } : {}),
  };
  return tracked.state;
}

/**
 * O pedido MORREU (recusa de admissão, argv, CLI que não subiu): libera a
 * chave para o chamador tentar de novo. `paneId` só libera se for a mesma
 * tentativa — uma reabertura automática (F-723/F-1534) tem id próprio.
 */
export function releasePaneSpawnRequest(input: {
  readonly requestId: string;
  readonly paneId?: string;
}): boolean {
  const tracked = requests.get(input.requestId);
  if (!tracked) return false;
  if (input.paneId !== undefined && tracked.state.paneId !== input.paneId) return false;
  requests.delete(input.requestId);
  return true;
}

/** Estado atual do pedido por `requestId` (null = nunca visto / vencido). */
export function paneSpawnRequestState(
  requestId: string,
  now: number = Date.now(),
): PaneSpawnRequestState | null {
  pruneExpired(now);
  return requests.get(requestId)?.state ?? null;
}

/**
 * O que o chamador recebe quando reenvia um `requestId` já em uso: o recibo
 * do primeiro pedido, marcado como deduplicado. Enquanto o preparo pesado
 * roda (`in-flight`), o recibo diz que o pane ainda não nasceu — em vez de
 * inventar id. Reenviar de novo é grátis e não abre duplicata.
 */
export function joinedPaneSpawnReceipt(existing: PaneSpawnRequestState): Record<string, unknown> {
  const inFlight = existing.outcome === 'in-flight';
  return {
    ...existing.receipt,
    requestId: existing.requestId,
    paneId: existing.paneId,
    sessionId: existing.sessionId,
    deduplicated: true,
    ...(inFlight
      ? {
          ok: true,
          pending: true,
          inFlight: true,
          note:
            'Este requestId já tem um spawn em andamento no Nexus; nenhum pane ' +
            'novo foi aberto. Reenvie o mesmo requestId em instantes para ' +
            'receber o pane.',
        }
      : {}),
  };
}

/** Só para teste. */
export function resetPaneSpawnRequestsForTests(): void {
  requests.clear();
}