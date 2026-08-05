/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MissionControlSnapshot } from '../../shared/mission-control-plane';
import { MissionControlBoard } from './MissionControlBoard';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function snapshot(
  patch: Partial<MissionControlSnapshot>,
): MissionControlSnapshot {
  return {
    missionId: 'mission-1',
    generatedAt: 1_000,
    panes: [],
    queue: [],
    ownership: [],
    blocks: [],
    ...patch,
  };
}

async function render(
  value: MissionControlSnapshot | null,
): Promise<{ host: HTMLDivElement; root: Root }> {
  Object.defineProperty(window, 'nexus', {
    value: { orch: { missionControlPlane: vi.fn(async () => value) } },
    configurable: true,
  });
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<MissionControlBoard missionId="mission-1" />);
  });
  return { host, root };
}

describe('MissionControlBoard', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('answers "is anything running?" before any scrolling', async () => {
    const { host, root } = await render(
      snapshot({
        panes: [
          {
            paneId: 'pane-a',
            sessionId: 'sess-a',
            title: 'Executor',
            state: 'busy',
            activity: 'working',
            agentName: 'Executor',
            currentTaskId: 'impl',
            currentTaskTitle: 'Implementar',
          },
        ],
        queue: [
          {
            taskId: 'impl',
            title: 'Implementar',
            status: 'running',
            waveHint: 1,
            dependsOn: [],
            agentName: 'Executor',
            stage: 'implementação',
            dispatchState: 'running',
          },
          {
            taskId: 'rev',
            title: 'Revisar',
            status: 'pending',
            waveHint: 2,
            dependsOn: ['impl'],
            agentName: 'Revisor',
            stage: 'revisão',
          },
        ],
      }),
    );

    const pulse = host.querySelector('[data-testid="mission-control-pulse"]');
    expect(pulse?.textContent).toContain('1 unidade trabalhando agora');
    expect(host.textContent).toContain('Fase sequencial');
    expect(host.textContent).toContain('Executor');
    expect(host.textContent).toContain('trabalhando');
    expect(host.textContent).toContain('Implementar');
    act(() => root.unmount());
  });

  it('keeps the mission readable when every pane was reaped', async () => {
    const { host, root } = await render(
      snapshot({
        panes: [],
        queue: [
          {
            taskId: 'impl',
            title: 'Implementar',
            status: 'pending',
            waveHint: 1,
            dependsOn: [],
            agentName: 'Executor',
            stage: 'implementação',
          },
        ],
        blocks: [
          { scope: 'mission', text: 'A missão parou antes do bootstrap.' },
        ],
      }),
    );

    // Panes fechados NUNCA podem significar trabalho invisível.
    expect(host.querySelector('[data-testid="mission-control-board"]')).not
      .toBeNull();
    expect(host.textContent).toContain('Nenhum pane vivo');
    expect(host.textContent).toContain('A missão parou antes do bootstrap.');
    expect(host.textContent).toContain('Implementar');
    act(() => root.unmount());
  });

  it('names the dead pane instead of hiding it', async () => {
    const { host, root } = await render(
      snapshot({
        panes: [
          {
            paneId: 'pane-dead',
            sessionId: null,
            title: 'Revisor',
            state: 'exited',
            activity: 'dead',
          },
        ],
      }),
    );

    expect(host.textContent).toContain('Revisor');
    expect(host.textContent).toContain('morto');
    act(() => root.unmount());
  });

  it('renders nothing when the mission has no control plane', async () => {
    const { host, root } = await render(null);
    expect(host.querySelector('[data-testid="mission-control-board"]')).toBeNull();
    act(() => root.unmount());
  });
});
