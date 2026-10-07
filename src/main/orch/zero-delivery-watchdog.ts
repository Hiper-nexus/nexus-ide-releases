/**
 * Watchdog de zero entrega: missão running, workers presentes, 0 handoffs de
 * worker — o Maestro "dormiu aguardando handoff" e o disco ficou vazio.
 * Poke curto; não depende de morte de processo.
 *
 * F-960: o relógio é a ATIVIDADE real dos workers (saída do PTY, turno aberto,
 * chamadas de ferramenta), não o disco. Worker ocupado nunca dispara poke nem
 * escalada; estudo somente leitura (que por definição não grava arquivo) ganha
 * prazo de estudo longo e a mensagem nunca manda fechar pane ocupado.
 */

export const ZERO_DELIVERY_POKE_MS = 3 * 60_000;
export const ZERO_DELIVERY_ESCALATE_MS = 8 * 60_000;
/** Escritor: a escalada exige workers sem nenhuma atividade por esta janela. */
export const ZERO_DELIVERY_WRITER_QUIET_ESCALATE_MS = 3 * 60_000;
/** Somente leitura: poke só depois de tanto tempo SEM atividade nenhuma. */
export const ZERO_DELIVERY_READONLY_POKE_QUIET_MS = 10 * 60_000;
/** Somente leitura: escalada só depois de tanto tempo SEM atividade nenhuma. */
export const ZERO_DELIVERY_READONLY_ESCALATE_QUIET_MS = 20 * 60_000;
/** Status semântico `working` conta como atividade enquanto for mais novo que isto. */
export const ZERO_DELIVERY_SEMANTIC_ACTIVE_MS = 5 * 60_000;

export type ZeroDeliveryDecision =
  | { readonly action: 'none' }
  | {
      readonly action: 'poke';
      readonly sinceMs: number;
      readonly quietMs: number;
      readonly readOnly: boolean;
    }
  | {
      readonly action: 'escalate';
      readonly sinceMs: number;
      readonly quietMs: number;
      readonly readOnly: boolean;
    };

/** Atividade agregada dos workers vivos da missão. */
export interface ZeroDeliveryWorkerActivity {
  /** Algum worker está trabalhando AGORA (PTY busy, turno fresco, ferramenta nova). */
  readonly anyActive: boolean;
  /** Último instante (epoch ms) com evidência de atividade de qualquer worker. */
  readonly lastActivityAt: number | null;
  /** Todos os workers são somente leitura (estudo/revisão: não gravam arquivo). */
  readonly allReadOnly: boolean;
}

export interface ZeroDeliveryWorkerSample {
  readonly sessionId?: string | null;
  readonly state: string;
  readonly readOnly?: boolean;
}

/** Última atividade observada por sessão (o supervisor guarda entre varreduras). */
export interface ZeroDeliverySeen {
  readonly activeAt: number;
  readonly toolCount: number;
}

/**
 * Agrega a atividade real dos workers. Puro: o chamador injeta o status
 * semântico, a contagem de ferramentas e a memória da varredura anterior; a
 * memória atualizada volta em `seen` para ser gravada.
 */
export function zeroDeliveryWorkerActivity(input: {
  readonly workers: readonly ZeroDeliveryWorkerSample[];
  readonly now: number;
  readonly semanticStatus: (
    sessionId: string,
  ) => { readonly status: string; readonly updatedAt: number } | null;
  readonly toolActivityCount: (sessionId: string) => number;
  readonly previous: (sessionId: string) => ZeroDeliverySeen | undefined;
}): ZeroDeliveryWorkerActivity & {
  readonly seen: ReadonlyMap<string, ZeroDeliverySeen>;
} {
  let anyActive = false;
  let lastActivityAt: number | null = null;
  const seen = new Map<string, ZeroDeliverySeen>();
  const note = (at: number | null | undefined) => {
    if (typeof at === 'number' && Number.isFinite(at) && at <= input.now) {
      lastActivityAt = lastActivityAt === null ? at : Math.max(lastActivityAt, at);
    }
  };
  for (const worker of input.workers) {
    // PTY busy/spawning = saída recente do terminal (spinner, leitura de código).
    let active = worker.state === 'busy' || worker.state === 'spawning';
    const sessionId = worker.sessionId?.trim();
    if (sessionId) {
      const semantic = input.semanticStatus(sessionId);
      if (semantic) {
        note(semantic.updatedAt);
        if (
          semantic.status === 'working' &&
          input.now - semantic.updatedAt < ZERO_DELIVERY_SEMANTIC_ACTIVE_MS
        ) {
          active = true;
        }
      }
      const toolCount = input.toolActivityCount(sessionId);
      const previous = input.previous(sessionId);
      // Ferramenta nova desde a última varredura é trabalho, mesmo com PTY quieto.
      if (previous && toolCount > previous.toolCount) active = true;
      note(previous?.activeAt);
      const activeAt = active ? input.now : (previous?.activeAt ?? 0);
      seen.set(sessionId, { activeAt, toolCount });
    }
    if (active) {
      anyActive = true;
      note(input.now);
    }
  }
  return {
    anyActive,
    lastActivityAt,
    allReadOnly:
      input.workers.length > 0 &&
      input.workers.every((worker) => worker.readOnly === true),
    seen,
  };
}

