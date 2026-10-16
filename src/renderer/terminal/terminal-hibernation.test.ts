import { describe, expect, it } from 'vitest';
import {
  HIBERNATE_MIN_LIVE_HOSTS,
  shouldHibernateHost,
} from './terminal-host';

describe('shouldHibernateHost — hibernação de pane oculto em grid grande', () => {
  const base = {
    liveHosts: HIBERNATE_MIN_LIVE_HOSTS,
    isPaneVisible: false,
    isParked: false,
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

  it('limiar cobre 2 projetos abertos (6-8 panes cada = 12-16 hosts num Mac 24 GB)', () => {
    // 16/10: o limiar antigo (24) nunca hibernava o projeto em background de
    // um Mac com 2 projetos abertos. Ele precisa ficar abaixo do piso de 12.
    expect(HIBERNATE_MIN_LIVE_HOSTS).toBeLessThanOrEqual(12);
    expect(shouldHibernateHost({ ...base, liveHosts: 12 })).toBe(true);
    expect(shouldHibernateHost({ ...base, liveHosts: 16 })).toBe(true);
  });

  it('workspace oculto no app visível não descarta o xterm de uma sessão viva', () => {
    expect(shouldHibernateHost({ ...base, isParked: true })).toBe(false);
  });

  it('pane visível, sem sessão, mid-spawn ou held → nunca hiberna', () => {
    expect(shouldHibernateHost({ ...base, isPaneVisible: true })).toBe(false);
    expect(shouldHibernateHost({ ...base, hasSession: false })).toBe(false);
    expect(shouldHibernateHost({ ...base, opened: false })).toBe(false);
    expect(shouldHibernateHost({ ...base, spawnPending: true })).toBe(false);
    expect(shouldHibernateHost({ ...base, disposed: true })).toBe(false);
  });
});
