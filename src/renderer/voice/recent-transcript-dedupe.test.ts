import { describe, expect, it } from 'vitest';
import { isRecentDuplicateTranscript } from './recent-transcript-dedupe';

describe('isRecentDuplicateTranscript', () => {
  const now = 10_000;

  it('blocks the same final transcript repeated by passive STT', () => {
    expect(
      isRecentDuplicateTranscript(
        'Iniciar com algum squad já existente.',
        { text: 'Iniciar com algum squad já existente.', at: now - 2_261 },
        now,
      ),
    ).toBe(true);
  });

  it('tolerates accents, punctuation and one STT token difference', () => {
    expect(
      isRecentDuplicateTranscript(
        'iniciar com squad ja existente',
        { text: 'Iniciar com algum squad já existente.', at: now - 1_200 },
        now,
      ),
    ).toBe(true);
  });

  it('does not block a distinct follow-up command', () => {
    expect(
      isRecentDuplicateTranscript(
        'abrir o terminal',
        { text: 'Iniciar com algum squad já existente.', at: now - 800 },
        now,
      ),
    ).toBe(false);
  });

  it('expires the duplicate window', () => {
    expect(
      isRecentDuplicateTranscript(
        'Iniciar com algum squad já existente.',
        { text: 'Iniciar com algum squad já existente.', at: now - 4_001 },
        now,
      ),
    ).toBe(false);
  });

  it('does not dedupe one-word commands', () => {
    expect(
      isRecentDuplicateTranscript('sim', { text: 'sim', at: now - 200 }, now),
    ).toBe(false);
  });
});
