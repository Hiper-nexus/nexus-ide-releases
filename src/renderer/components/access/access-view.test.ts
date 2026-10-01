import { describe, expect, it } from 'vitest';
import type { AccessBlockedReason } from '../../../shared/billing-types';
import { accessPrimaryAction, accessTitle, ACCESS_COPY, paneStateView } from './access-view';

const REASONS = Object.keys(ACCESS_COPY) as AccessBlockedReason[];

describe('ACCESS_COPY', () => {
  it('o texto de apoio acrescenta o próximo passo e nunca repete o título', () => {
    for (const reason of REASONS) {
      if (reason === 'startup-pending') continue;
      const title = accessTitle(false, reason).toLowerCase();
      const copy = ACCESS_COPY[reason].toLowerCase();
      expect(copy.startsWith(title), `${reason}: copy repete o título`).toBe(false);
      expect(copy.includes(title), `${reason}: copy contém o título`).toBe(false);
    }
  });

  it('todo texto de apoio termina em ponto e diz o que fazer', () => {
    for (const reason of REASONS) expect(ACCESS_COPY[reason].endsWith('.')).toBe(true);
  });
});

describe('accessTitle', () => {
  it('cada motivo tem um título próprio que diz a situação, não o nome da tela', () => {
    const titles = REASONS.map(reason => accessTitle(false, reason));
    expect(new Set(titles).size).toBeGreaterThan(6);
    for (const title of titles) {
      expect(title.length).toBeGreaterThan(8);
      expect(title).not.toContain('undefined');
    }
  });

  it('enquanto consulta, o título é de progresso', () => {
    expect(accessTitle(true, null)).toBe('Consultando seu acesso');
    expect(accessTitle(true, 'startup-pending')).toBe('Consultando seu acesso');
  });

  it('sem motivo conhecido cai no cenário de verificação indisponível', () => {
    expect(accessTitle(false, null)).toBe(accessTitle(false, 'verification-unavailable'));
  });
});

describe('accessPrimaryAction', () => {
  it('quem precisa entrar ou reautenticar tem o login como ação principal', () => {
    for (const reason of ['login-required', 'invalid-license', 'license-expired', 'account-mismatch'] as const) {
      expect(accessPrimaryAction(reason, { isLoggedIn: false, canRetry: false })).toBe('login');
      expect(accessPrimaryAction(reason, { isLoggedIn: true, canRetry: false })).toBe('login');
    }
  });

  it('teste acabado ou assinatura inativa: assinar o Pro quando já está logado', () => {
    expect(accessPrimaryAction('trial-ended', { isLoggedIn: true, canRetry: false })).toBe('checkout');
    expect(accessPrimaryAction('inactive', { isLoggedIn: true, canRetry: false })).toBe('checkout');
  });

  it('teste acabado sem login ainda pede o login primeiro (a conta é de quem assina)', () => {
    expect(accessPrimaryAction('trial-ended', { isLoggedIn: false, canRetry: false })).toBe('login');
  });

  it('acesso suspenso se resolve no portal de cobrança', () => {
    expect(accessPrimaryAction('suspended', { isLoggedIn: true, canRetry: false })).toBe('portal');
  });

  it('verificação indisponível: tentar de novo vem antes de qualquer outra ação', () => {
    expect(accessPrimaryAction('verification-unavailable', { isLoggedIn: false, canRetry: true })).toBe('retry');
    expect(accessPrimaryAction('verification-unavailable', { isLoggedIn: true, canRetry: true })).toBe('retry');
  });

  it('retry só é principal quando a tentativa existe (canRetry)', () => {
    expect(accessPrimaryAction('verification-unavailable', { isLoggedIn: false, canRetry: false })).toBe('login');
  });

  it('sem motivo (consultando) não há ação principal que roube o foco', () => {
    expect(accessPrimaryAction(null, { isLoggedIn: false, canRetry: false })).toBe('login');
  });
});

describe('paneStateView', () => {
  it('estado nunca viaja só em cor: toda situação tem rótulo em texto', () => {
    for (const state of ['idle', 'busy', 'spawning', 'exited', 'hibernated', undefined, 'algo-novo']) {
      const view = paneStateView(state);
      expect(view.label.length).toBeGreaterThan(3);
    }
  });

  it('trabalhando e iniciando são "vivos"; aguardando é pronto; o resto é calmo', () => {
    expect(paneStateView('busy').tone).toBe('running');
    expect(paneStateView('spawning').tone).toBe('running');
    expect(paneStateView('idle').tone).toBe('ready');
    expect(paneStateView('hibernated').tone).toBe('pending');
    expect(paneStateView('exited').tone).toBe('pending');
    expect(paneStateView(undefined)).toEqual({ label: 'Preservado', tone: 'pending' });
  });

  it('mantém os rótulos que a tela já usava', () => {
    expect(paneStateView('hibernated').label).toBe('Em pausa');
    expect(paneStateView('busy').label).toBe('Trabalhando');
    expect(paneStateView('idle').label).toBe('Aguardando');
  });
});
