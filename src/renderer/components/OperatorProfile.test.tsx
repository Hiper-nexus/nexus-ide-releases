/** @vitest-environment jsdom */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const lifetimeStub = vi.hoisted(() => ({ value: null as unknown }));

vi.mock('./ChosenPetPortrait', () => ({ ChosenPetPortrait: () => null }));
vi.mock('./PixelIcon', () => ({ PixelIcon: () => null }));
vi.mock('../state/lifetime-usage', () => ({
  useLifetimeUsage: () => lifetimeStub.value,
}));

import { OperatorProfile } from './OperatorProfile';
import {
  EMPTY_GAMIFICATION_SNAPSHOT,
  useGamificationStore,
} from '../state/gamification-store';
import { useQuotaStore } from '../state/quota-store';
import { useWorkspaceStore } from '../state/workspace-store';
import type { GamificationSnapshot } from '../../shared/gamification-types';

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

const initialQuotaSnapshot = useQuotaStore.getState().snapshot;

beforeEach(() => {
  lifetimeStub.value = null;
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
  useQuotaStore.setState({ snapshot: initialQuotaSnapshot });
  useWorkspaceStore.setState({ current: null });
});

/** Perfil aberto com um snapshot específico; devolve o diálogo. */
function openWith(snapshot: Partial<GamificationSnapshot>): HTMLElement {
  useGamificationStore.setState({
    snapshot: { ...EMPTY_GAMIFICATION_SNAPSHOT, ...snapshot },
    profileOpen: true,
  });
  const host = render(<OperatorProfile />);
  const dialog = host.querySelector<HTMLElement>('[role="dialog"]');
  if (!dialog) throw new Error('Operator Profile dialog was not rendered');
  return dialog;
}

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

    expect(text).toContain('Faltam 868K XP para ELITE');
    expect(text).toContain('≈ 290 handoffs aceitos ou 87 missões');
    expect(text).toContain('+17.2K XP hoje');
    const recent = dialog.querySelector('[aria-label="Conquistas recentes"]');
    expect(recent?.textContent).toContain('Arquiteto de Times');
    expect(recent?.textContent).toContain('Primeiro Deploy');
    const feed = dialog.querySelector('.operator-profile__feed');
    expect(feed?.textContent).toContain('Handoff entregue');
    expect(feed?.textContent).toContain('Turno de agente ×12');
  });
});

