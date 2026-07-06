import type { RequestHandler } from 'express';

/**
 * Rate limit por IP com janela deslizante em memória (espelha o padrão da
 * remote-bridge do app). Suficiente p/ um container; multi-instância usaria
 * um store compartilhado (fora do escopo v1).
 */
export function rateLimit(opts: {
  windowMs: number;
  max: number;
  now?: () => number;
}): RequestHandler {
  const now = opts.now ?? Date.now;
  const hits = new Map<string, number[]>();
  return (req, res, next) => {
    const ip = req.ip ?? 'unknown';
    const t = now();
    const arr = (hits.get(ip) ?? []).filter((ts) => t - ts < opts.windowMs);
    if (arr.length >= opts.max) {
      res.status(429).json({ ok: false, error: 'rate limited' });
      return;
    }
    arr.push(t);
    hits.set(ip, arr);
    next();
  };
}
