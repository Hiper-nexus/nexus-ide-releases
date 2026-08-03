/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MissionTaskScheduleItem } from '../../shared/mission-task-schedule';
import { MissionWaveSchedule } from './MissionWaveSchedule';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function item(patch: Partial<MissionTaskScheduleItem>): MissionTaskScheduleItem {
  return {
    taskId: 'task-x',
    title: 'Tarefa',
    agentName: null,
    agentCategory: null,
    stage: null,
    status: 'pending',
    dependsOn: [],
    waveHint: 1,
    ...patch,
  };
}

async function render(tasks: MissionTaskScheduleItem[]): Promise<{
  host: HTMLDivElement;
  root: Root;
}> {
  Object.defineProperty(window, 'nexus', {
    value: {
      orch: {
        missionTaskSchedule: vi.fn(async () => ({ tasks })),
      },
    },
    configurable: true,
  });
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<MissionWaveSchedule missionId="mission-1" />);
  });
  return { host, root };
}

describe('MissionWaveSchedule', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('groups tasks by wave and states the single-writer rule', async () => {
    const { host, root } = await render([
      item({ taskId: 'impl', title: 'Implementar', agentName: 'Executor', stage: 'implementação', status: 'running', waveHint: 1 }),
      item({ taskId: 'rev', title: 'Revisar', agentName: 'Revisor', stage: 'revisão', waveHint: 2, dependsOn: ['impl'] }),
    ]);

    expect(host.textContent).toContain('Cronograma de ondas');
    expect(host.textContent).toContain('single-writer');
    expect(host.textContent).toContain('Onda 1');
    expect(host.textContent).toContain('Onda 2');
    expect(host.textContent).toContain('Implementar — Executor (implementação) · ativo');
    expect(host.textContent).toContain('Revisar — Revisor (revisão) · pendente');
    act(() => root.unmount());
  });

  it('renders nothing when the mission has no schedule', async () => {
    const { host, root } = await render([]);
    expect(host.querySelector('[data-testid="mission-wave-schedule"]')).toBeNull();
    act(() => root.unmount());
  });
});
