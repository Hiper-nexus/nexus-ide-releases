/** @vitest-environment jsdom */
/**
 * A lata do pane focado: abre com estalo ao ganhar foco, dá um gole quando o
 * XP do perfil sobe e some do DOM quando a cena termina (custo zero parada).
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GamificationSnapshot } from '../../shared/gamification-types';
import {
  EMPTY_GAMIFICATION_SNAPSHOT,
  useGamificationStore,
} from '../state/gamification-store';
import { PaneEnergyCan, SIP_COOLDOWN_MS } from './PaneEnergyCan';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
let clock = 0;
const now = () => clock;

function profile(powerLevel: number, projectId = 'project-a'): GamificationSnapshot {
  return {
    ...EMPTY_GAMIFICATION_SNAPSHOT,
    projectId,
    checkoutId: 'checkout-main',
    rootRealPath: '/workspace/a',
    powerLevel,
  };
}

function render(visible = true): { host: HTMLElement; root: Root } {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  act(() => root.render(<PaneEnergyCan visible={visible} now={now} />));
  return { host, root };
}

function gain(powerLevel: number): void {
  act(() => useGamificationStore.setState({ snapshot: profile(powerLevel) }));
}

function finish(host: HTMLElement): void {
  const svg = host.querySelector('svg.spill-corner');
  if (!svg) throw new Error('lata ausente');
  // jsdom não tem AnimationEvent: o React escuta a variante webkit ali.
  for (const type of ['animationend', 'webkitAnimationEnd']) {
    const event = new Event(type, { bubbles: true });
    Object.defineProperty(event, 'animationName', { value: 'spill-corner-out' });
    act(() => {
      svg.dispatchEvent(event);
    });
  }
}

beforeEach(() => {
  clock = 1_000_000;
  useGamificationStore.setState({
    snapshot: profile(10_000),
    sober: false,
    profileOpen: false,
  });
});

afterEach(() => {
  act(() => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
});

describe('PaneEnergyCan', () => {
  it('does not start an opening animation outside the viewport or in sober mode', () => {
    expect(render(false).host.querySelector('svg')).toBeNull();
    act(() => useGamificationStore.setState({ sober: true }));
    expect(render().host.querySelector('svg')).toBeNull();
  });

  it('dismisses an active scene when sober mode is enabled', () => {
    const { host } = render();
    expect(host.querySelector('svg')).not.toBeNull();
    act(() => useGamificationStore.setState({ sober: true }));
    expect(host.querySelector('svg')).toBeNull();
    act(() => useGamificationStore.setState({ sober: false }));
    expect(host.querySelector('svg')).toBeNull();
  });

  it('dismisses a scene when its pane leaves the viewport and does not replay it on return', () => {
    const { host, root } = render();
    act(() => root.render(<PaneEnergyCan visible={false} now={now} />));
    expect(host.querySelector('svg')).toBeNull();
    act(() => root.render(<PaneEnergyCan visible now={now} />));
    expect(host.querySelector('svg')).toBeNull();
  });

  it('abre com estalo ao ganhar foco e sai do DOM quando a cena acaba', () => {
    const { host } = render();
    const svg = host.querySelector('svg.spill-corner');
    expect(svg?.classList.contains('spill-corner--live')).toBe(true);
    expect(svg?.classList.contains('spill-corner--open')).toBe(true);

    finish(host);
    expect(host.querySelector('svg.spill-corner')).toBeNull();
  });

  it('dá um gole com o XP que entrou, depois do resfriamento', () => {
    const { host } = render();
    finish(host);

    clock += SIP_COOLDOWN_MS;
    gain(13_000);
    const svg = host.querySelector('svg.spill-corner');
    expect(svg?.classList.contains('spill-corner--sip')).toBe(true);
    expect(svg?.querySelector('.spill__xp')?.textContent).toBe('+3K XP');

    finish(host);
    expect(host.querySelector('svg.spill-corner')).toBeNull();
  });

  it('não interrompe a abertura e ignora rajadas dentro do resfriamento', () => {
    const { host } = render();
    gain(10_300);
    expect(host.querySelector('svg.spill-corner--sip')).toBeNull();

    clock += SIP_COOLDOWN_MS;
    gain(10_600);
    expect(host.querySelector('svg.spill-corner--sip')).not.toBeNull();
    clock += 1_000;
    gain(10_900);
    expect(host.querySelector('.spill__xp')?.textContent).toBe('+300 XP');
  });

  it('fica quieta em modo sóbrio, fora de vista e ao trocar de projeto', () => {
    const { host } = render(false);
    clock += SIP_COOLDOWN_MS;
    gain(20_000);
    expect(host.querySelector('svg.spill-corner')).toBeNull();

    const visibleCan = render(true);
    finish(visibleCan.host);
    clock += SIP_COOLDOWN_MS;
    act(() => useGamificationStore.setState({ sober: true }));
    gain(30_000);
    expect(visibleCan.host.querySelector('svg.spill-corner')).toBeNull();

    act(() => useGamificationStore.setState({ sober: false }));
    act(() =>
      useGamificationStore.setState({ snapshot: profile(90_000, 'project-b') }),
    );
    expect(visibleCan.host.querySelector('svg.spill-corner')).toBeNull();
  });
});
