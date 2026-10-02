import { describe, expect, it } from 'vitest';
import {
  CircuitBreakerRegistry,
  DEFAULT_CIRCUIT_CONFIG,
} from './circuit-breaker';

describe('CircuitBreakerRegistry', () => {
  it('stays closed until failure threshold in window', () => {
    let now = 1_000_000;
    const b = new CircuitBreakerRegistry(
      { failureThreshold: 3, windowMs: 10_000, openMs: 5_000 },
      () => now,
    );
    expect(b.state('codex')).toBe('closed');
    b.recordFailure('codex');
    b.recordFailure('codex');
    expect(b.state('codex')).toBe('closed');
    b.recordFailure('codex');
    expect(b.state('codex')).toBe('open');
    expect(b.allowsTraffic('codex')).toBe(false);
  });

  it('opens → half-open after openMs → closed on success', () => {
    let now = 1_000_000;
    const b = new CircuitBreakerRegistry(
      { failureThreshold: 2, windowMs: 60_000, openMs: 1_000 },
      () => now,
    );
    b.recordFailure('grok');
    b.recordFailure('grok');
    expect(b.state('grok')).toBe('open');
    now += 1_001;
    expect(b.state('grok')).toBe('half-open');
    expect(b.allowsTraffic('grok')).toBe(true);
    b.recordSuccess('grok');
    expect(b.state('grok')).toBe('closed');
  });

  it('half-open failure re-opens', () => {
    let now = 1_000_000;
    const b = new CircuitBreakerRegistry(
      { failureThreshold: 1, windowMs: 60_000, openMs: 500 },
      () => now,
    );
    b.recordFailure('kimi');
    expect(b.state('kimi')).toBe('open');
    now += 600;
    expect(b.state('kimi')).toBe('half-open');
    b.recordFailure('kimi');
    expect(b.state('kimi')).toBe('open');
  });

  it('prunes failures outside the window', () => {
    let now = 1_000_000;
    const b = new CircuitBreakerRegistry(
      { failureThreshold: 2, windowMs: 1_000, openMs: 5_000 },
      () => now,
    );
    b.recordFailure('agy');
    now += 2_000;
    b.recordFailure('agy');
    // Only one failure in window → still closed
    expect(b.state('agy')).toBe('closed');
  });

  it('defaults match exported config', () => {
    expect(DEFAULT_CIRCUIT_CONFIG.failureThreshold).toBe(3);
  });

  it('F-734: trip abre na hora pela janela própria e depois segue o ciclo normal', () => {
    let now = 1_000_000;
    const b = new CircuitBreakerRegistry(
      { failureThreshold: 3, windowMs: 60_000, openMs: 30_000 },
      () => now,
    );
    b.trip('deepseek', 15 * 60_000);
    expect(b.state('deepseek')).toBe('open');
    expect(b.snapshot('deepseek').recentFailures).toBe(1);
    // A janela da config (30 s) não vale para o trip.
    now += 10 * 60_000;
    expect(b.isOpen('deepseek')).toBe(true);
    now += 5 * 60_000;
    expect(b.state('deepseek')).toBe('half-open');
    // F-736: a sonda que falha depois do trip reabre por MAIS que o trip
    // (15 min × 4, teto de 30 min) — a credencial continua recusada.
    b.recordFailure('deepseek');
    expect(b.state('deepseek')).toBe('open');
    now += 29 * 60_000;
    expect(b.isOpen('deepseek')).toBe(true);
    now += 60_000;
    expect(b.state('deepseek')).toBe('half-open');
    b.recordSuccess('deepseek');
    expect(b.state('deepseek')).toBe('closed');
  });

  it('F-736: três mortes no boot em 10 min abrem, mesmo espaçadas', () => {
    let now = 1_000_000;
    const b = new CircuitBreakerRegistry({}, () => now);
    // Forma de 02/10: Qwen morreu no boot a cada ~40 s–4 min.
    b.recordFailure('qwen');
    now += 2 * 60_000;
    b.recordFailure('qwen');
    expect(b.isOpen('qwen')).toBe(false);
    now += 3 * 60_000;
    b.recordFailure('qwen');
    expect(b.isOpen('qwen')).toBe(true);
  });

  it('F-736: cada sonda que falha recua mais (30 s → 2 min → 8 min → 30 min) e o sucesso zera', () => {
    let now = 1_000_000;
    const b = new CircuitBreakerRegistry({}, () => now);
    for (let i = 0; i < 3; i += 1) b.recordFailure('opencode');
    const openFor = (ms: number) => {
      now += ms - 1;
      expect(b.isOpen('opencode')).toBe(true);
      now += 1;
      expect(b.state('opencode')).toBe('half-open');
    };
    openFor(30_000);
    b.recordFailure('opencode');
    openFor(2 * 60_000);
    b.recordFailure('opencode');
    openFor(8 * 60_000);
    b.recordFailure('opencode');
    openFor(30 * 60_000);
    b.recordFailure('opencode');
    openFor(30 * 60_000);
    b.recordSuccess('opencode');
    expect(b.state('opencode')).toBe('closed');
    for (let i = 0; i < 3; i += 1) b.recordFailure('opencode');
    openFor(30_000);
  });

  it('F-734: sucesso de verdade fecha o trip; trip curto não encurta um longo', () => {
    let now = 1_000_000;
    const b = new CircuitBreakerRegistry(
      { failureThreshold: 3, windowMs: 60_000, openMs: 30_000 },
      () => now,
    );
    b.trip('glm', 15 * 60_000);
    b.trip('glm', 1_000);
    now += 5_000;
    expect(b.isOpen('glm')).toBe(true);
    b.recordSuccess('glm');
    expect(b.state('glm')).toBe('closed');
    // Sem janela própria, o trip usa a da config.
    b.trip('glm');
    now += 30_000;
    expect(b.state('glm')).toBe('half-open');
  });
});
