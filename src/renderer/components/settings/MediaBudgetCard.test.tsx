/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MediaBudgetCard } from './MediaBudgetCard';

/** F-1606 — cartão do teto de gasto de mídia. */

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
const api = { get: vi.fn(), set: vi.fn() };

function input(label: string): HTMLInputElement {
  const found = [...host.querySelectorAll('label')].find((item) => item.textContent?.includes(label))?.querySelector('input');
  if (!found) throw new Error(`campo ${label} ausente`);
  return found;
}

function type(field: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function save() {
  const button = [...host.querySelectorAll('button')].find((item) => item.textContent?.includes('Salvar teto'))!;
  await act(async () => {
    button.click();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  api.get.mockResolvedValue({ limits: { perMissionUsd: null, perDayUsd: 5 }, spentTodayUsd: 1.234 });
  Object.defineProperty(window, 'nexus', { configurable: true, value: { mediaBudget: api } });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  Reflect.deleteProperty(window, 'nexus');
});

describe('Teto de gasto de mídia', () => {
  it('mostra os limites salvos e o gasto de hoje', async () => {
    await act(async () => {
      root.render(<MediaBudgetCard />);
    });
    expect(input('Por missão').value).toBe('');
    expect(input('Por dia').value).toBe('5');
    expect(host.textContent).toContain('Gasto de mídia hoje: US$ 1,23.');
  });

  it('salva em dólar com vírgula; em branco é sem teto; valor inválido não vai ao Main', async () => {
    api.set.mockResolvedValue({ ok: true, limits: { perMissionUsd: 2.5, perDayUsd: null }, spentTodayUsd: 0 });
    await act(async () => {
      root.render(<MediaBudgetCard />);
    });
    type(input('Por missão'), '2,50');
    type(input('Por dia'), '');
    await save();
    expect(api.set).toHaveBeenCalledWith({ perMissionUsd: 2.5, perDayUsd: null });
    expect(host.textContent).toContain('Teto salvo');
    type(input('Por dia'), 'muito');
    await save();
    expect(api.set).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Use um valor em dólar');
  });

  it('sem a ponte do preload não desenha nada', async () => {
    Reflect.deleteProperty(window, 'nexus');
    await act(async () => {
      root.render(<MediaBudgetCard />);
    });
    expect(host.innerHTML).toBe('');
  });
});
