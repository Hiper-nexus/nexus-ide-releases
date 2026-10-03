/**
 * F-764 — saída de PTY entregue aos taps do Main em LOTE e com orçamento
 * (itens C.1 e o tempo por tap do A.3 do HANDOFF de 03/10).
 *
 * Antes: o pty-host posta cada chunk do node-pty como mensagem própria e o
 * Main chamava os 12 taps de dados, síncronos, para cada uma. Com 15 CLIs
 * repintando TUI, a fila de mensagens crescia mais rápido do que esvaziava e
 * a UI congelou por minutos.
 *
 * Agora os chunks de cada sessão se juntam e os taps recebem o texto
 * concatenado — mesma ordem, mesmo conteúdo — no fim da janela (~16 ms), ou na
 * hora quando o lote passa de 32 KB. Tudo o que muda a leitura de um tap
 * esvazia o lote ANTES de acontecer (o pty-manager chama `flush`): troca de
 * estado da sessão, escrita no PTY, início do encerramento e saída; e o
 * próprio registro/remoção de um tap esvazia todos os lotes. Assim cada tap
 * continua vendo exatamente a saída que chegou enquanto estava registrado, na
 * mesma ordem relativa aos eventos do Main — só mais tarde (≤ 16 ms) e em
 * menos chamadas.
 *
 * Classes de entrega (`delivery`):
 *  - `analysis` (padrão): recebe o lote. Detectores, scanners e medidores.
 *  - `complete`: recebe sempre o lote inteiro (anel de saída do pane, ponte
 *    remota, pipes, blocos de comando).
 *  - `immediate`: recebe cada chunk na chegada, síncrono. Só para portões de
 *    aceite que CONTAM chunks e dependem da ordem exata com escrita e estado;
 *    tem de ser O(1) por chunk e nunca ler o texto.
 *
 * Contabilidade (A.3): cada tap é cronometrado. Tap acima de 50 ms ou entrega
 * inteira acima de 100 ms vira trace (`pty-tap-slow` / `pty-tap-batch-slow`)
 * com o nome registrado — no máximo um a cada 10 s por tap, com a contagem do
 * que foi suprimido no meio.
 */

export type SessionDataTap = (sessionId: string, data: string) => void;

export type SessionDataTapDelivery = 'analysis' | 'complete' | 'immediate';

export interface SessionDataTapOptions {
  /** Nome estável do tap no trace de orçamento (`pty-tap-slow`). */
  readonly name?: string;
  /** Padrão `analysis`. Ver o cabeçalho do módulo. */
  readonly delivery?: SessionDataTapDelivery;
}

export interface PtyTapBudgetConfig {
  /** Janela de coalescência do lote de cada sessão. */
  readonly flushMs: number;
  /** Lote que passa disto sai na hora (despejo de uma vez). */
  readonly maxBatchChars: number;
  /** Tap acima disto vira trace `pty-tap-slow`. */
  readonly tapSlowMs: number;
  /** Entrega inteira (todos os taps de um evento) acima disto vira trace. */
  readonly batchSlowMs: number;
  /** Teto de frequência de cada trace de lentidão (por tap / por tipo). */
  readonly slowTraceEveryMs: number;
  /** Um tick do timer de lotes cede o main depois disto e continua em seguida. */
  readonly sliceBudgetMs: number;
}

export const PTY_TAP_BUDGET: PtyTapBudgetConfig = Object.freeze({
  flushMs: 16,
  maxBatchChars: 32 * 1024,
  tapSlowMs: 50,
  batchSlowMs: 100,
  slowTraceEveryMs: 10_000,
  sliceBudgetMs: 50,
});

export interface PtyTapDispatcherDeps {
  /** Relógio monotônico em ms (`performance.now` em produção). */
  readonly now: () => number;
  readonly setTimer: (run: () => void, ms: number) => unknown;
  readonly clearTimer: (handle: unknown) => void;
  /** Trace persistido do main; nunca recebe texto do PTY, só ids e números. */
  readonly trace: (event: Record<string, unknown>) => void;
  readonly warn: (message: string, error: unknown) => void;
}

const round1 = (ms: number) => Math.round(ms * 10) / 10;

interface SlowTraceWindow {
  lastAt: number;
  suppressed: number;
  maxSuppressedMs: number;
}

/**
 * Cronômetro dos taps do pty-manager — dados, estado, saída, entrada e
 * encerramento passam todos por aqui. Nunca lança: um tap que falha vira um
 * aviso e o próximo tap roda.
 */
export class TapTimingBudget {
  readonly #windows = new Map<string, SlowTraceWindow>();

