import { describe, expect, it } from 'vitest';
import { accountSessionBadge, isSessionExpiredError } from './account-session-badge';

const base = { loading: false, isLoggedIn: true, licenseUnconfirmed: false, sessionExpired: false };

describe('accountSessionBadge', () => {
  it('says "conectado" in green only when nothing contradicts it', () => {
    expect(accountSessionBadge(base)).toEqual({ label: 'conectado', tone: 'in', offerRelogin: false });
  });

  it('never shows green "conectado" when the subscription could not be confirmed', () => {
    const badge = accountSessionBadge({ ...base, licenseUnconfirmed: true });
    expect(badge).toEqual({ label: 'a confirmar', tone: 'warn', offerRelogin: true });
  });

  it('shows "sessão expirada" with a re-login offer when the server rejected the session', () => {
    const badge = accountSessionBadge({ ...base, sessionExpired: true, licenseUnconfirmed: true });
    expect(badge).toEqual({ label: 'sessão expirada', tone: 'warn', offerRelogin: true });
  });

  it('keeps loading and local states', () => {
    expect(accountSessionBadge({ ...base, loading: true }).tone).toBe('loading');
    expect(accountSessionBadge({ ...base, isLoggedIn: false, sessionExpired: true }))
      .toEqual({ label: 'local', tone: 'local', offerRelogin: false });
  });
});

describe('isSessionExpiredError', () => {
  it('matches the Main 401 message and nothing else', () => {
    expect(isSessionExpiredError('Sua sessão Nexus expirou — saia e entre de novo na conta')).toBe(true);
    expect(isSessionExpiredError('sem conexão')).toBe(false);
    expect(isSessionExpiredError(null)).toBe(false);
    expect(isSessionExpiredError(undefined)).toBe(false);
  });
});
