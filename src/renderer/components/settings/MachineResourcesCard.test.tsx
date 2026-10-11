/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MachineResources } from '../../../shared/machine-resources';
import { usePaneFootprintStore } from '../../state/pane-footprint-store';
import { MachineResourcesCard } from './MachineResourcesCard';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;

function machineFixture(overrides: Partial<MachineResources> = {}): MachineResources {
  return {
    sampledAt: 1_000,
    memory: {
      totalBytes: 24 * GiB,
      availableBytes: 12 * GiB,
      usedRatio: 0.5,
      peakUsedRatio: 0.75,
      swapUsedBytes: 0,
      minFreeBytes: 3.6 * GiB,
    },
    cpu: { cores: 8, loadAvg1: 2.25, averageLoad1: 1.5 },
    nexus: { appBytes: 410 * MiB, panesBytes: 3 * GiB, paneCount: 4 },
    pressure: 'ok',
    admissionEnabled: true,
    window: { samples: 20, spanMs: 10 * 60_000 },
    ...overrides,
  };
}

const roots: Root[] = [];
let snapshot: ReturnType<typeof vi.fn>;

function render(): HTMLElement {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  act(() => root.render(<MachineResourcesCard />));
  return host;
}

beforeEach(() => {
  usePaneFootprintStore.setState({
    capturedAt: null,
    generation: 0,
    sequence: 0,
    bySessionId: {},
    systemMemory: null,
    machine: null,
  });
  snapshot = vi.fn().mockResolvedValue({});
  Object.assign(window, {
    nexus: { perf: { snapshot, onPaneFootprints: vi.fn(() => () => {}) } },
  });
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  delete (window as { nexus?: unknown }).nexus;
});

describe('MachineResourcesCard (F-1172)', () => {
  it('pede o snapshot ao montar e mostra memória, pico, CPU e o custo do Nexus', async () => {
    snapshot.mockResolvedValue({ machine: machineFixture() });
    const host = render();
    await act(async () => {
      await Promise.resolve();
    });
    expect(snapshot).toHaveBeenCalledTimes(1);
    expect(window.nexus.perf.onPaneFootprints).toHaveBeenCalled();

    const card = host.querySelector('section[aria-labelledby]')!;
    expect(card.textContent).toContain('Recursos da máquina');
    const meter = host.querySelector('[role="meter"]')!;
    expect(meter.getAttribute('aria-valuenow')).toBe('50');
    expect(meter.getAttribute('aria-valuetext')).toContain('12 GB de 24 GB em uso');
    expect(card.textContent).toContain('12 GB de 24 GB em uso (50%)');
    expect(card.textContent).toContain('Pico nos últimos 10 min: 75%');
    expect(card.textContent).toContain('2,25 em 8 núcleos');
    expect(card.textContent).toContain('3 GB em 4 panes');
    expect(card.textContent).toContain('410 MB');
    const status = host.querySelector('[role="status"]')!;
    expect(status.textContent).toContain('Memória com folga');
  });

  it('sob pressão o veredito diz o que o Nexus está fazendo, em texto (não só cor)', () => {
    usePaneFootprintStore.setState({
      machine: machineFixture({
        pressure: 'pressure',
        memory: { ...machineFixture().memory, availableBytes: 2 * GiB, usedRatio: 22 / 24 },
      }),
    });
    const host = render();
    const status = host.querySelector('[role="status"]')!;
    expect(status.textContent).toContain('Pressão de memória');
    expect(status.textContent).toContain('2 GB disponíveis, abaixo da reserva de 3,6 GB');
    expect(host.querySelector('.machine-resources--pressure')).not.toBeNull();
    const actions = host.textContent ?? '';
    expect(actions).toContain('estaciona o pane ocioso mais antigo');
    expect(actions).toContain('workers automáticos');
    expect(actions).toContain('avisa antes de abrir um pane novo');
  });

  it('sem leitura do gate não inventa número nem folga', () => {
    usePaneFootprintStore.setState({
      machine: machineFixture({
        pressure: 'unknown',
        memory: { ...machineFixture().memory, availableBytes: null, usedRatio: null, peakUsedRatio: null },
        cpu: { cores: 8, loadAvg1: null, averageLoad1: null },
        nexus: { appBytes: null, panesBytes: null, paneCount: 0 },
      }),
    });
    const host = render();
    expect(host.querySelector('[role="status"]')!.textContent).toContain('Sem leitura de memória');
    expect(host.querySelector('[role="meter"]')).toBeNull();
    expect(host.textContent).toContain('Carga de CPU indisponível neste sistema');
    expect(host.textContent).not.toContain('0 MB');
  });

  it('gate desligado é dito ao operador', () => {
    usePaneFootprintStore.setState({ machine: machineFixture({ admissionEnabled: false }) });
    const host = render();
    expect(host.textContent).toContain('NEXUS_PANE_GUARD=off');
  });

  it('antes da primeira leitura mostra estado de carregamento', () => {
    snapshot.mockReturnValue(new Promise(() => {}));
    const host = render();
    expect(host.textContent).toContain('Lendo os recursos da máquina');
  });
});
