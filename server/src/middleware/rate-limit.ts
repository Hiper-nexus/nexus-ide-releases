import type { NextFunction, Request, Response } from 'express';

/**
 * Rate limit por IP com janela deslizante. O store é plugável: o default é
 * em memória (suficiente p/ um container); para multi-instância, injete um
 * RateLimitStore backed by Redis/Postgres (M10 mitigation).
 *
 * IMPORTANTE: `req.ip` só é o IP real atrás de proxy com `app.set('trust
 * proxy', 1)` configurado no boot (ver index.ts) — sem isso, todo mundo cai
 * no bucket do proxy e o limite vira DoS global.
 */

/**
 * Pluggable store for rate-limit counters. Implement this interface with a
 * shared backend (Redis, Postgres) for horizontal scaling.
 */
export interface RateLimitStore {
  /** Record a hit for `key` at timestamp `nowMs`. */
  hit(key: string, nowMs: number): void;
  /** Count hits for `key` within the sliding window ending at `nowMs`. */
  count(key: string, windowMs: number, nowMs: number): number;
  /** Periodic cleanup of expired entries (no-op for TTL-based stores). */
  sweep?(nowMs: number, windowMs: number): void;
  /** Diagnostic: number of tracked keys. */
  size(): number;
}

/** In-memory sliding-window store (single-instance). */
export class MemoryRateLimitStore implements RateLimitStore {
  private hits = new Map<string, number[]>();

  hit(key: string, nowMs: number): void {
    const arr = this.hits.get(key) ?? [];
    arr.push(nowMs);
    this.hits.set(key, arr);
  }

  count(key: string, windowMs: number, nowMs: number): number {
    const arr = (this.hits.get(key) ?? []).filter((ts) => nowMs - ts < windowMs);
    this.hits.set(key, arr);
    return arr.length;
  }

  sweep(nowMs: number, windowMs: number): void {
    for (const [key, stamps] of this.hits) {
      const live = stamps.filter((ts) => nowMs - ts < windowMs);
      if (live.length === 0) this.hits.delete(key);
      else this.hits.set(key, live);
    }
  }

  size(): number {
    return this.hits.size;
  }
}

export interface RateLimiter {
  (req: Request, res: Response, next: NextFunction): void;
  /** Diagnóstico/teste: quantos buckets vivos o store segura agora. */
  bucketCount(): number;
}

const DEFAULT_SWEEP_EVERY = 1_000;

export function rateLimit(opts: {
  windowMs: number;
  max: number;
  now?: () => number;
  /** A cada N chamadas, varre buckets expirados (evita crescimento eterno). */
  sweepEvery?: number;
  /** Pluggable store (default: in-memory). Use Redis/Postgres for multi-instance. */
  store?: RateLimitStore;
}): RateLimiter {
  const now = opts.now ?? Date.now;
  const sweepEvery = opts.sweepEvery ?? DEFAULT_SWEEP_EVERY;
  const store = opts.store ?? new MemoryRateLimitStore();
  let calls = 0;

  const handler = ((req, res, next) => {
    const ip = req.ip ?? 'unknown';
    const t = now();
    if (++calls % sweepEvery === 0 && store.sweep) {
      store.sweep(t, opts.windowMs);
    }
    if (store.count(ip, opts.windowMs, t) >= opts.max) {
      res.status(429).json({ ok: false, error: 'rate limited' });
      return;
    }
    store.hit(ip, t);
    next();
  }) as RateLimiter;
  handler.bucketCount = () => store.size();
  return handler;
}
