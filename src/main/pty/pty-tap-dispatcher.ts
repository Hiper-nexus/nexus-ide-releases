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
 * Inundação (C.2): sessão acima de 512 K caracteres/s (janela deslizante de
 * 1 s) passa a alimentar os taps de ANÁLISE só com o tail de 16 KB do que
 * chegou desde a última entrega, no máximo a cada 250 ms — o custo deles fica
 * limitado (~64 KB/s por sessão) qualquer que seja a vazão. Os taps COMPLETE
 * seguem recebendo tudo, em lotes maiores (50 ms / 256 KB). A UI não depende
 * disto: push ao renderer e replay ficam no pty-manager, chunk a chunk. O
 * trace registra `pty-flood` (no máximo um por sessão por minuto) e
 * `pty-flood-end` com quanto a análise deixou de ver. Sai da inundação abaixo
 * de 256 K/s (histerese).
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
  /** Acima disto (caracteres/s, janela de 1 s) a sessão está inundando. */
  readonly floodEnterCharsPerSec: number;
  /** Abaixo disto a inundação acabou (histerese). */
  readonly floodExitCharsPerSec: number;
  /** Tail que os taps de análise recebem sob inundação. */
  readonly floodTailChars: number;
  /** Cadência dos taps de análise sob inundação. */
  readonly floodAnalysisMs: number;
  /** Janela do lote dos taps `complete` sob inundação. */
  readonly floodFlushMs: number;
  /** Teto do lote sob inundação (memória e tamanho de cada entrega). */
  readonly floodMaxBatchChars: number;
  /** No máximo um trace `pty-flood` por sessão neste intervalo. */
  readonly floodTraceEveryMs: number;
}

export const PTY_TAP_BUDGET: PtyTapBudgetConfig = Object.freeze({
  flushMs: 16,
  maxBatchChars: 32 * 1024,
  tapSlowMs: 50,
  batchSlowMs: 100,
  slowTraceEveryMs: 10_000,
  sliceBudgetMs: 50,
  floodEnterCharsPerSec: 512 * 1024,
  floodExitCharsPerSec: 256 * 1024,
  floodTailChars: 16 * 1024,
  floodAnalysisMs: 250,
  floodFlushMs: 50,
  floodMaxBatchChars: 256 * 1024,
  floodTraceEveryMs: 60_000,
});

export interface PtyTapDispatcherDeps {
  /** Relógio monotônico em ms (`performance.now` em produção). */
  readonly now: () => number;
  readonly setTimer: (run: () => void, ms: number) => unknown;
  readonly clearTimer: (handle: unknown) => void;
  /** Trace persistido do main; nunca recebe texto do PTY, só ids e números. */
  readonly trace: (event: Record<string, unknown>) => void;
  readonly warn: (message: string, error: unknown) => void;
  /** Ids do pane/adapter da sessão para o trace de inundação (nunca texto). */
  readonly describeSession?: (sessionId: string) => Record<string, unknown> | null;
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
    const suppression: Record<string, number> =
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
  // Vazão: janela deslizante de 1 s (janela atual + fração da anterior).
  windowStartedAt: number;
  windowChars: number;
  previousWindowChars: number;
  // Inundação (C.2).
  flooding: boolean;
  floodStartedAt: number;
  floodPeakCharsPerSec: number;
  floodDroppedChars: number;
  floodTraced: boolean;
  lastFloodTraceAt: number | null;
  suppressedFloods: number;
  /** O que os taps de análise ainda não viram (no máximo `floodTailChars`). */
  tail: string;
  tailPending: boolean;
  tailTruncated: boolean;
  lastAnalysisAt: number;
}

/**
 * Início seguro do tail cortado: a primeira linha veio pela metade, então
 * começa na linha seguinte; sem quebra por perto, no próximo ESC (não começa
 * no meio de uma sequência); nunca no meio de um par substituto.
 */
