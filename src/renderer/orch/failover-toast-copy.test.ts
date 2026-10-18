import { describe, expect, it } from 'vitest';
import type { FailoverEvent } from '../../shared/account-types';
import {
  blockedFailoverToastCopy,
  recoveredFailoverToastCopy,
} from './failover-toast-copy';

function event(
  kind: FailoverEvent['kind'],
  reason: string,
  fromAdapterId?: string,
): FailoverEvent {
  return {
    paneId: 'pane-a',
    fromAccountLabel: 'Claude principal',
    toAccountLabel: '',
    reason,
    kind,
    switched: false,
    ...(fromAdapterId ? { fromAdapterId } : {}),
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

  // F-1567: a orientação de chave/base URL é do Qwen (chave sk-sp- de plano
  // dedicado). Quem tem login por sessão expirada continua com o texto de
  // sessão: falar de "base URL" para um OAuth do Claude/Codex/AGY desorienta.
  it('F-1567: 401 do Qwen vira credencial recusada, com a orientação de chave e base URL', () => {
    const copy = blockedFailoverToastCopy(
      event('auth', 'Error: 401 Invalid API-key provided', 'qwen'),
    );
    expect(copy.title).toMatch(/Credencial recusada/);
    expect(copy.title).not.toMatch(/Limite|Cota|Sessão expirada/);
    expect(copy.detail).toMatch(/base URL incompatível/);
    expect(copy.detail).toMatch(/Configurações → Providers/);
  });

  it.each([
    ['claude', 'HTTP 401: OAuth token expired'],
    ['codex', 'refresh token expired'],
    ['agy', '401 authentication_error'],
    [undefined, 'HTTP 401'],
  ])('F-1567: 401 de login expirado em %s mantém o texto de sessão, sem base URL nem sk-sp-', (adapterId, reason) => {
    const copy = blockedFailoverToastCopy(event('auth', reason, adapterId));
    expect(copy.title).toMatch(/Sessão expirada/);
    expect(copy.detail).toMatch(/Entre novamente em Configurações → Providers/);
    expect(`${copy.title} ${copy.detail}`).not.toMatch(/base URL|sk-sp-|Credencial recusada/i);
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
    const stalled = blockedFailoverToastCopy({
      ...event('transient', 'status:503'),
      transientPhase: 'stalled',
      fromAccountLabel: 'conta adm',
    });
    expect(stalled.title).toBe('Provider continua instável');
    expect(stalled.detail).toMatch(/não limite da conta "conta adm"/);
    expect(stalled.detail).not.toMatch(/Providers/);
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
