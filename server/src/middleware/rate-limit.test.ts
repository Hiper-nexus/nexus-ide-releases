import { describe, expect, it, vi } from 'vitest';
import { rateLimit } from './rate-limit';

function call(handler: ReturnType<typeof rateLimit>, ip: string) {
  const req = { ip } as never;
  const res = {
    statusCode: 200,
    status(c: number) {
      this.statusCode = c;
      return this;
    },
    json() {
      return this;
    },
  };
  const next = vi.fn();
  handler(req, res as never, next);
  return { status: res.statusCode, nexted: next.mock.calls.length > 0 };
}

describe('rateLimit', () => {
  it('libera até o teto e bloqueia (429) o excedente por IP', () => {
    let t = 0;
    const rl = rateLimit({ windowMs: 1000, max: 2, now: () => t });
    expect(call(rl, 'A').nexted).toBe(true);
    expect(call(rl, 'A').nexted).toBe(true);
    expect(call(rl, 'A').status).toBe(429);
    expect(call(rl, 'B').nexted).toBe(true);
  });

  it('a janela desliza: após windowMs libera de novo', () => {
    let t = 0;
    const rl = rateLimit({ windowMs: 1000, max: 1, now: () => t });
    expect(call(rl, 'A').nexted).toBe(true);
    expect(call(rl, 'A').status).toBe(429);
    t = 1001;
    expect(call(rl, 'A').nexted).toBe(true);
  });

  it('varre buckets expirados — o Map não cresce para sempre', () => {
    let t = 0;
    const rl = rateLimit({ windowMs: 1000, max: 5, now: () => t, sweepEvery: 4 });
    call(rl, 'A');
    call(rl, 'B');
    call(rl, 'C');
    expect(rl.bucketCount()).toBe(3);
    t = 5000; // todos expiraram
    call(rl, 'D'); // 4ª chamada dispara a varredura
    expect(rl.bucketCount()).toBe(1); // só o D vivo
  });
});
