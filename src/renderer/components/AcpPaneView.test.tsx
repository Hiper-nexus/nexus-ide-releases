/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AcpPaneView } from './AcpPaneView';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

function event(overrides: Record<string, unknown> = {}) {
  return {
    sequence: 1,
    id: 'event-1',
    missionId: 'mission-1',
    runId: 'run-1',
    type: 'observer.turn_started',
    payload: { observer: { turnSequence: 3 } },
    idempotencyKey: 'event-key-1',
    occurredAt: 1_735_000_000_000,
    origin: 'main',
    deliveryStatus: 'delivered',
    ...overrides,
  };
}

function mount(): HTMLDivElement {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  act(() => root.render(<AcpPaneView missionId="mission-1" />));
  return host;
}

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

afterEach(() => {
  act(() => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.innerHTML = '';
  Reflect.deleteProperty(window, 'nexus');
  vi.restoreAllMocks();
});

describe('AcpPaneView', () => {
  it('projects typed observer frames into a live activity feed and drops malformed rows', async () => {
    const missionEventsRecent = vi.fn(async () => ({
      events: [
        event(),
        event({
          sequence: 2,
          id: 'event-2',
          type: 'observer.tool_call',
          payload: { observer: { toolName: 'Read' } },
          idempotencyKey: 'event-key-2',
        }),
        { not: 'a mission event' },
      ],
    }));
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: { orch: { missionEventsRecent } },
    });

    const host = mount();
    await flushEffects();

    expect(missionEventsRecent).toHaveBeenCalledWith({
      missionId: 'mission-1',
      limit: 32,
    });
    expect(host.textContent).toContain('Atividade estruturada');
    expect(host.textContent).toContain('Turn 3 iniciado');
    expect(host.textContent).toContain('Ferramenta Read acionada');
    expect(host.textContent).not.toContain('a mission event');
    expect(host.querySelectorAll('.acp-pane__events li')).toHaveLength(2);
  });

  it('shows a retryable boundary error while preserving the semantic surface', async () => {
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: {
        orch: {
          missionEventsRecent: vi.fn(async () => ({
            events: [],
            error: 'timeline indisponível',
          })),
        },
      },
    });

    const host = mount();
    await flushEffects();

    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      'timeline indisponível',
    );
    expect(host.textContent).toContain('Aguardando o primeiro evento do agente.');
  });
});