describe('OperatorProfile content', () => {
  it('concorda o plural do ritmo: 1 dia útil seguido, nunca "1 dias"', () => {
    let stats = openWith({ streakDays: 1, shieldsLeft: 1 }).querySelector(
      '.operator-profile__stats',
    );
    expect(stats?.textContent).toContain('1 dia útil seguido');
    expect(stats?.textContent).toContain('1 escudo no mês');
    expect(stats?.textContent).not.toContain('1 dias');

    act(() => {
      for (const root of roots.splice(0)) root.unmount();
    });
    document.body.replaceChildren();

    stats = openWith({ streakDays: 5, shieldsLeft: 2 }).querySelector(
      '.operator-profile__stats',
    );
    expect(stats?.textContent).toContain('5 dias úteis seguidos');
    expect(stats?.textContent).toContain('2 escudos no mês');
  });

  it('nomeia o próximo tier e o projeto de onde vem o XP', () => {
    useWorkspaceStore.setState({
      current: { path: 'C:/work/nexus-ide', name: 'nexus-ide' } as never,
    });
    const dialog = openWith({ powerLevel: 17_400, nextTierAt: 100_000 });

    expect(
      dialog.querySelector('.operator-profile__next')?.textContent,
    ).toBe('Faltam 82.6K XP para INICIADO.');
    expect(
      dialog.querySelector('.operator-profile__scope')?.textContent,
    ).toBe('XP do projeto nexus-ide');
  });

  it('XP global: patente e poder somados, com detalhe por projeto', () => {
    const dialog = openWith({
      powerLevel: 6_886,
      tier: 'RECRUTA',
      nextTierAt: 100_000,
      global: {
        powerLevel: 105_886,
        tier: 'INICIADO',
        nextTierAt: 400_000,
        todayXp: 600,
        projectCount: 2,
        projects: [
          { label: 'hipergo', power: 99_000, current: false },
          { label: 'nexus-ide', power: 6_886, current: true },
        ],
      },
    });

    expect(dialog.querySelector('.operator-profile__tier')?.textContent).toBe('INICIADO');
    expect(dialog.querySelector('.operator-profile__scope')?.textContent).toBe('XP de 2 projetos');
    expect(dialog.querySelector('.operator-profile__next')?.textContent).toBe(
      'Faltam 294K XP para VETERANO.',
    );
    const rows = Array.from(dialog.querySelectorAll('.operator-profile__project'));
    expect(rows.map((row) => row.textContent)).toEqual(['hipergo99K', 'nexus-ide · aqui6.9K']);
    expect(dialog.querySelector('.operator-profile__project--current')).not.toBeNull();
  });

  it('só mostra o ramo quando o mascote já evoluiu', () => {
    expect(
      openWith({ branch: 'base' }).querySelector('.operator-profile__scope'),
    ).toBeNull();

    act(() => {
      for (const root of roots.splice(0)) root.unmount();
    });
    document.body.replaceChildren();

    expect(
      openWith({ branch: 'forja' }).querySelector('.operator-profile__scope')
        ?.textContent,
    ).toBe('Ramo Forja');
  });

  it('missão de passo único mostra anel pendente; só a de vários passos ganha barra', () => {
    // Com as três primeiras quests já cumpridas sobram "Meta do dia" (barra),
    // "Luz Verde" (alvo 1, anel) e "Manter o ritmo" (alvo 5, em 2/5, barra).
    const dialog = openWith({
      streakDays: 2,
      counters: { agent_turn: 1, jarvis_action: 1, mission_done: 1 },
    });
    const quests = dialog.querySelectorAll('.operator-profile__quest');

    expect(quests.length).toBe(3);
    expect(
      dialog.querySelectorAll('.operator-profile__quest-mark').length,
    ).toBe(quests.length);
    const bars = dialog.querySelectorAll(
      '.operator-profile__quest [role="progressbar"]',
    );
    // Só quest de vários passos ganha barra: a do dia e a de ritmo.
    expect(bars.length).toBe(2);
    const streak = [...bars].find((bar) => bar.getAttribute('aria-valuemax') === '5');
    expect(streak?.getAttribute('aria-valuenow')).toBe('2');
  });

  it('conquista desbloqueada diz "Conquistada" e o título da seção conta o total', () => {
    const dialog = openWith({ achievements: ['primeira-missao'] });
    const section = dialog.querySelector('[aria-labelledby$="-achievements"]');

    expect(
      section?.querySelector('.operator-profile__section-note')?.textContent,
    ).toBe('1 de 14');
    const live = section?.querySelectorAll('.operator-profile__achievement--live');
    expect(live?.length).toBe(1);
    expect(live?.[0].textContent).toContain('Conquistada');
    // Sem barra para conquista de passo único nem para a já desbloqueada.
    expect(section?.querySelectorAll('[role="progressbar"]').length).toBe(
      // centuriao (100), economico (10), sequencia-5, sequencia-20, maratona (50)
      5,
    );
  });

  it('consumo real: dinheiro em destaque e nota de planos com /mês e plural certo', () => {
    lifetimeStub.value = {
      tokensBurned: 12_100_000,
      usdEquivalent: 1215.35,
      mediaUsd: 0,
      panesServed: 53,
      turns: 7_000,
      missionsDone: 3,
      counters: {},
      level: 1,
      levelProgress: 0,
    };
    useQuotaStore.setState({
      snapshot: {
        ...initialQuotaSnapshot,
        plans: {
          monthlyUsd: 400,
          detected: 16,
          priced: 2,
          connected: 16,
          undetected: 0,
        },
      },
    });
    const dialog = openWith({ powerLevel: 17_400 });
    const consumo = dialog.querySelector('.operator-profile__consumo');

    expect(
      consumo?.querySelector('.operator-profile__consumo-money')?.textContent,
    ).toBe('$1215.35');
    expect(consumo?.textContent).toContain('economizados em assinatura');
    const facts = consumo?.querySelector('.operator-profile__facts');
    expect(facts?.textContent).toContain('tokens torrados');
    expect(facts?.textContent).toContain('12.1M');
    expect(
      consumo?.querySelector('.operator-profile__plans-note')?.textContent,
    ).toBe('Assinaturas: $400.00/mês em 2 planos com preço · 14 contas fora da soma.');
  });

  it('sem consumo disponível a seção some em vez de mostrar zeros falsos', () => {
    const dialog = openWith({ powerLevel: 17_400 });

    expect(dialog.querySelector('.operator-profile__consumo')).toBeNull();
  });

  it('feed mostra só os 8 mais recentes e sem rolagem aninhada', () => {
    const recent = Array.from({ length: 12 }, (_, index) => ({
      kind: 'agent_turn' as const,
      points: 300 + index,
      createdAt: Date.now() - index * 60_000,
    }));
    const dialog = openWith({ recent });
    const items = dialog.querySelectorAll('.operator-profile__feed-item');

    expect(items.length).toBe(8);
    expect(items[0].textContent).toContain('+300');
    expect(items[7].textContent).toContain('+307');
  });

  it('transcendência diz o número real e o rodapé aponta a entrada do menu lateral', () => {
    const dialog = openWith({ prestige: 7 });

    expect(dialog.querySelector('[aria-label="Transcendência 7"]')).not.toBeNull();
    expect(
      dialog.querySelector('.operator-profile__hint')?.textContent,
    ).toContain('cartão no menu lateral');
  });
});
