/**
 * Circuit breaker for adapters/providers — inspired by xai-circuit-breaker
 * (Apache-2.0 grok-build patterns), reimplemented pure TS for Nexus routing.
 *
 * closed → open (after failureThreshold in window) → half-open (after openMs)
 * → closed (on success) or open (on failure in half-open).
 */

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerConfig {
  /** Failures in the sliding window that trip the breaker. Default 3. */
  failureThreshold: number;
  /** Sliding window for counting failures (ms). Default 60s. */
  windowMs: number;
  /** How long to stay open before half-open probe (ms). Default 30s. */
  openMs: number;
}

export const DEFAULT_CIRCUIT_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 3,
  windowMs: 60_000,
  openMs: 30_000,
};

interface BreakerEntry {
  state: CircuitState;
  failures: number[];
  openedAt: number | null;
  /** Janela aberta própria de um `trip` (F-734); sem ela vale a da config. */
  openMs?: number;
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
    e.state = 'closed';
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
    e.state = 'open';
    e.openedAt = now;
    e.openMs = openMs;
  }

  recordFailure(key: string): void {
    const e = this.#refresh(key);
    const now = this.#now();
    if (e.state === 'half-open') {
      e.state = 'open';
      e.openedAt = now;
      e.failures.push(now);
      return;
    }
    e.failures.push(now);
    this.#prune(e, now);
    if (e.failures.length >= this.#config.failureThreshold) {
      e.state = 'open';
      e.openedAt = now;
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
