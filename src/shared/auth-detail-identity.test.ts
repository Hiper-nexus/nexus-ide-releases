import { describe, expect, it } from 'vitest';
import { detailWithIdentity, emailFromAuthDetail } from './auth-detail-identity';

describe('auth detail identity contract', () => {
  it('round-trips only an email identity through the main-to-renderer detail', () => {
    const detail = detailWithIdentity(
      'sessão Codex OAuth local (auth.json)',
      'codex@example.test',
    );

    expect(emailFromAuthDetail(detail)).toBe('codex@example.test');
    expect(detail).toBe(
      'sessão Codex OAuth local (auth.json) · codex@example.test',
    );
  });

  it('does not invent identity and never appends the same email twice', () => {
    expect(detailWithIdentity('sessão Kimi local', undefined)).toBe(
      'sessão Kimi local',
    );
    expect(
      detailWithIdentity(
        'sessão Grok local · grok@example.test',
        'other@example.test',
      ),
    ).toBe('sessão Grok local · grok@example.test');
  });
});