  constructor(
    private readonly deps: Pick<PtyTapDispatcherDeps, 'now' | 'trace' | 'warn'>,
    private readonly config: Pick<
      PtyTapBudgetConfig,
      'tapSlowMs' | 'batchSlowMs' | 'slowTraceEveryMs'
    >,
  ) {}

  /** Chama um tap cronometrado e isolado; devolve os ms gastos. */
  call(
    tapKind: string,
    tapName: string,
    sessionId: string,
    chars: number,
    invoke: () => void,
  ): number {
    const startedAt = this.deps.now();
    try {
      invoke();
    } catch (error) {
      this.deps.warn('[pty-manager] orchestration tap threw:', error);
    }
    const ms = this.deps.now() - startedAt;
    if (ms >= this.config.tapSlowMs) {
      this.#emit(`tap\0${tapKind}\0${tapName}`, ms, (suppression) => ({
        kind: 'pty-tap-slow',
        tapKind,
        tap: tapName,
        sessionId,
        ms: round1(ms),
        chars,
        ...suppression,
      }));
    }
    return ms;
  }

  /** Fecha a conta de uma entrega a vários taps (um lote, um evento). */
  delivery(
    tapKind: string,
    sessionId: string,
    totals: {
      readonly ms: number;
      readonly chars: number;
      readonly chunks: number;
      readonly taps: number;
      readonly slowestTap: string;
      readonly slowestMs: number;
    },
  ): void {
    if (totals.ms < this.config.batchSlowMs) return;
    this.#emit(`batch\0${tapKind}`, totals.ms, (suppression) => ({
      kind: 'pty-tap-batch-slow',
      tapKind,
      sessionId,
      ms: round1(totals.ms),
      chars: totals.chars,
      chunks: totals.chunks,
      taps: totals.taps,
      slowestTap: totals.slowestTap,
      slowestMs: round1(totals.slowestMs),
      ...suppression,
    }));
  }

  #emit(
    key: string,
    ms: number,
    build: (suppression: Record<string, number>) => Record<string, unknown>,
  ): void {
    const now = this.deps.now();
    const window = this.#windows.get(key);
    if (window && now - window.lastAt < this.config.slowTraceEveryMs) {
      window.suppressed += 1;
      window.maxSuppressedMs = Math.max(window.maxSuppressedMs, ms);
      return;
    }
    const suppression =
      window && window.suppressed > 0
        ? {
            suppressed: window.suppressed,
            maxSuppressedMs: round1(window.maxSuppressedMs),
          }
        : {};
    this.#windows.set(key, { lastAt: now, suppressed: 0, maxSuppressedMs: 0 });
    try {
      this.deps.trace(build(suppression));
    } catch {
      // Instrumentação nunca derruba o caminho de PTY.
    }
  }
}

interface TapEntry {
  readonly tap: SessionDataTap;
  readonly name: string;
  readonly delivery: SessionDataTapDelivery;
}

interface SessionBatch {
  readonly sessionId: string;
  chunks: string[];
  chars: number;
  /** Relógio do primeiro chunk pendente: o lote sai até `flushMs` depois. */
  firstChunkAt: number;
}

export class PtyDataTapDispatcher {
  readonly budget: TapTimingBudget;
  readonly #config: PtyTapBudgetConfig;
  readonly #taps = new Map<SessionDataTap, TapEntry>();
  /** Instantâneos trocados (nunca mutados) a cada registro: iteração segura. */
  #batched: readonly TapEntry[] = [];
  #immediate: readonly TapEntry[] = [];
  readonly #batches = new Map<string, SessionBatch>();
  readonly #pending = new Set<SessionBatch>();
  #timer: unknown = null;
  #timerDueAt = Infinity;

