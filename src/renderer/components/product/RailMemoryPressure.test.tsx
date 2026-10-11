/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MachineResources } from '../../../shared/machine-resources';
import { usePaneFootprintStore } from '../../state/pane-footprint-store';
import { useProductNavigationStore } from '../../state/product-navigation-store';
import { RailMemoryPressure } from './RailMemoryPressure';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const GiB = 1024 ** 3;

function machine(pressure: MachineResources['pressure']): MachineResources {
  return {
    sampledAt: 1_000,
    memory: {
      totalBytes: 24 * GiB,
      availableBytes: 2 * GiB,
      usedRatio: 22 / 24,
      peakUsedRatio: 22 / 24,
      swapUsedBytes: 0,
      minFreeBytes: 3.6 * GiB,
    },
    cpu: { cores: 8, loadAvg1: 3, averageLoad1: 2 },
    nexus: { appBytes: null, panesBytes: null, paneCount: 0 },
    pressure,
    admissionEnabled: true,
    window: { samples: 1, spanMs: 0 },
  };
}

const roots: Root[] = [];
let onPaneFootprints: ReturnType<typeof vi.fn>;

function render(onOpen?: () => void): HTMLElement {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  act(() => root.render(<RailMemoryPressure onOpen={onOpen} />));
  return host;
}

beforeEach(() => {
  usePaneFootprintStore.setState({ machine: null });
  onPaneFootprints = vi.fn(() => () => {});
  Object.assign(window, { nexus: { perf: { onPaneFootprints } } });
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  delete (window as { nexus?: unknown }).nexus;
});

describe('RailMemoryPressure (F-1172)', () => {
  it('assina o push e fica invisível sem pressão (ok, desconhecido ou sem leitura)', () => {
    const host = render();
    expect(onPaneFootprints).toHaveBeenCalled();
    expect(host.querySelector('button')).toBeNull();
    act(() => usePaneFootprintStore.setState({ machine: machine('ok') }));
    expect(host.querySelector('button')).toBeNull();
    act(() => usePaneFootprintStore.setState({ machine: machine('unknown') }));
    expect(host.querySelector('button')).toBeNull();
  });

  it('sob pressão aparece com texto e rótulo acessível, não só cor', () => {
    usePaneFootprintStore.setState({ machine: machine('pressure') });
    const host = render();
    const button = host.querySelector('button')!;
    expect(button.textContent).toContain('Memória sob pressão');
    expect(button.textContent).toContain('2 GB livres');
    expect(button.getAttribute('aria-label')).toBe(
      'Pressão de memória: 2 GB disponíveis, abaixo da reserva de 3,6 GB. Abrir Recursos da máquina',
    );
    expect(host.querySelector('[role="status"]')).not.toBeNull();
  });

  it('clique leva a Uso e cotas (handler do rail ou navegação padrão)', () => {
    usePaneFootprintStore.setState({ machine: machine('pressure') });
    const onOpen = vi.fn();
    const host = render(onOpen);
    act(() => host.querySelector('button')!.click());
    expect(onOpen).toHaveBeenCalledTimes(1);

    act(() => roots.splice(0).forEach((root) => root.unmount()));
    document.body.replaceChildren();
    const fallback = render();
    act(() => fallback.querySelector('button')!.click());
    expect(useProductNavigationStore.getState().destination).toEqual({
      kind: 'settings',
      section: 'usage-quota',
    });
  });
});
