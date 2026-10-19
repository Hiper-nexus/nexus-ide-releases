/** @vitest-environment jsdom */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelPicker } from './ModelPicker';
import type { RankedModelOption } from '../../lib/model-picker-rank';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mountedRoots: Root[] = [];

function render(node: ReactNode): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  mountedRoots.push(root);
  act(() => root.render(node));
  return host;
}

afterEach(() => {
  for (const root of mountedRoots.splice(0)) {
    act(() => root.unmount());
  }
  document.body.replaceChildren();
});

const OPTIONS: RankedModelOption[] = [
  {
    adapterId: 'claude',
    adapterLabel: 'Claude',
    adapterIcon: '◆',
    model: 'sonnet',
    isDefault: true,
    ready: true,
    costRank: 4,
    quotaWorst: 0.35,
  },
  {
    adapterId: 'codex',
    adapterLabel: 'Codex',
    adapterIcon: '⬡',
    model: 'gpt-5.3-codex',
    isDefault: true,
    ready: false,
    reason: 'sessão necessária — rode `codex login`',
    costRank: 4,
    quotaWorst: 0.1,
  },
];

describe('ModelPicker', () => {
  it('agrupa por provider com logo, quota e modelos ordenados', () => {
    const onSelect = vi.fn();
    const host = render(
      <ModelPicker
        options={OPTIONS}
        quotaLineByAdapterId={{ claude: '5 Horas 35%' }}
        selected={{ adapterId: 'claude', model: 'sonnet' }}
        onSelect={onSelect}
      />,
    );
    expect(host.textContent).toContain('Claude');
    expect(host.textContent).toContain('Codex');
    expect(host.textContent).toContain('5 Horas 35%');
    expect(host.textContent).toContain('sonnet');
    expect(
      host.querySelector('[role="img"]')?.getAttribute('aria-label'),
    ).toContain('Claude');
    const selected = host.querySelector('.model-picker__model--selected');
    expect(selected?.textContent).toContain('sonnet');
  });

  it('modelo sem sessão fica desabilitado com o motivo, sem sumir', () => {
    const onSelect = vi.fn();
    const host = render(<ModelPicker options={OPTIONS} onSelect={onSelect} />);
    const locked = host.querySelector<HTMLButtonElement>(
      '.model-picker__model:disabled',
    );
    expect(locked).not.toBeNull();
    expect(locked?.textContent).toContain('codex login');
    act(() => {
      locked?.click();
    });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('modelo pronto seleciona ao clicar', () => {
    const onSelect = vi.fn();
    const host = render(<ModelPicker options={OPTIONS} onSelect={onSelect} />);
    const ready = host.querySelectorAll<HTMLButtonElement>(
      '.model-picker__model:not(:disabled)',
    );
    act(() => {
      ready[0]?.click();
    });
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ adapterId: 'claude', model: 'sonnet' }),
    );
  });

  it('sem CLIs mostra estado vazio acionável', () => {
    const host = render(<ModelPicker options={[]} onSelect={vi.fn()} />);
    expect(host.textContent).toContain('Nenhuma CLI disponível');
  });
});
