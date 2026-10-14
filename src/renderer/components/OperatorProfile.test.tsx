/** @vitest-environment jsdom */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./ChosenPetPortrait', () => ({ ChosenPetPortrait: () => null }));
vi.mock('./PixelIcon', () => ({ PixelIcon: () => null }));

import { OperatorProfile } from './OperatorProfile';
import {
  EMPTY_GAMIFICATION_SNAPSHOT,
  useGamificationStore,
} from '../state/gamification-store';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

function ProfileHarness() {
  return (
    <>
      <button
        type="button"
        onClick={() => useGamificationStore.setState({ profileOpen: true })}
      >
        Abrir Perfil de Operador
      </button>
      <OperatorProfile />
    </>
  );
}

function render(node: ReactNode): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  act(() => root.render(node));
  return host;
}

function renderHarness(): HTMLButtonElement {
  const host = render(<ProfileHarness />);
  const invoker = host.querySelector<HTMLButtonElement>('button');
  if (!invoker) throw new Error('Operator Profile invoker was not rendered');
  return invoker;
}

function openFrom(invoker: HTMLButtonElement): HTMLElement {
  act(() => {
    invoker.focus();
    invoker.click();
  });
  const dialog = document.querySelector<HTMLElement>(
    '[role="dialog"][aria-modal="true"]',
  );
  if (!dialog) throw new Error('Operator Profile dialog was not rendered');
  return dialog;
}

function referencedText(element: HTMLElement, attribute: string): string {
  return (element.getAttribute(attribute) ?? '')
    .split(/\s+/u)
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent?.trim() ?? '')
    .filter(Boolean)
    .join(' ');
}

function focusables(dialog: HTMLElement): HTMLElement[] {
  return Array.from(
    dialog.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((element) => element.getAttribute('aria-hidden') !== 'true');
}

function keydown(target: EventTarget, key: string, shiftKey = false): void {
  act(() =>
    target.dispatchEvent(
      new KeyboardEvent('keydown', {
        key,
        shiftKey,
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
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

describe('OperatorProfile modal behavior', () => {
  it('has a rendered accessible title and description and moves initial focus inside', () => {
    const invoker = renderHarness();

    const dialog = openFrom(invoker);

    expect(referencedText(dialog, 'aria-labelledby')).toBe(
      'Perfil de Operador',
    );
    expect(referencedText(dialog, 'aria-describedby').length).toBeGreaterThan(
      0,
    );
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(invoker);
  });

  it('traps Tab and Shift+Tab through every enabled profile control', () => {
    const dialog = openFrom(renderHarness());
    const controls = focusables(dialog);
    expect(controls.length).toBeGreaterThan(2);

    for (const [index, control] of controls.entries()) {
      control.focus();
      keydown(control, 'Tab');
      expect(document.activeElement).toBe(
        controls[(index + 1) % controls.length],
      );
    }

    for (const [index, control] of controls.entries()) {
      control.focus();
      keydown(control, 'Tab', true);
      expect(document.activeElement).toBe(
        controls[(index - 1 + controls.length) % controls.length],
      );
    }
  });

  it('closes on Escape or backdrop click and restores focus to the invoker', () => {
    const invoker = renderHarness();

    let dialog = openFrom(invoker);
    keydown(document.activeElement ?? dialog, 'Escape');
    expect(useGamificationStore.getState().profileOpen).toBe(false);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(invoker);

    dialog = openFrom(invoker);
    const backdrop = dialog.parentElement;
    if (!backdrop) throw new Error('Operator Profile backdrop was not rendered');
    act(() => backdrop.click());
    expect(useGamificationStore.getState().profileOpen).toBe(false);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(invoker);
  });
});

describe('OperatorProfile progress readout', () => {
  it('names the next tier, what is left, today XP, recent unlocks and grouped feed', () => {
    const now = Date.now();
    useGamificationStore.setState({
      snapshot: {
        ...EMPTY_GAMIFICATION_SNAPSHOT,
        powerLevel: 631_975,
        tier: 'VETERANO',
        tierFloor: 'VETERANO',
        nextTierAt: 1_500_000,
        streakDays: 2,
        todayXp: 17_225,
        achievements: ['primeiro-comando', 'primeira-missao', 'primeira-agentica'],
        counters: { agent_turn: 6_581, handoff_success: 8 },
        recent: [
          { kind: 'handoff_success', points: 3_000, createdAt: now, count: 1 },
          { kind: 'agent_turn', points: 900, createdAt: now - 60_000, count: 12 },
        ],
      },
    });
    const dialog = openFrom(renderHarness());
    const text = dialog.textContent ?? '';

    expect(text).toContain('faltam 868K XP para ELITE');
    expect(text).toContain('≈ 290 handoffs aceitos ou 87 missões');
    expect(text).toContain('+17.2K XP hoje');
    const recent = dialog.querySelector('[aria-label="Conquistas recentes"]');
    expect(recent?.textContent).toContain('Arquiteto de Times');
    expect(recent?.textContent).toContain('Primeiro Deploy');
    const feed = dialog.querySelector('[aria-label="Feed de XP"]');
    expect(feed?.textContent).toContain('Handoff entregue');
    expect(feed?.textContent).toContain('Turno de agente ×12');
  });
});
