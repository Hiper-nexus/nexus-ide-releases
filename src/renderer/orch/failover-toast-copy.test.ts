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
  it('does not promise an automatic retry at an already expired time', () => {
    const copy = blockedFailoverToastCopy({ ...event('rate-limit', 'HTTP 429'), scheduledRetryAtMs: 1 });
    expect(copy.detail).not.toMatch(/Nova tentativa automática às/);
  });
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
    const transient = blockedFailoverToastCopy(event('transient', 'HTTP 503'));
    expect(transient.title).toMatch(/Provider instável — conta mantida/);
    // Não pode sugerir limite da conta nem mandar procurar outra conta.
    expect(transient.detail).toMatch(/não limite da conta/);
    expect(transient.detail).not.toMatch(/Providers/);
  });

  it('erro do provider promete só o que o Main faz: missão retoma, pane do operador pede continue', () => {
    const mission = blockedFailoverToastCopy({
      ...event('transient', 'status:503'),
      missionId: 'mission-1',
    });
    expect(mission.detail).toMatch(/pede para ela continuar, na mesma conta e na mesma conversa/);
    const operator = blockedFailoverToastCopy({
      ...event('transient', 'status:503'),
      missionId: undefined,
    });
    expect(operator.detail).toMatch(/mande "continue"/);
  });

  it('a fase do episódio vem do campo estruturado, nunca do texto do motivo', () => {
    const stopped = blockedFailoverToastCopy({
      ...event('transient', 'status:503'),
      transientPhase: 'stopped',
    });
    expect(stopped.title).toBe('A CLI parou num erro do provider');
    const nudged = blockedFailoverToastCopy({
      ...event('transient', 'status:503'),
      transientPhase: 'nudged',
    });
    expect(nudged.title).toBe('Missão continuou na mesma conta');
    // Um motivo que por acaso contém "a CLI parou" não troca a cópia.
    const detected = blockedFailoverToastCopy({
      ...event('transient', 'provider disse: a CLI parou'),
      transientPhase: 'detected',
    });
    expect(detected.title).toBe('Provider instável — conta mantida');
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