export function decideZeroDeliveryWatchdog(input: {
  readonly missionStatus: string;
  readonly lane?: string | null;
  readonly workerPanes: number;
  /** Handoffs submetidos por workers (não supervisor/sistema). */
  readonly workerHandoffCount: number;
  readonly orchestratorState?: string | null;
  /** Epoch ms do despacho / início de execução (não arm). */
  readonly executingSinceMs: number | null;
  readonly now: number;
  /** Já houve poke de zero-entrega nesta missão. */
  readonly alreadyPoked: boolean;
  /** F-960: atividade real dos workers; ausente = sem evidência (parados). */
  readonly workerActivity?: ZeroDeliveryWorkerActivity;
}): ZeroDeliveryDecision {
  if (input.missionStatus !== 'running' && input.missionStatus !== 'pending') {
    return { action: 'none' };
  }
  if (input.lane === 'plan' || input.lane === 'consult') {
    return { action: 'none' };
  }
  if (input.workerPanes <= 0) return { action: 'none' };
  if (input.workerHandoffCount > 0) return { action: 'none' };
  if (input.executingSinceMs == null) return { action: 'none' };
  // Maestro busy ainda pode estar despachando — não interromper.
  if (
    input.orchestratorState === 'busy' ||
    input.orchestratorState === 'spawning'
  ) {
    return { action: 'none' };
  }
  const activity = input.workerActivity;
  // Worker trabalhando (lendo código, rodando ferramenta) não é zero entrega:
  // é entrega em curso. Nem poke nem escalada.
  if (activity?.anyActive) return { action: 'none' };
  const since = input.now - input.executingSinceMs;
  const quietSince = Math.max(
    input.executingSinceMs,
    activity?.lastActivityAt ?? input.executingSinceMs,
  );
  const quiet = Math.max(0, input.now - quietSince);
  const readOnly = activity?.allReadOnly === true;
  if (readOnly) {
    // Estudo não grava arquivo: disco vazio não é sinal. Só o silêncio longo é.
    if (quiet < ZERO_DELIVERY_READONLY_POKE_QUIET_MS) return { action: 'none' };
    if (!input.alreadyPoked) {
      return { action: 'poke', sinceMs: since, quietMs: quiet, readOnly };
    }
    if (quiet >= ZERO_DELIVERY_READONLY_ESCALATE_QUIET_MS) {
      return { action: 'escalate', sinceMs: since, quietMs: quiet, readOnly };
    }
    return { action: 'none' };
  }
  if (since < ZERO_DELIVERY_POKE_MS) return { action: 'none' };
  if (!input.alreadyPoked) {
    return { action: 'poke', sinceMs: since, quietMs: quiet, readOnly };
  }
  if (
    since >= ZERO_DELIVERY_ESCALATE_MS &&
    quiet >= ZERO_DELIVERY_WRITER_QUIET_ESCALATE_MS
  ) {
    return { action: 'escalate', sinceMs: since, quietMs: quiet, readOnly };
  }
  return { action: 'none' };
}

function minutesOf(ms: number): number {
  return Math.max(1, Math.round(ms / 60_000));
}

export function zeroDeliveryPokeSummary(
  missionId: string,
  sinceMs: number,
  options: { readonly readOnly?: boolean; readonly quietMs?: number } = {},
): string {
  const minutes = minutesOf(sinceMs);
  if (options.readOnly) {
    return (
      `[zero-delivery:${missionId}] Sem handoff após ${minutes}min e os ` +
      `workers somente leitura estão sem atividade há ` +
      `${minutesOf(options.quietMs ?? sinceMs)}min (sem saída nem ferramenta). ` +
      'Estudo não grava arquivos: disco vazio não é sinal. Leia o pane ' +
      '(nexus_pane_read) antes de decidir; se ele perguntou algo ao operador, ' +
      'responda "não pergunte, decida e entregue o handoff".'
    );
  }
  return (
    `[zero-delivery:${missionId}] Sem handoff nem arquivos após ${minutes}min ` +
    'e os workers estão sem atividade. ' +
    'O trabalhador não entregou. Se ele perguntou cor/fonte ao operador, isso é ' +
    'bloqueio — reabra com "não pergunte, decida e entregue handoff com arquivos". ' +
    'Peça arquivos disjuntos no MESMO turno (files=) e não encerre sem prova de entrega.'
  );
}

export function zeroDeliveryEscalateSummary(
  missionId: string,
  options: { readonly readOnly?: boolean; readonly quietMs?: number } = {},
): string {
  const quiet =
    options.quietMs !== undefined ? ` há ${minutesOf(options.quietMs)}min` : '';
  const what = options.readOnly
    ? 'Estudo somente leitura: falta o handoff, não arquivos. '
    : '';
  return (
    `[zero-delivery-escalate:${missionId}] Zero entrega e workers sem ` +
    `atividade${quiet} (sem saída, sem ferramenta, sem turno aberto). ${what}` +
    'Leia o pane (nexus_pane_read) para confirmar: só se ele estiver de fato ' +
    'parado ou morto, feche-o, re-roteie para Claude ou Codex e spawne de novo ' +
    'com o pedido completo. Pane ocupado está trabalhando: nunca feche pane busy.'
  );
}