  constructor(
    private readonly deps: PtyTapDispatcherDeps,
    config: Partial<PtyTapBudgetConfig> = {},
  ) {
    this.#config = { ...PTY_TAP_BUDGET, ...config };
    this.budget = new TapTimingBudget(deps, this.#config);
  }

  register(tap: SessionDataTap, options: SessionDataTapOptions = {}): () => void {
    const existing = this.#taps.get(tap);
    // Mesmo callback de novo: um registro só, como o Set de antes.
    if (existing) return () => this.#unregister(existing);
    const entry: TapEntry = {
      tap,
      name: options.name ?? (tap.name || 'anonimo'),
      delivery: options.delivery ?? 'analysis',
    };
    // Um tap novo só vê a saída que chega DEPOIS do registro.
    if (entry.delivery !== 'immediate') this.flushAll();
    this.#taps.set(tap, entry);
    this.#rebuild();
    return () => this.#unregister(entry);
  }

  /** Um chunk do host: taps imediatos agora, os demais no lote da sessão. */
  push(sessionId: string, data: string): void {
    if (data.length === 0) return;
    if (this.#immediate.length > 0) {
      this.#deliver(this.#immediate, sessionId, data, 1);
    }
    if (this.#batched.length === 0) return;
    let batch = this.#batches.get(sessionId);
    if (!batch) {
      batch = { sessionId, chunks: [], chars: 0, firstChunkAt: 0 };
      this.#batches.set(sessionId, batch);
    }
    if (batch.chunks.length === 0) batch.firstChunkAt = this.deps.now();
    batch.chunks.push(data);
    batch.chars += data.length;
    if (batch.chars >= this.#config.maxBatchChars) {
      this.#flushBatch(batch);
      return;
    }
    this.#pending.add(batch);
    this.#arm(batch.firstChunkAt + this.#config.flushMs);
  }

  /** Esvazia o lote de uma sessão agora (evento do Main que os taps leem). */
  flush(sessionId: string): void {
    const batch = this.#batches.get(sessionId);
    if (batch) this.#flushBatch(batch);
  }

  flushAll(): void {
    for (const batch of [...this.#pending]) this.#flushBatch(batch);
  }

  /** Sessão finalizada: descarta o estado (depois do `flush` final). */
  drop(sessionId: string): void {
    const batch = this.#batches.get(sessionId);
    if (!batch) return;
    this.#batches.delete(sessionId);
    this.#pending.delete(batch);
  }

  /** Caracteres ainda no lote da sessão (testes e diagnóstico). */
  pendingChars(sessionId: string): number {
    return this.#batches.get(sessionId)?.chars ?? 0;
  }

  #unregister(entry: TapEntry): void {
    if (this.#taps.get(entry.tap) !== entry) return;
    // A saída que chegou ANTES da remoção ainda é deste tap.
    if (entry.delivery !== 'immediate') this.flushAll();
    if (this.#taps.get(entry.tap) !== entry) return;
    this.#taps.delete(entry.tap);
    this.#rebuild();
  }

  #rebuild(): void {
    const all = [...this.#taps.values()];
    this.#batched = all.filter((entry) => entry.delivery !== 'immediate');
    this.#immediate = all.filter((entry) => entry.delivery === 'immediate');
  }

  #flushBatch(batch: SessionBatch): void {
    this.#pending.delete(batch);
    if (batch.chunks.length === 0) return;
    const chunks = batch.chunks.length;
    const text = chunks === 1 ? batch.chunks[0] : batch.chunks.join('');
    batch.chunks = [];
    batch.chars = 0;
    this.#deliver(this.#batched, batch.sessionId, text, chunks);
  }

  #deliver(
    entries: readonly TapEntry[],
    sessionId: string,
    text: string,
    chunks: number,
  ): void {
    let ms = 0;
    let taps = 0;
    let slowestTap = '';
    let slowestMs = 0;
    for (const entry of entries) {
      // Removido no meio da entrega (um tap que se desliga sozinho).
      if (this.#taps.get(entry.tap) !== entry) continue;
      const spent = this.budget.call('data', entry.name, sessionId, text.length, () =>
        entry.tap(sessionId, text),
      );
      ms += spent;
      taps += 1;
      if (spent > slowestMs) {
        slowestMs = spent;
        slowestTap = entry.name;
      }
    }
    this.budget.delivery('data', sessionId, {
      ms,
      chars: text.length,
      chunks,
      taps,
      slowestTap,
      slowestMs,
    });
  }

  #arm(dueAt: number): void {
    if (this.#timer !== null && this.#timerDueAt <= dueAt) return;
    if (this.#timer !== null) this.deps.clearTimer(this.#timer);
    this.#timerDueAt = dueAt;
    this.#timer = this.deps.setTimer(
      () => this.#onTimer(),
      Math.max(0, dueAt - this.deps.now()),
    );
  }

  #onTimer(): void {
    this.#timer = null;
    this.#timerDueAt = Infinity;
    const startedAt = this.deps.now();
    let nextDue = Infinity;
    for (const batch of [...this.#pending]) {
      // Esvaziado no meio do tick por um evento reentrante.
      if (!this.#pending.has(batch)) continue;
      const now = this.deps.now();
      if (now - startedAt >= this.#config.sliceBudgetMs) {
        // Tick longo: cede o main (IPC, renderer) e continua no próximo.
        nextDue = now;
        break;
      }
      const due = batch.firstChunkAt + this.#config.flushMs;
      if (due > now) {
        nextDue = Math.min(nextDue, due);
        continue;
      }
      this.#flushBatch(batch);
    }
    if (nextDue !== Infinity) this.#arm(nextDue);
  }
}
