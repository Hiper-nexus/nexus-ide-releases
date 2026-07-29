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
});
