/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaneRouteProposal } from '../../shared/pane-route';
import {
  PaneRouteConfirm,
  initialEffort,
  type PaneRouteConfirmState,
} from './PaneRouteConfirm';

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const proposal = (over: Partial<PaneRouteProposal> = {}): PaneRouteProposal => ({
  tier: 'hard',
  reason: 'tier hard',
  source: 'jev',
  effort: 'high',
  ...over,
});

const ready = (over: Partial<PaneRouteProposal> = {}): PaneRouteConfirmState => ({
  kind: 'ready',
  proposal: proposal(over),
});

type Props = Parameters<typeof PaneRouteConfirm>[0];

function show(state: PaneRouteConfirmState, over: Partial<Props> = {}): Props {
  const props: Props = {
    state,
    adapterLabel: 'Claude',
    effort: initialEffort(state),
    onEffortChange: vi.fn(),
    onConfirm: vi.fn(),
    onCancel: vi.fn(),
    ...over,
  };
  act(() => root.render(<PaneRouteConfirm {...props} />));
  return props;
}

const radios = (): HTMLButtonElement[] =>
  [...host.querySelectorAll<HTMLButtonElement>('[role="radio"]')];

const radio = (name: string): HTMLButtonElement => {
  const found = radios().find((el) => el.textContent === name);
  if (!found) throw new Error(`sem rádio "${name}" — tem: ${radios().map((r) => r.textContent).join(', ')}`);
  return found;
};

const button = (name: string): HTMLButtonElement => {
  const found = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
    (el) => el.textContent === name,
  );
  if (!found) throw new Error(`sem botão "${name}"`);
  return found;
};

const click = (el: HTMLElement) => act(() => { el.click(); });

describe('PaneRouteConfirm', () => {
  it('mostra a CLI que o operador escolheu — o motor não a troca', () => {
    show(ready());
    expect(host.querySelector('.pane-route-confirm__cli')?.textContent).toBe('Claude');
  });

  it('diz quem decidiu — a escolha não pode parecer sorteio', () => {
    show(ready({ source: 'jev', specialty: 'security' }));
    const note = host.querySelector('.pane-route-confirm__note')?.textContent ?? '';
    expect(note).toContain('decidido pelo Jev');
    expect(note).toContain('security');
  });

  it('o esforço proposto já vem marcado', () => {
    show(ready({ effort: 'high' }));
    expect(radio('Alto').getAttribute('aria-checked')).toBe('true');
    expect(radio('Baixo').getAttribute('aria-checked')).toBe('false');
  });

  it('o operador troca o esforço ANTES do pane nascer', () => {
    const props = show(ready({ effort: 'high' }));
    click(radio('Baixo'));
    expect(props.onEffortChange).toHaveBeenCalledWith('low');
  });

  it('"A CLI decide" é opção de verdade e vale undefined', () => {
    const props = show(ready({ effort: 'high' }));
    click(radio('A CLI decide'));
    expect(props.onEffortChange).toHaveBeenCalledWith(undefined);
  });

  it('oferece exatamente os níveis do roteador, mais "a CLI decide"', () => {
    show(ready());
    expect(radios().map((r) => r.textContent)).toEqual([
      'A CLI decide',
      'Baixo',
      'Médio',
      'Alto',
      'Máximo',
    ]);
  });

  it('sem proposta o passo não inventa esforço', () => {
    const state: PaneRouteConfirmState = { kind: 'none' };
    expect(initialEffort(state)).toBeUndefined();
    show(state);
    expect(host.textContent).toContain('Sem proposta');
    expect(radio('A CLI decide').getAttribute('aria-checked')).toBe('true');
  });

  it('enquanto o Jev lê, o passo diz isso e não trava o Abrir', () => {
    show({ kind: 'loading' });
    expect(host.querySelector('[role="status"]')?.textContent).toContain('Lendo o pedido');
    expect(button('Abrir')).toBeTruthy();
  });

  it('a skill sugerida aparece só quando existe', () => {
    show(ready({ skill: 'oc-scout' }));
    expect(host.textContent).toContain('oc-scout');
    show(ready());
    expect(host.textContent).not.toContain('Skill sugerida');
  });

  it('Abrir e Voltar chamam os respectivos', () => {
    const props = show(ready());
    click(button('Abrir'));
    expect(props.onConfirm).toHaveBeenCalled();
    click(button('Voltar'));
    expect(props.onCancel).toHaveBeenCalled();
  });

  it('o grupo é rotulado para leitor de tela', () => {
    show(ready());
    const group = host.querySelector('[role="group"]');
    expect(group?.getAttribute('aria-label')).toContain('Claude');
    expect(host.querySelector('[role="radiogroup"]')?.getAttribute('aria-labelledby')).toBe(
      'pane-route-effort-label',
    );
  });
});
