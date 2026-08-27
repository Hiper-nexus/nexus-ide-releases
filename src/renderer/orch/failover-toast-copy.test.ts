import { describe, expect, it } from 'vitest';
import type { FailoverEvent } from '../../shared/account-types';
import {
  blockedFailoverToastCopy,
  recoveredFailoverToastCopy,
} from './failover-toast-copy';

function event(
  kind: FailoverEvent['kind'],
  reason: string,
): FailoverEvent {
  return {
    paneId: 'pane-a',
    fromAccountLabel: 'Claude principal',
    toAccountLabel: '',
    reason,
    kind,
    switched: false,
  };
}

describe('blockedFailoverToastCopy', () => {
  it('never presents a 401 authentication failure as quota exhaustion', () => {
    const copy = blockedFailoverToastCopy(
      event('auth', 'HTTP 401: OAuth token expired'),
    );
    expect(copy.title).toMatch(/Sessão expirada/);
    expect(copy.title).not.toMatch(/Limite|Cota/);
    expect(copy.detail).toMatch(/Entre novamente/);
  });

  it('gives distinct recovery copy for quota, rate limit and transients', () => {
    expect(blockedFailoverToastCopy(event('quota', 'quota exceeded')).title)
      .toMatch(/Cota esgotada/);
    expect(blockedFailoverToastCopy(event('rate-limit', 'HTTP 429')).title)
      .toMatch(/Limite temporário/);
    expect(blockedFailoverToastCopy(event('transient', 'HTTP 503')).title)
      .toMatch(/Provider indisponível/);
  });
});

describe('recoveredFailoverToastCopy', () => {
  it('auth same-account never pretends the session was recovered', () => {
    const copy = recoveredFailoverToastCopy({
      ...event('auth', 'HTTP 401: OAuth token expired'),
      switched: true,
      toAccountLabel: 'conta adm',
      fromAccountId: 'acc-adm',
      toAccountId: 'acc-adm',
      crossAccount: false,
    });
    expect(copy.title).toMatch(/Sessão expirada/);
    expect(copy.title).not.toMatch(/recuperada/);
    expect(copy.detail).toMatch(/\+ Pane/);
  });

  it('rate-limit same-account still reports automatic recovery', () => {
    expect(
      recoveredFailoverToastCopy({
        ...event('rate-limit', 'HTTP 429'),
        switched: true,
        toAccountLabel: 'conta adm',
        crossAccount: false,
      }).title,
    ).toBe('Sessão recuperada automaticamente');
  });
});
