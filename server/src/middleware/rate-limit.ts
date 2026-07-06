import type { NextFunction, Request, Response } from 'express';

/**
 * Rate limit por IP com janela deslizante em memória (espelha o padrão da
 * remote-bridge do app). Suficiente p/ um container; multi-instância usaria
 * um store compartilhado (fora do escopo v1).
 *
 * IMPORTANTE: `req.ip` só é o IP real atrás de proxy com `app.set('trust
 * proxy', 1)` configurado no boot (ver index.ts) — sem isso, todo mundo cai
 * no bucket do proxy e o limite vira DoS global.
 */

export interface RateLimiter {
  (req: Request, res: Response, next: NextFunction): void;
  /** Diagnóstico/teste: quantos buckets vivos o Map segura agora. */
  bucketCount(): number;
}

const DEFAULT_SWEEP_EVERY = 1_000;

export function rateLimit(opts: {
  windowMs: number;
  max: number;
  now?: () => number;
  /** A cada N chamadas, varre buckets expirados (evita crescimento eterno). */
  sweepEvery?: number;
}): RateLimiter {
  const now = opts.now ?? Date.now;
  const sweepEvery = opts.sweepEvery ?? DEFAULT_SWEEP_EVERY;
  const hits = new Map<string, number[]>();
  let calls = 0;

  const handler = ((req, res, next) => {
    const ip = req.ip ?? 'unknown';
    const t = now();
    if (++calls % sweepEvery === 0) {
      for (const [key, stamps] of hits) {
        const live = stamps.filter((ts) => t - ts < opts.windowMs);
        if (live.length === 0) hits.delete(key);
        else hits.set(key, live);
      }
    }
    const arr = (hits.get(ip) ?? []).filter((ts) => t - ts < opts.windowMs);
    if (arr.length >= opts.max) {
      res.status(429).json({ ok: false, error: 'rate limited' });
      return;
    }
    arr.push(t);
    hits.set(ip, arr);
    next();
  }) as RateLimiter;
  handler.bucketCount = () => hits.size;
  return handler;
}
