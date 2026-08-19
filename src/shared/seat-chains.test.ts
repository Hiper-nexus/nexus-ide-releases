import { describe, expect, it } from 'vitest';
import { firstSeatableCli, seatSuccessionChain } from './seat-chains';

describe('cadeia de sucessão de assento (overclick, 19/08)', () => {
  it('primário é sempre o primeiro elo; escalação segue a preferência', () => {
    const chain = seatSuccessionChain({
      primaryCli: 'cursor-agent',
      preferred: ['claude', 'codex', 'kimi'],
    });
    expect(chain).toEqual(['cursor-agent', 'claude', 'codex', 'kimi']);
  });

  it('primário que já está na preferência não duplica', () => {
    const chain = seatSuccessionChain({
      primaryCli: 'codex',
      preferred: ['claude', 'codex', 'kimi'],
    });
    expect(chain).toEqual(['codex', 'claude', 'kimi']);
  });

  it('primário present senta sem caminhar a cadeia', () => {
    expect(
      firstSeatableCli({
        primaryCli: 'cursor-agent',
        preferred: ['claude'],
        canSeat: (cli) => cli === 'cursor-agent',
      }),
    ).toBe('cursor-agent');
  });

  it('sem auth no primário, o primeiro elo present da escalação assume', () => {
    expect(
      firstSeatableCli({
        primaryCli: 'cursor-agent',
        preferred: ['claude', 'codex'],
        canSeat: (cli) => cli === 'codex',
      }),
    ).toBe('codex');
  });

  it('cadeia inteira sem auth devolve null — falha visível, nunca troca cega', () => {
    expect(
      firstSeatableCli({
        primaryCli: 'cursor-agent',
        preferred: ['claude'],
        canSeat: () => false,
      }),
    ).toBeNull();
  });

  it('default de escalação é a preferência global de auto-seat', () => {
    const chain = seatSuccessionChain({ primaryCli: 'sakana' });
    expect(chain[0]).toBe('sakana');
    expect(chain).toContain('claude');
    expect(chain).toContain('codex');
  });
});
