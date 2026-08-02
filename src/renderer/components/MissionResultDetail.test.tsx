/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import type { Mission, MissionStatus } from '../../shared/orch-types';
import { MissionResultDetail } from './MissionResultDetail';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function mission(status: MissionStatus): Mission {
  return {
    id: `mission-${status}`,
    title: `Missão ${status}`,
    description: '',
    status,
    milestones: [],
    learnings: '',
    createdAt: 1_000,
    updatedAt: 2_000,
  };
}

function renderStatus(status: MissionStatus): {
  host: HTMLDivElement;
  root: Root;
} {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(<MissionResultDetail mission={mission(status)} onBack={() => {}} />));
  return { host, root };
}

describe('MissionResultDetail status presentation', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('presents an active mission as in progress, never as closed', () => {
    const { host, root } = renderStatus('running');
    expect(host.textContent).toContain('Em andamento');
    expect(host.textContent).toContain('A missão está em andamento');
    expect(host.textContent).not.toContain('ENCERRADA');
    expect(host.textContent).not.toContain(
      'Esta missão foi encerrada sem relatório final persistido.',
    );
    act(() => root.unmount());
  });

  it('presents a pending mission as planned', () => {
    const { host, root } = renderStatus('pending');
    expect(host.textContent).toContain('Planejada');
    expect(host.textContent).toContain('A missão ainda não começou');
    act(() => root.unmount());
  });

  it.each([
    ['done', 'Concluída'],
    ['failed', 'Falhou'],
    ['blocked', 'Encerrada com bloqueio'],
  ] as const)('keeps terminal status %s explicit', (status, label) => {
    const { host, root } = renderStatus(status);
    expect(host.textContent).toContain(label);
    expect(host.textContent).toContain(
      'Esta missão foi encerrada sem relatório final persistido.',
    );
    act(() => root.unmount());
  });
});
