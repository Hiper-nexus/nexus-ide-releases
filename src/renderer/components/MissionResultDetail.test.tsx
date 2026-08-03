/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Mission, MissionStatus } from '../../shared/orch-types';
import { formatRecoveryAttemptBlock } from '../../shared/mission-recovery-policy';
import { MissionResultDetail } from './MissionResultDetail';
import { askConfirm } from '../state/confirm-store';

vi.mock('../state/confirm-store', () => ({
  askConfirm: vi.fn(async () => true),
}));

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

  it('presents automatic technical recovery as recovering, not closed', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const recovering: Mission = {
      ...mission('blocked'),
      intentState: 'blocked_technical',
      intentVersion: 3,
      intentContract: {
        goal: 'Corrigir o projeto',
        intentVersion: 3,
        approvedAt: 100,
      } as Mission['intentContract'],
      description:
        'objetivo\n\n<!-- nexus:orchestrator-pre-dispatch-exit -->\n' +
        '## Maestro encerrou antes da delegação\nSessão saiu cedo.',
    };
    act(() =>
      root.render(
        <MissionResultDetail mission={recovering} onBack={() => {}} />,
      ),
    );
    expect(host.textContent).toContain('Recuperando');
    expect(host.textContent).not.toContain('Encerrada com bloqueio');
    expect(host.textContent).toContain('A missão está em andamento');
    expect(host.textContent).not.toContain(
      'Esta missão foi encerrada sem relatório final persistido.',
    );
    act(() => root.unmount());
  });
});

describe('MissionResultDetail recovery escape hatch', () => {
  function recoveringMission(attemptBlock: string): Mission {
    return {
      ...mission('blocked'),
      intentState: 'blocked_technical',
      intentVersion: 3,
      intentContract: {
        goal: 'Corrigir o projeto',
        intentVersion: 3,
        approvedAt: 100,
      } as Mission['intentContract'],
      description: `objetivo da missão\n\n${attemptBlock}`,
    };
  }

  function renderRecovering(description: string): {
    host: HTMLDivElement;
    root: Root;
  } {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() =>
      root.render(
        <MissionResultDetail
          mission={recoveringMission(description)}
          onBack={() => {}}
        />,
      ),
    );
    return { host, root };
  }

  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('shows the persisted attempt N/8 and its reason', () => {
    const { host, root } = renderRecovering(
      formatRecoveryAttemptBlock(
        5,
        8,
        'timeout no resume',
        new Date().toISOString(),
      ),
    );
    expect(host.textContent).toContain('Recuperando 5/8');
    expect(host.textContent).toContain(
      'Tentativa 5 de 8 · timeout no resume',
    );
    act(() => root.unmount());
  });

  it('hides the manual exits while the first fresh attempts run', () => {
    const { host, root } = renderRecovering(
      formatRecoveryAttemptBlock(
        1,
        8,
        'falha transitória',
        new Date().toISOString(),
      ),
    );
    expect(host.textContent).not.toContain('Forçar retomada');
    expect(host.textContent).not.toContain('Encerrar execução');
    act(() => root.unmount());
  });

  it('offers the manual exits once the recovery is proven stuck', () => {
    const { host, root } = renderRecovering(
      formatRecoveryAttemptBlock(
        3,
        8,
        'falha persistente',
        new Date().toISOString(),
      ),
    );
    expect(host.textContent).toContain('Forçar retomada');
    expect(host.textContent).toContain('Encerrar execução');
    act(() => root.unmount());
  });

  it('forces a resume through the existing bootstrap IPC', async () => {
    const resumeMissionBootstrap = vi.fn(async () => ({ ok: true as const }));
    Object.defineProperty(window, 'nexus', {
      value: { orch: { resumeMissionBootstrap } },
      configurable: true,
    });
    const { host, root } = renderRecovering(
      formatRecoveryAttemptBlock(
        4,
        8,
        'falha persistente',
        new Date().toISOString(),
      ),
    );
    const button = [...host.querySelectorAll('button')].find((el) =>
      el.textContent?.includes('Forçar retomada'),
    );
    expect(button).toBeTruthy();
    await act(async () => {
      button!.click();
    });
    expect(resumeMissionBootstrap).toHaveBeenCalledWith({
      missionId: 'mission-blocked',
    });
    expect(host.textContent).toContain('Retomada forçada');
    act(() => root.unmount());
  });

  it('closes the runtime only after confirmation', async () => {
    const closeMissionRuntime = vi.fn(async () => ({
      ok: true as const,
      terminatedSessionIds: [],
    }));
    Object.defineProperty(window, 'nexus', {
      value: { orch: { closeMissionRuntime } },
      configurable: true,
    });
    const { host, root } = renderRecovering(
      formatRecoveryAttemptBlock(
        4,
        8,
        'falha persistente',
        new Date().toISOString(),
      ),
    );
    const button = [...host.querySelectorAll('button')].find((el) =>
      el.textContent?.includes('Encerrar execução'),
    );
    expect(button).toBeTruthy();
    await act(async () => {
      button!.click();
    });
    expect(askConfirm).toHaveBeenCalled();
    expect(closeMissionRuntime).toHaveBeenCalledWith('mission-blocked');
    expect(host.textContent).toContain('Execução encerrada');
    act(() => root.unmount());
  });
});
