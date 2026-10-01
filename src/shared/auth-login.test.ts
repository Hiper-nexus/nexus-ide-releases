import { describe, expect, it } from 'vitest';
import {
  isStaleLoginCode,
  LOGIN_PENDING_TTL_MS,
  LOGIN_PROVIDERS,
  loginExchangeMessage,
  loginProbeMessage,
} from './auth-login';

describe('loginProbeMessage', () => {
  it('diz qual provedor está indisponível quando o servidor responde 5xx', () => {
    expect(loginProbeMessage('github', { status: 503 })).toContain('GitHub');
    expect(loginProbeMessage('google', { status: 502 })).toContain('Google');
    expect(loginProbeMessage('github', { status: 503 })).toContain('ainda não está disponível');
  });

  it('separa limite de tentativas, recusa do servidor e falta de rede', () => {
    expect(loginProbeMessage('github', { status: 429 })).toContain('Espere');
    expect(loginProbeMessage('github', { status: 400 })).toContain('recusou');
    expect(loginProbeMessage('github', { network: true })).toContain('conexão');
  });
});

describe('loginExchangeMessage', () => {
  it('traduz cada código de troca para uma ação que a pessoa pode tomar', () => {
    expect(loginExchangeMessage('nenhum login pendente')).toContain('expirou');
    expect(loginExchangeMessage('state não confere com o login pendente')).toContain('Comece');
    expect(loginExchangeMessage('login superseded')).toContain('outro login');
    expect(loginExchangeMessage('exchange-network')).toContain('conexão');
    expect(loginExchangeMessage('exchange-storage')).toContain('cofre de credenciais');
    expect(loginExchangeMessage('exchange-license-invalid')).toContain('licença');
  });

  it('chaves herdadas do Object (constructor, toString) caem no texto genérico, não numa função', () => {
    for (const code of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(typeof loginExchangeMessage(code)).toBe('string');
    }
  });

  it('nunca repassa texto desconhecido do servidor para a interface', () => {
    const message = loginExchangeMessage('SQLSTATE 42P01 secret-detail');
    expect(message).not.toContain('SQLSTATE');
    expect(message).not.toContain('secret-detail');
    expect(message.length).toBeGreaterThan(20);
  });
});

it('o prazo do login pendente é de 10 minutos', () => {
  expect(LOGIN_PENDING_TTL_MS).toBe(10 * 60 * 1000);
});

describe('isStaleLoginCode', () => {
  it('link velho ou de outro login não derruba o login em andamento', () => {
    expect(isStaleLoginCode('nenhum login pendente')).toBe(true);
    expect(isStaleLoginCode('state não confere com o login pendente')).toBe(true);
  });

  it('falhas reais da troca continuam sendo falhas', () => {
    for (const code of ['exchange-http', 'exchange-network', 'exchange-storage', 'exchange-license-invalid', undefined]) {
      expect(isStaleLoginCode(code)).toBe(false);
    }
  });

  it('chaves herdadas do Object nunca contam como link velho', () => {
    expect(isStaleLoginCode('constructor')).toBe(false);
  });
});

it('lista os dois provedores em uma só ordem (GitHub primeiro)', () => {
  expect(LOGIN_PROVIDERS).toEqual(['github', 'google']);
});
