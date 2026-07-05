import { describe, expect, it } from 'vitest';
import { shouldFlagStall, STALL_MS } from './stall-watchdog';

const NOW = 10_000_000;

function candidate(overrides: Partial<Parameters<typeof shouldFlagStall>[0]> = {}) {
  return {
    role: 'worker' as const,
    state: 'busy',
    lastDataAt: NOW - STALL_MS - 1,
    alreadyFlagged: false,
    ...overrides,
  };
}

describe('shouldFlagStall', () => {
  it('flagra worker busy em silêncio além do limite', () => {
    expect(shouldFlagStall(candidate(), NOW)).toBe(true);
  });

  it('não flagra silêncio abaixo do limite', () => {
    expect(shouldFlagStall(candidate({ lastDataAt: NOW - STALL_MS + 5_000 }), NOW)).toBe(
      false,
    );
  });

  it('nunca flagra orquestrador nem pane do usuário', () => {
    expect(shouldFlagStall(candidate({ role: 'orchestrator' }), NOW)).toBe(false);
    expect(shouldFlagStall(candidate({ role: undefined }), NOW)).toBe(false);
  });

  it('worker idle/exited não é stall — ele terminou ou está esperando', () => {
    expect(shouldFlagStall(candidate({ state: 'idle' }), NOW)).toBe(false);
    expect(shouldFlagStall(candidate({ state: 'exited' }), NOW)).toBe(false);
  });

  it('não re-alerta sessão já sinalizada (anti-spam)', () => {
    expect(shouldFlagStall(candidate({ alreadyFlagged: true }), NOW)).toBe(false);
  });
});
