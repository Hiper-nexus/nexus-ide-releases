/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GamificationSnapshot } from '../../shared/gamification-types';
import {
  EMPTY_GAMIFICATION_SNAPSHOT,
  useGamificationStore,
} from '../state/gamification-store';
import { OperatorHud } from './OperatorHud';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

function live(overrides: Partial<GamificationSnapshot> = {}): GamificationSnapshot {
  return {
    ...EMPTY_GAMIFICATION_SNAPSHOT,
    projectId: 'project-a',
    checkoutId: 'checkout-main',
    rootRealPath: '/workspace/a',
    powerLevel: 631_975,
    tier: 'VETERANO',
    tierFloor: 'VETERANO',
    nextTierAt: 1_500_000,
    todayXp: 17_225,
    ...overrides,
  };
}

function render(): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  act(() => root.render(<OperatorHud />));
  return host;
}

beforeEach(() => {
  useGamificationStore.setState({
    snapshot: EMPTY_GAMIFICATION_SNAPSHOT,
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

describe('OperatorHud no rail', () => {
  it('stays out until the main snapshot arrives and in sober mode', () => {
    const host = render();
    expect(host.querySelector('.operator-hud')).toBeNull();

    act(() => useGamificationStore.setState({ snapshot: live(), sober: true }));
    expect(host.querySelector('.operator-hud')).toBeNull();
  });

  it('shows level, power, within-tier bar, today XP and what is left', () => {
    useGamificationStore.setState({ snapshot: live() });
    const host = render();
    const hud = host.querySelector<HTMLButtonElement>('button.operator-hud');
    expect(hud).not.toBeNull();
    const text = hud?.textContent ?? '';
    expect(text).toContain('Lv 3');
    expect(text).toContain('VETERANO');
    expect(text).toContain('632K');
    expect(text).toContain('+17.2K hoje');
    expect(text).toContain('868K p/ ELITE');
    const fill = hud?.querySelector<HTMLElement>('.operator-hud__bar-fill');
    // Barra DENTRO do tier (400K→1.5M), não poder/próximo absoluto.
    expect(fill?.style.transform).toBe(`scaleX(${(631_975 - 400_000) / 1_100_000})`);
    expect(hud?.getAttribute('aria-label')).toMatch(/nível 3, VETERANO/);
  });

  it('pops +N only when XP grows inside the same project', () => {
    useGamificationStore.setState({ snapshot: live() });
    const host = render();
    expect(host.querySelector('.operator-hud__gain')).toBeNull();

    act(() =>
      useGamificationStore.setState({ snapshot: live({ powerLevel: 634_975 }) }),
    );
    expect(host.querySelector('.operator-hud__gain')?.textContent).toBe('+3K');

    act(() =>
      useGamificationStore.setState({
        snapshot: live({ projectId: 'project-b', powerLevel: 900_000 }),
      }),
    );
    // Trocar de projeto não é ganho: o chip some em vez de mostrar +268K.
    expect(host.querySelector('.operator-hud__gain')).toBeNull();
  });

  it('opens the profile on click', () => {
    const openProfile = vi.fn();
    useGamificationStore.setState({ snapshot: live(), openProfile });
    const host = render();
    act(() => host.querySelector<HTMLButtonElement>('button.operator-hud')?.click());
    expect(openProfile).toHaveBeenCalledTimes(1);
  });
});
