/**
 * Circuit breaker for adapters/providers — inspired by xai-circuit-breaker
 * (Apache-2.0 grok-build patterns), reimplemented pure TS for Nexus routing.
 *
 * closed → open (after failureThreshold in window) → half-open (after openMs)
 * → closed (on success) or open (on failure in half-open).
 *
 * F-736: o Qwen morreu no boot 7 vezes em 02/10 e a rota o escolheu de novo a
 * cada vez. A janela de 60 s não juntava 3 falhas de spawns espaçados, e o
 * half-open reabria por só 30 s a cada sonda que falhava. A janela agora é de
 * 10 min e cada sonda que falha multiplica o tempo aberto (30 s → 2 min →
 * 8 min → 30 min); o 1º sucesso volta ao começo.
 */

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerConfig {
  /** Failures in the sliding window that trip the breaker. Default 3. */
  failureThreshold: number;
  /** Sliding window for counting failures (ms). Default 10 min (F-736). */
  windowMs: number;
  /** How long to stay open before the first half-open probe (ms). Default 30s. */
  openMs: number;
  /** F-736: each failed half-open probe multiplies the open period by this. */
  backoffFactor: number;
  /** F-736: ceiling of the open period (ms). Default 30 min. */
  maxOpenMs: number;
}

export const DEFAULT_CIRCUIT_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 3,
  windowMs: 10 * 60_000,
  openMs: 30_000,
  backoffFactor: 4,
  maxOpenMs: 30 * 60_000,
};

interface BreakerEntry {
  state: CircuitState;
  failures: number[];
  openedAt: number | null;
  /** Janela aberta própria de um `trip` (F-734); sem ela vale a da config. */
  openMs?: number;
  /** F-736: duração do último período aberto — base do recuo da próxima sonda. */
  lastOpenMs?: number;
}

export interface CircuitSnapshot {
  key: string;
  state: CircuitState;
  recentFailures: number;
}

/**
 * In-memory registry. Process-lifetime; not persisted (cold start = closed).
 */
export class CircuitBreakerRegistry {
  readonly #config: CircuitBreakerConfig;
  readonly #entries = new Map<string, BreakerEntry>();
  readonly #now: () => number;

  constructor(
    config: Partial<CircuitBreakerConfig> = {},
    now: () => number = () => Date.now(),
  ) {
    this.#config = { ...DEFAULT_CIRCUIT_CONFIG, ...config };
    this.#now = now;
  }

  #entry(key: string): BreakerEntry {
    let e = this.#entries.get(key);
    if (!e) {
      e = { state: 'closed', failures: [], openedAt: null };
      this.#entries.set(key, e);
    }
    return e;
  }

  #prune(e: BreakerEntry, now: number): void {
    const cutoff = now - this.#config.windowMs;
    e.failures = e.failures.filter((t) => t >= cutoff);
  }

  #refresh(key: string): BreakerEntry {
    const e = this.#entry(key);
    const now = this.#now();
    this.#prune(e, now);
    if (e.state === 'open' && e.openedAt != null) {
      if (now - e.openedAt >= (e.openMs ?? this.#config.openMs)) {
        e.state = 'half-open';
        e.openMs = undefined;
      }
    }
    return e;
  }

  /** Current state after time-based transitions. */
  state(key: string): CircuitState {
    return this.#refresh(key).state;
  }

  /** True when the key must not be selected for auto-routing. */
  isOpen(key: string): boolean {
    return this.state(key) === 'open';
  }

  /** Half-open allows one probe candidate. */
  allowsTraffic(key: string): boolean {
    const s = this.state(key);
    return s === 'closed' || s === 'half-open';
  }

  recordSuccess(key: string): void {
    const e = this.#refresh(key);
    e.failures = [];
    e.openedAt = null;
    e.openMs = undefined;
    e.lastOpenMs = undefined;
    e.state = 'closed';
  }

  #open(e: BreakerEntry, now: number, openMs: number): void {
    e.state = 'open';
    e.openedAt = now;
    e.openMs = openMs;
    e.lastOpenMs = openMs;
  }

  /**
   * F-734: abre na hora, por `openMs`, uma falha que repetir não cura — a
   * credencial que TODOS os panes da chave usam foi recusada pelo provedor.
   * Contar 1 de 3 em 60 s não bastava: cada recusa leva minutos de retry da
   * CLI para aparecer, então o disjuntor nunca abria. Depois da janela segue
   * o ciclo normal (half-open; o 1º sucesso fecha). Nunca encurta uma janela
   * já aberta mais longa.
   */
  trip(key: string, openMs: number = this.#config.openMs): void {
    const e = this.#refresh(key);
    const now = this.#now();
    e.failures.push(now);
    if (
      e.state === 'open' &&
      e.openedAt != null &&
      e.openedAt + (e.openMs ?? this.#config.openMs) >= now + openMs
    ) {
      return;
    }
    this.#open(e, now, openMs);
  }

  recordFailure(key: string): void {
    const e = this.#refresh(key);
    const now = this.#now();
    if (e.state === 'half-open') {
      // F-736: a sonda falhou — o próximo período aberto é maior que o último.
      const base = e.lastOpenMs ?? this.#config.openMs;
      e.failures.push(now);
      this.#open(
        e,
        now,
        Math.min(
          this.#config.maxOpenMs,
          Math.max(this.#config.openMs, base * this.#config.backoffFactor),
        ),
      );
      return;
    }
    e.failures.push(now);
    this.#prune(e, now);
    if (e.state === 'closed' && e.failures.length >= this.#config.failureThreshold) {
      this.#open(e, now, this.#config.openMs);
    }
  }

  snapshot(key: string): CircuitSnapshot {
    const e = this.#refresh(key);
    return {
      key,
      state: e.state,
      recentFailures: e.failures.length,
    };
  }

  /** Test seam. */
  reset(key?: string): void {
    if (key) this.#entries.delete(key);
    else this.#entries.clear();
  }
}

/** Process-global registry for adapter routing. */
export const adapterCircuitBreakers = new CircuitBreakerRegistry();