function safeTailStart(text: string): string {
  const newline = text.indexOf('\n');
  if (newline >= 0 && newline < 1_024 && newline < text.length - 1) {
    return text.slice(newline + 1);
  }
  const escape = text.indexOf('\x1b');
  if (escape > 0 && escape < 256) return text.slice(escape);
  const first = text.charCodeAt(0);
  return first >= 0xdc00 && first <= 0xdfff ? text.slice(1) : text;
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
      this.#deliver(this.#immediate, sessionId, data, data, 1);
    }
    if (this.#batched.length === 0) return;
    const now = this.deps.now();
    let batch = this.#batches.get(sessionId);
    if (!batch) {
      batch = this.#newBatch(sessionId, now);
      this.#batches.set(sessionId, batch);
    }
    // A janela de 1 s precisa acumular `floodEnterCharsPerSec` para disparar:
    // a rajada inicial de uma inundação (~100 ms a 5 MB/s) ainda é analisada
    // inteira, uma vez por episódio. Depois disso o custo fica limitado.
    const rate = this.#observeRate(batch, data.length, now);
    if (batch.flooding) {
      if (rate < this.#config.floodExitCharsPerSec) {
        // O tail pendente sai antes do lote novo no próximo esvaziamento.
        this.#endFlood(batch, now, 'rate');
      } else {
        batch.floodPeakCharsPerSec = Math.max(batch.floodPeakCharsPerSec, rate);
      }
    } else if (rate > this.#config.floodEnterCharsPerSec) {
      this.#startFlood(batch, rate, now);
    }
    if (batch.chunks.length === 0) batch.firstChunkAt = now;
    batch.chunks.push(data);
    batch.chars += data.length;
    const maxChars = batch.flooding
      ? this.#config.floodMaxBatchChars
      : this.#config.maxBatchChars;
    if (batch.chars >= maxChars) {
      this.#flushBatch(batch, false);
      return;
    }
    this.#pending.add(batch);
    this.#arm(this.#dueAt(batch));
  }

  /** Esvazia o lote de uma sessão agora (evento do Main que os taps leem). */
  flush(sessionId: string): void {
    const batch = this.#batches.get(sessionId);
    if (batch) this.#flushBatch(batch, true);
  }

  flushAll(): void {
    for (const batch of [...this.#pending]) this.#flushBatch(batch, true);
  }

  /** Sessão finalizada: descarta o estado (depois do `flush` final). */
  drop(sessionId: string): void {
    const batch = this.#batches.get(sessionId);
    if (!batch) return;
    if (batch.flooding) this.#endFlood(batch, this.deps.now(), 'exit');
    this.#batches.delete(sessionId);
    this.#pending.delete(batch);
  }

  /** Caracteres ainda no lote da sessão (testes e diagnóstico). */
  pendingChars(sessionId: string): number {
    return this.#batches.get(sessionId)?.chars ?? 0;
  }

  /** A sessão está inundando agora? (testes e diagnóstico) */
  isFlooding(sessionId: string): boolean {
    return this.#batches.get(sessionId)?.flooding ?? false;
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

  /**
   * Entrega o lote. `force` = um evento do Main pediu (estado, escrita,
   * encerramento, registro): sob inundação o tail de análise sai junto, fora
   * da cadência — a ordem relativa ao evento vale também para a análise.
   */
  #flushBatch(batch: SessionBatch, force: boolean): void {
    this.#pending.delete(batch);
    const now = this.deps.now();
    const chunks = batch.chunks.length;
    const text =
      chunks === 0 ? '' : chunks === 1 ? batch.chunks[0] : batch.chunks.join('');
    batch.chunks = [];
    batch.chars = 0;
    if (
      batch.flooding &&
      this.#observeRate(batch, 0, now) < this.#config.floodExitCharsPerSec
    ) {
      this.#endFlood(batch, now, 'rate');
    }
    if (!batch.flooding) {
      // O resto do tail de uma inundação que acabou vem antes do lote novo.
      const analysis = batch.tailPending ? this.#takeTail(batch, now) + text : text;
      if (text.length > 0 || analysis.length > 0) {
        this.#deliver(this.#batched, batch.sessionId, text, analysis, chunks);
      }
      return;
    }
    if (text.length > 0) this.#appendTail(batch, text);
    const analysisDue =
      force || now - batch.lastAnalysisAt >= this.#config.floodAnalysisMs;
    const analysis =
      analysisDue && batch.tailPending ? this.#takeTail(batch, now) : null;
    if (text.length > 0 || analysis !== null) {
      this.#deliver(this.#batched, batch.sessionId, text, analysis, chunks);
    }
    if (batch.tailPending && this.#batches.get(batch.sessionId) === batch) {
      this.#pending.add(batch);
      this.#arm(this.#dueAt(batch));
    }
  }

  /**
   * `complete` recebe `text`; `analysis` recebe `analysis` (o lote, ou só o
   * tail sob inundação; `null` = nada para a análise nesta entrega).
   */
  #deliver(
    entries: readonly TapEntry[],
    sessionId: string,
    text: string,
    analysis: string | null,
    chunks: number,
  ): void {
    let ms = 0;
    let taps = 0;
    let slowestTap = '';
    let slowestMs = 0;
    for (const entry of entries) {
      // Removido no meio da entrega (um tap que se desliga sozinho).
      if (this.#taps.get(entry.tap) !== entry) continue;
      const data = entry.delivery === 'analysis' ? analysis : text;
      if (data === null || data.length === 0) continue;
      const spent = this.budget.call('data', entry.name, sessionId, data.length, () =>
        entry.tap(sessionId, data),
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
      chars: Math.max(text.length, analysis?.length ?? 0),
      chunks,
      taps,
      slowestTap,
      slowestMs,
    });
  }

  #newBatch(sessionId: string, now: number): SessionBatch {
    return {
      sessionId,
      chunks: [],
      chars: 0,
      firstChunkAt: now,
      windowStartedAt: now,
      windowChars: 0,
      previousWindowChars: 0,
      flooding: false,
      floodStartedAt: 0,
      floodPeakCharsPerSec: 0,
      floodDroppedChars: 0,
      floodTraced: false,
      lastFloodTraceAt: null,
      suppressedFloods: 0,
      tail: '',
      tailPending: false,
      tailTruncated: false,
      lastAnalysisAt: now,
    };
  }

  /** Caracteres no último segundo: janela atual + a fração da anterior. */
  #observeRate(batch: SessionBatch, chars: number, now: number): number {
    const elapsed = now - batch.windowStartedAt;
    if (elapsed >= 1_000) {
      const windows = Math.floor(elapsed / 1_000);
      batch.previousWindowChars = windows === 1 ? batch.windowChars : 0;
      batch.windowChars = 0;
      batch.windowStartedAt += windows * 1_000;
    }
    batch.windowChars += chars;
    const intoWindow = (now - batch.windowStartedAt) / 1_000;
    return batch.windowChars + batch.previousWindowChars * (1 - intoWindow);
  }

  /** Quando o lote (ou o tail de análise) desta sessão vence. */
  #dueAt(batch: SessionBatch): number {
    let due = Infinity;
    if (batch.chunks.length > 0) {
      due =
        batch.firstChunkAt +
        (batch.flooding ? this.#config.floodFlushMs : this.#config.flushMs);
    }
    if (batch.tailPending) {
      due = Math.min(due, batch.lastAnalysisAt + this.#config.floodAnalysisMs);
    }
    return due;
  }

  #appendTail(batch: SessionBatch, text: string): void {
    const max = this.#config.floodTailChars;
    if (text.length >= max) {
      batch.floodDroppedChars += batch.tail.length + text.length - max;
      batch.tail = text.slice(-max);
      batch.tailTruncated = true;
    } else {
      const keep = max - text.length;
      if (batch.tail.length > keep) {
        batch.floodDroppedChars += batch.tail.length - keep;
        batch.tail = batch.tail.slice(-keep);
        batch.tailTruncated = true;
      }
      batch.tail += text;
    }
    batch.tailPending = true;
  }

  #takeTail(batch: SessionBatch, now: number): string {
    const tail = batch.tailTruncated ? safeTailStart(batch.tail) : batch.tail;
    batch.tail = '';
    batch.tailPending = false;
    batch.tailTruncated = false;
    batch.lastAnalysisAt = now;
    return tail;
  }

  #startFlood(batch: SessionBatch, rate: number, now: number): void {
    batch.flooding = true;
    batch.floodStartedAt = now;
    batch.floodPeakCharsPerSec = rate;
    batch.floodDroppedChars = 0;
    batch.lastAnalysisAt = now;
    if (
      batch.lastFloodTraceAt !== null &&
      now - batch.lastFloodTraceAt < this.#config.floodTraceEveryMs
    ) {
      batch.floodTraced = false;
      batch.suppressedFloods += 1;
      return;
    }
    batch.floodTraced = true;
    batch.lastFloodTraceAt = now;
    const suppressed = batch.suppressedFloods;
    batch.suppressedFloods = 0;
    this.#trace({
      kind: 'pty-flood',
      sessionId: batch.sessionId,
      ...this.#describe(batch.sessionId),
      charsPerSec: Math.round(rate),
      tailChars: this.#config.floodTailChars,
      analysisEveryMs: this.#config.floodAnalysisMs,
      ...(suppressed > 0 ? { suppressedFloods: suppressed } : {}),
    });
  }

  #endFlood(batch: SessionBatch, now: number, reason: 'rate' | 'exit'): void {
    batch.flooding = false;
    if (!batch.floodTraced) return;
    batch.floodTraced = false;
    this.#trace({
      kind: 'pty-flood-end',
      sessionId: batch.sessionId,
      reason,
      durationMs: Math.round(now - batch.floodStartedAt),
      droppedChars: batch.floodDroppedChars,
      peakCharsPerSec: Math.round(batch.floodPeakCharsPerSec),
    });
  }

  #describe(sessionId: string): Record<string, unknown> {
    try {
      return this.deps.describeSession?.(sessionId) ?? {};
    } catch {
      return {};
    }
  }

  #trace(event: Record<string, unknown>): void {
    try {
      this.deps.trace(event);
    } catch {
      // Instrumentação nunca derruba o caminho de PTY.
    }
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
      const due = this.#dueAt(batch);
      if (due > now) {
        nextDue = Math.min(nextDue, due);
        continue;
      }
      this.#flushBatch(batch, false);
      if (this.#pending.has(batch)) nextDue = Math.min(nextDue, this.#dueAt(batch));
    }
    if (nextDue !== Infinity) this.#arm(nextDue);
  }
}
