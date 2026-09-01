import { describe, expect, it } from 'vitest';
import {
  HIBERNATE_MIN_LIVE_HOSTS,
  shouldHibernateHost,
} from './terminal-host';

describe('shouldHibernateHost — hibernação de pane oculto em grid grande', () => {
  const base = {
    liveHosts: HIBERNATE_MIN_LIVE_HOSTS,
    isPaneVisible: false,
    opened: true,
    disposed: false,
    hasSession: true,
    spawnPending: false,
  };

  it('grid grande + pane oculto spawned → hiberna', () => {
    expect(shouldHibernateHost(base)).toBe(true);
  });

  it('grid pequeno nunca hiberna (custo não paga o risco)', () => {
    expect(
      shouldHibernateHost({ ...base, liveHosts: HIBERNATE_MIN_LIVE_HOSTS - 1 }),
    ).toBe(false);
  });

  it('pane visível, sem sessão, mid-spawn ou held → nunca hiberna', () => {
    expect(shouldHibernateHost({ ...base, isPaneVisible: true })).toBe(false);
    expect(shouldHibernateHost({ ...base, hasSession: false })).toBe(false);
    expect(shouldHibernateHost({ ...base, opened: false })).toBe(false);
    expect(shouldHibernateHost({ ...base, spawnPending: true })).toBe(false);
    expect(shouldHibernateHost({ ...base, disposed: true })).toBe(false);
  });
});
